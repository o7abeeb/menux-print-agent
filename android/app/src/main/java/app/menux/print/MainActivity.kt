package app.menux.print

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.app.PendingIntent
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import java.text.DateFormat
import java.util.Date

/**
 * Setup screen: pairing token, the printer (USB / Bluetooth / network),
 * paper width, test print, save. Built in code (no layout XML) so every
 * view gets Menux's font, IBM Plex Sans Arabic, bundled in assets/fonts.
 */
class MainActivity : Activity() {
    private lateinit var store: Store
    private lateinit var fontRegular: Typeface
    private lateinit var fontSemi: Typeface
    private lateinit var fontBold: Typeface
    private val ui = Handler(Looper.getMainLooper())

    private lateinit var tokenInput: EditText
    private lateinit var siteInput: EditText
    private lateinit var siteWrap: LinearLayout
    private lateinit var rbUsb: RadioButton
    private lateinit var rbBt: RadioButton
    private lateinit var rbLan: RadioButton
    private lateinit var usbPanel: LinearLayout
    private lateinit var btPanel: LinearLayout
    private lateinit var lanPanel: LinearLayout
    private lateinit var usbLabel: TextView
    private lateinit var btLabel: TextView
    private lateinit var lanInput: EditText
    private lateinit var rb80: RadioButton
    private lateinit var rb58: RadioButton
    private lateinit var testBtn: Button
    private lateinit var testStatus: TextView
    private lateinit var saveStatus: TextView
    private lateinit var runStatus: TextView
    private lateinit var batteryBtn: Button
    private lateinit var batteryHint: TextView
    private lateinit var updateBanner: TextView

    // the printer picked on this screen (saved with "save" / "test print")
    private var selUsbVendor = 0
    private var selUsbProduct = 0
    private var selUsbName = ""
    private var selBtAddress = ""
    private var selBtName = ""

