package app.menux.print

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.util.UUID
import kotlin.math.min

/** Sends ready ESC/POS bytes to a printer over the network, Bluetooth or USB. */
object Transports {
    /** Serial Port Profile -- what Bluetooth receipt printers speak. */
    private val SPP: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

    /** Raw TCP, port 9100 on virtually every network receipt printer. */
    fun lan(host: String, port: Int, data: ByteArray) {
        Socket().use { s ->
            s.connect(InetSocketAddress(host, port), 8000)
            s.soTimeout = 15000
            val out = s.getOutputStream()
            out.write(data)
            out.flush()
            Thread.sleep(400) // some printers drop the tail if the socket closes at once
        }
    }

    @SuppressLint("MissingPermission") // checked by the caller (Android 12+ BLUETOOTH_CONNECT)
    fun bluetooth(ctx: Context, address: String, data: ByteArray) {
        if (address.isBlank()) throw Exception("no_bluetooth_printer")
        val adapter = ctx.getSystemService(BluetoothManager::class.java)?.adapter ?: throw Exception("bluetooth_unavailable")
        if (!adapter.isEnabled) throw Exception("bluetooth_off")
        val device = adapter.getRemoteDevice(address)
        try { adapter.cancelDiscovery() } catch (_: Throwable) {}
        var socket: BluetoothSocket = device.createRfcommSocketToServiceRecord(SPP)
        try {
            socket.connect()
        } catch (e: IOException) {
            try { socket.close() } catch (_: Throwable) {}
            socket = device.createInsecureRfcommSocketToServiceRecord(SPP) // older printers
            socket.connect()
        }
        try {
            val out = socket.outputStream
            var i = 0
            while (i < data.size) {
                val n = min(1024, data.size - i)
                out.write(data, i, n)
                out.flush()
                i += n
                Thread.sleep(15) // small printer buffers
            }
            Thread.sleep(800)
        } finally {
            try { socket.close() } catch (_: Throwable) {}
        }
    }

    fun usb(ctx: Context, vendor: Int, product: Int, data: ByteArray) {
        val um = ctx.getSystemService(UsbManager::class.java) ?: throw Exception("usb_unavailable")
        val device = um.deviceList.values.firstOrNull { it.vendorId == vendor && it.productId == product }
            ?: throw Exception("usb_printer_not_connected")
        if (!um.hasPermission(device)) throw Exception("usb_permission_needed")
        val (iface, endpoint) = bulkOut(device) ?: throw Exception("usb_no_output")
        val conn = um.openDevice(device) ?: throw Exception("usb_open_failed")
        try {
            if (!conn.claimInterface(iface, true)) throw Exception("usb_claim_failed")
            var i = 0
            while (i < data.size) {
                val n = min(16384, data.size - i)
                val sent = conn.bulkTransfer(endpoint, data, i, n, 5000)
                if (sent <= 0) throw Exception("usb_write_failed")
                i += sent
            }
            conn.releaseInterface(iface)
        } finally {
            conn.close()
        }
    }

    /** The printer's bulk OUT endpoint -- printer-class interfaces first. */
    fun bulkOut(device: UsbDevice): Pair<UsbInterface, UsbEndpoint>? {
        val ifaces = (0 until device.interfaceCount).map { device.getInterface(it) }
            .sortedBy { if (it.interfaceClass == UsbConstants.USB_CLASS_PRINTER) 0 else 1 }
        for (iface in ifaces) {
            for (e in 0 until iface.endpointCount) {
                val ep = iface.getEndpoint(e)
                if (ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK && ep.direction == UsbConstants.USB_DIR_OUT) {
                    return iface to ep
                }
            }
        }
        return null
    }
}
