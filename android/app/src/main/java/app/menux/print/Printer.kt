package app.menux.print

import android.content.Context

/**
 * One receipt -> the right printer. A printer IP set in the Menux dashboard
 * wins (a network printer); otherwise the printer chosen in this app.
 */
object Printer {
    // "IP[:port]" or "name.local[:port]" -- same rule as the desktop agent
    private val NET = Regex("""^((?:\d{1,3}\.){3}\d{1,3}|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.local)(?::(\d{1,5}))?${'$'}""", RegexOption.IGNORE_CASE)

    fun parseNet(target: String?): Pair<String, Int>? {
        val m = NET.matchEntire(target.orEmpty().trim()) ?: return null
        return m.groupValues[1] to (m.groupValues[2].toIntOrNull() ?: 9100)
    }

    fun print(ctx: Context, store: Store, receiptHtml: String, menuxTarget: String?) {
        val data = Receipt.escpos(Receipt.render(ctx, receiptHtml, store.paperDots))
        val net = parseNet(menuxTarget)
        when {
            net != null -> Transports.lan(net.first, net.second, data)
            store.transport == "usb" -> Transports.usb(ctx, store.usbVendor, store.usbProduct, data)
            store.transport == "bt" -> Transports.bluetooth(ctx, store.btAddress, data)
            store.transport == "lan" -> {
                val n = parseNet(store.lanHost) ?: throw Exception("bad_printer_ip")
                Transports.lan(n.first, n.second, data)
            }
            else -> throw Exception("no_printer_selected")
        }
    }
}