    private val usbReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != ACTION_USB_PERMISSION) return
            if (!intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)) {
                showLine(testStatus, getString(R.string.usb_denied), R.color.err)
            }
            refreshUsbLabel()
        }
    }

    private val statusTick = object : Runnable {
        override fun run() {
            refreshRunStatus()
            ui.postDelayed(this, 3000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        fontRegular = Typeface.createFromAsset(assets, "fonts/IBMPlexSansArabic-Regular.ttf")
        fontSemi = Typeface.createFromAsset(assets, "fonts/IBMPlexSansArabic-SemiBold.ttf")
        fontBold = Typeface.createFromAsset(assets, "fonts/IBMPlexSansArabic-Bold.ttf")
        setContentView(buildUi())
        loadFromStore()
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(usbReceiver, IntentFilter(ACTION_USB_PERMISSION), Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(usbReceiver, IntentFilter(ACTION_USB_PERMISSION))
        }
        handleUsbIntent(intent)
        checkForUpdate()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleUsbIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        refreshBattery()
        ui.post(statusTick)
    }

    override fun onPause() {
        ui.removeCallbacks(statusTick)
        super.onPause()
    }

    override fun onDestroy() {
        try { unregisterReceiver(usbReceiver) } catch (_: Throwable) {}
        super.onDestroy()
    }

    // ---------------------------------------------------------------- UI

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()
    private fun color(id: Int) = resources.getColor(id, theme)

    private fun text(s: String, sizeSp: Float, font: Typeface, colorId: Int = R.color.ink): TextView =
        TextView(this).apply {
            text = s
            textSize = sizeSp
            typeface = font
            setTextColor(color(colorId))
            setLineSpacing(0f, 1.25f)
        }

    private fun label(s: String) = text(s, 13f, fontSemi).apply { setPadding(0, dp(14), 0, dp(4)) }
    private fun hint(s: String) = text(s, 12f, fontRegular, R.color.muted).apply { setPadding(0, dp(4), 0, 0) }

    private fun box(fill: Int, stroke: Int, radius: Int = 8) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(radius).toFloat()
        setStroke(dp(1), stroke)
    }

    private fun input(hintText: String, ltr: Boolean): EditText = EditText(this).apply {
        hint = hintText
        textSize = 14f
        typeface = fontRegular
        setTextColor(color(R.color.ink))
        setHintTextColor(color(R.color.muted))
        background = box(Color.WHITE, color(R.color.line))
        setPadding(dp(12), dp(10), dp(12), dp(10))
        isSingleLine = true
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        if (ltr) {
            textDirection = View.TEXT_DIRECTION_LTR
            layoutDirection = View.LAYOUT_DIRECTION_LTR
        }
    }

    private fun button(s: String, solid: Boolean, onClick: () -> Unit): Button = Button(this).apply {
        text = s
        isAllCaps = false
        textSize = 14f
        typeface = fontBold
        setTextColor(if (solid) Color.WHITE else color(R.color.brand))
        background = box(if (solid) color(R.color.brand) else Color.WHITE, color(R.color.brand))
        stateListAnimator = null
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)).apply { topMargin = dp(10) }
    }

    private fun radio(s: String): RadioButton = RadioButton(this).apply {
        text = s
        textSize = 14f
        typeface = fontSemi
        setTextColor(color(R.color.ink))
        id = View.generateViewId()
        layoutParams = RadioGroup.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
    }

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutDirection = View.LAYOUT_DIRECTION_RTL
            textDirection = View.TEXT_DIRECTION_RTL
            setPadding(dp(20), dp(20), dp(20), dp(28))
        }

        root.addView(ImageView(this).apply {
            setImageResource(R.drawable.menux_logo)
            adjustViewBounds = true
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(36)).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                bottomMargin = dp(14)
            }
        })

        updateBanner = text("", 13f, fontSemi, R.color.brand).apply {
            visibility = View.GONE
            background = box(color(R.color.brand_soft), color(R.color.brand_soft))
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setOnClickListener { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(Updater.APK_URL))) }
        }
        root.addView(updateBanner)

        root.addView(text(getString(R.string.title), 17f, fontBold).apply { setPadding(0, dp(6), 0, 0) })
        root.addView(hint(getString(R.string.hint_pair)))

        root.addView(label(getString(R.string.token)))
        tokenInput = input("pairing token", true)
        root.addView(tokenInput)

        // printer
        root.addView(label(getString(R.string.printer)))
        rbUsb = radio(getString(R.string.t_usb))
        rbBt = radio(getString(R.string.t_bt))
        rbLan = radio(getString(R.string.t_lan))
        val group = RadioGroup(this).apply {
            orientation = RadioGroup.HORIZONTAL
            addView(rbUsb); addView(rbBt); addView(rbLan)
            setOnCheckedChangeListener { _, _ -> showPanel() }
        }
        root.addView(group)

        usbPanel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        usbLabel = text("", 13f, fontSemi, R.color.brand).apply { setPadding(0, dp(8), 0, 0) }
        usbPanel.addView(button(getString(R.string.choose_usb), false) { chooseUsb() })
        usbPanel.addView(usbLabel)
        usbPanel.addView(hint(getString(R.string.usb_hint)))
        root.addView(usbPanel)

        btPanel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        btLabel = text("", 13f, fontSemi, R.color.brand).apply { setPadding(0, dp(8), 0, 0) }
        btPanel.addView(button(getString(R.string.choose_bt), false) { chooseBluetooth() })
        btPanel.addView(btLabel)
        btPanel.addView(hint(getString(R.string.bt_hint)))
        root.addView(btPanel)

        lanPanel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        lanPanel.addView(label(getString(R.string.lan_ip)))
        lanInput = input("192.168.1.50:9100", true)
        lanPanel.addView(lanInput)
        root.addView(lanPanel)

        // paper
        root.addView(label(getString(R.string.paper)))
        rb80 = radio(getString(R.string.paper80))
        rb58 = radio(getString(R.string.paper58))
        root.addView(RadioGroup(this).apply {
            orientation = RadioGroup.HORIZONTAL
            addView(rb80); addView(rb58)
        })

        testBtn = button(getString(R.string.test_print), false) { testPrint() }
        root.addView(testBtn)
        testStatus = hint("")
        root.addView(testStatus)

        root.addView(button(getString(R.string.save), true) { save() })
        saveStatus = hint("")
        root.addView(saveStatus)

        runStatus = text("", 13f, fontSemi, R.color.muted).apply {
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = box(Color.WHITE, color(R.color.line))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) }
        }
        root.addView(runStatus)

        batteryBtn = button(getString(R.string.battery), false) { askBatteryExemption() }
        root.addView(batteryBtn)
        batteryHint = hint(getString(R.string.battery_hint))
        root.addView(batteryHint)

        // advanced: the site (staging / testing)
        root.addView(text(getString(R.string.advanced), 12f, fontSemi, R.color.muted).apply {
            setPadding(0, dp(18), 0, 0)
            setOnClickListener { siteWrap.visibility = if (siteWrap.visibility == View.VISIBLE) View.GONE else View.VISIBLE }
        })
        siteWrap = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        siteWrap.addView(label(getString(R.string.site_url)))
        siteInput = input(Store.DEFAULT_SITE, true)
        siteWrap.addView(siteInput)
        root.addView(siteWrap)

        return ScrollView(this).apply {
            isFillViewport = true
            setBackgroundColor(color(R.color.ground))
            addView(root)
        }
    }

    private fun showLine(v: TextView, s: String, colorId: Int) {
        v.text = s
        v.setTextColor(color(colorId))
    }

    // ---------------------------------------------------------------- state

    private fun loadFromStore() {
        tokenInput.setText(store.token)
        siteInput.setText(if (store.siteUrl == Store.DEFAULT_SITE) "" else store.siteUrl)
        if (store.siteUrl != Store.DEFAULT_SITE) siteWrap.visibility = View.VISIBLE
        selUsbVendor = store.usbVendor
        selUsbProduct = store.usbProduct
        selUsbName = store.usbName
        selBtAddress = store.btAddress
        selBtName = store.btName
        lanInput.setText(store.lanHost)
        when (store.transport) {
            "bt" -> rbBt.isChecked = true
            "lan" -> rbLan.isChecked = true
            else -> rbUsb.isChecked = true
        }
        if (store.paperDots == 384) rb58.isChecked = true else rb80.isChecked = true
        refreshUsbLabel()
        refreshBtLabel()
        showPanel()
    }

    private fun currentTransport() = when {
        rbBt.isChecked -> "bt"
        rbLan.isChecked -> "lan"
        else -> "usb"
    }

    private fun showPanel() {
        val t = currentTransport()
        usbPanel.visibility = if (t == "usb") View.VISIBLE else View.GONE
        btPanel.visibility = if (t == "bt") View.VISIBLE else View.GONE
        lanPanel.visibility = if (t == "lan") View.VISIBLE else View.GONE
    }

    private fun hasPrinter(t: String) = when (t) {
        "usb" -> selUsbVendor != 0
        "bt" -> selBtAddress.isNotEmpty()
        else -> Printer.parseNet(lanInput.text.toString()) != null
    }

    private fun printerLabel(t: String) = when (t) {
        "usb" -> selUsbName
        "bt" -> selBtName
        else -> lanInput.text.toString().trim()
    }

    /** Writes the screen into the settings the service reads. */
    private fun applyToStore() {
        store.token = tokenInput.text.toString()
        store.siteUrl = siteInput.text.toString()
        store.transport = currentTransport()
        store.usbVendor = selUsbVendor
        store.usbProduct = selUsbProduct
        store.usbName = selUsbName
        store.btAddress = selBtAddress
        store.btName = selBtName
        store.lanHost = lanInput.text.toString()
        store.paperDots = if (rb58.isChecked) 384 else 576
    }

    private fun refreshUsbLabel() {
        usbLabel.text = if (selUsbVendor == 0) getString(R.string.none_selected) else selUsbName
    }

    private fun refreshBtLabel() {
        btLabel.text = if (selBtAddress.isEmpty()) getString(R.string.none_selected) else selBtName
    }

    private fun refreshRunStatus() {
        val s = Store(this)
        runStatus.text = when {
            !s.enabled -> getString(R.string.status_off)
            s.lastError.isNotEmpty() -> getString(R.string.status_error, s.lastError)
            s.lastPrintedAt > 0 -> getString(R.string.status_last, DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(s.lastPrintedAt)))
            else -> getString(R.string.status_running)
        }
        runStatus.setTextColor(color(if (s.enabled && s.lastError.isEmpty()) R.color.ok else if (s.enabled) R.color.err else R.color.muted))
    }

    private fun refreshBattery() {
        val pm = getSystemService(PowerManager::class.java)
        val exempt = pm?.isIgnoringBatteryOptimizations(packageName) == true
        batteryBtn.visibility = if (exempt) View.GONE else View.VISIBLE
        batteryHint.visibility = batteryBtn.visibility
    }

    // ---------------------------------------------------------------- actions

    private fun save() {
        if (tokenInput.text.toString().isBlank()) { showLine(saveStatus, getString(R.string.need_token), R.color.err); return }
        if (!hasPrinter(currentTransport())) { showLine(saveStatus, getString(R.string.need_printer), R.color.err); return }
        applyToStore()
        store.enabled = true
        store.lastError = ""
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
        }
        PrintService.start(this)
        showLine(saveStatus, getString(R.string.saved), R.color.ok)
        refreshRunStatus()
    }

    private fun testPrint() {
        val t = currentTransport()
        if (!hasPrinter(t)) { showLine(testStatus, getString(R.string.need_printer), R.color.err); return }
        applyToStore()
        testBtn.isEnabled = false
        showLine(testStatus, getString(R.string.printing), R.color.muted)
        val label = printerLabel(t)
        Thread {
            val error = try {
                Printer.print(this, store, Receipt.testHtml(this, label), null)
                null
            } catch (e: Exception) {
                e.message ?: "error"
            }
            ui.post {
                testBtn.isEnabled = true
                if (error == null) showLine(testStatus, getString(R.string.test_ok), R.color.ok)
                else showLine(testStatus, getString(R.string.failed, error), R.color.err)
            }
        }.start()
    }

    private fun chooseUsb() {
        val um = getSystemService(UsbManager::class.java)
        val devices = um?.deviceList?.values?.filter { Transports.bulkOut(it) != null }.orEmpty()
        if (devices.isEmpty()) { showLine(testStatus, getString(R.string.no_usb), R.color.err); return }
        val names = devices.map { usbName(it) }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle(R.string.choose_usb)
            .setItems(names) { _, i -> pickUsb(devices[i]) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun usbName(d: UsbDevice): String {
        val name = d.productName?.trim().orEmpty().ifEmpty { "USB" }
        return name + " (" + String.format("%04x:%04x", d.vendorId, d.productId) + ")"
    }

    private fun pickUsb(d: UsbDevice) {
        selUsbVendor = d.vendorId
        selUsbProduct = d.productId
        selUsbName = usbName(d)
        refreshUsbLabel()
        val um = getSystemService(UsbManager::class.java) ?: return
        if (!um.hasPermission(d)) {
            val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
            um.requestPermission(d, PendingIntent.getBroadcast(this, 0, Intent(ACTION_USB_PERMISSION).setPackage(packageName), flags))
        }
    }

    /** Opened by Android because a USB printer was plugged in: pick it. */
    private fun handleUsbIntent(i: Intent?) {
        if (i?.action != UsbManager.ACTION_USB_DEVICE_ATTACHED) return
        val d: UsbDevice? = if (Build.VERSION.SDK_INT >= 33) {
            i.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        } else {
            @Suppress("DEPRECATION")
            i.getParcelableExtra(UsbManager.EXTRA_DEVICE)
        }
        if (d != null && Transports.bulkOut(d) != null) {
            rbUsb.isChecked = true
            pickUsb(d)
        }
    }

    private fun chooseBluetooth() {
        if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT), REQ_BLUETOOTH)
            return
        }
        showBluetoothList()
    }

    @SuppressLint("MissingPermission") // granted just above (Android 12+), install-time before
    private fun showBluetoothList() {
        val adapter = getSystemService(BluetoothManager::class.java)?.adapter
        val devices = try { adapter?.bondedDevices?.toList().orEmpty() } catch (e: SecurityException) { emptyList() }
        if (devices.isEmpty()) { showLine(testStatus, getString(R.string.no_bt), R.color.err); return }
        val names = devices.map { (it.name ?: "").ifEmpty { it.address } }
        AlertDialog.Builder(this)
            .setTitle(R.string.choose_bt)
            .setItems(names.toTypedArray()) { _, i ->
                selBtAddress = devices[i].address
                selBtName = names[i]
                refreshBtLabel()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_BLUETOOTH && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) showBluetoothList()
    }

    @SuppressLint("BatteryLife") // a print station must not be put to sleep
    private fun askBatteryExemption() {
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (e: Exception) {
            try { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } catch (_: Exception) {}
        }
    }

    private fun checkForUpdate() {
        Thread {
            val latest = Updater.latestVersion() ?: return@Thread
            if (Updater.isNewer(latest, BuildConfig.VERSION_NAME)) {
                ui.post {
                    updateBanner.text = getString(R.string.update_available, latest)
                    updateBanner.visibility = View.VISIBLE
                }
            }
        }.start()
    }

    companion object {
        private const val ACTION_USB_PERMISSION = "app.menux.print.USB_PERMISSION"
        private const val REQ_BLUETOOTH = 11
        private const val REQ_NOTIFICATIONS = 12
    }
}
