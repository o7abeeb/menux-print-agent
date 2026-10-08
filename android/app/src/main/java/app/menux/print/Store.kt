package app.menux.print

import android.content.Context

/** The app's settings (SharedPreferences): pairing, chosen printer, status. */
class Store(ctx: Context) {
    private val p = ctx.applicationContext.getSharedPreferences("menux_print", Context.MODE_PRIVATE)

    private fun str(k: String, d: String = "") = p.getString(k, d) ?: d
    private fun put(k: String, v: String) = p.edit().putString(k, v).apply()

    var siteUrl: String
        get() = str("siteUrl", DEFAULT_SITE)
        set(v) = put("siteUrl", v.ifBlank { DEFAULT_SITE }.trim().trimEnd('/'))
    var token: String
        get() = str("token")
        set(v) = put("token", v.trim())

    /** "usb" | "bt" | "lan" | "" -- where receipts go when Menux gives no printer IP. */
    var transport: String
        get() = str("transport")
        set(v) = put("transport", v)
    var usbVendor: Int
        get() = p.getInt("usbVendor", 0)
        set(v) = p.edit().putInt("usbVendor", v).apply()
    var usbProduct: Int
        get() = p.getInt("usbProduct", 0)
        set(v) = p.edit().putInt("usbProduct", v).apply()
    var usbName: String
        get() = str("usbName")
        set(v) = put("usbName", v)
    var btAddress: String
        get() = str("btAddress")
        set(v) = put("btAddress", v)
    var btName: String
        get() = str("btName")
        set(v) = put("btName", v)
    var lanHost: String
        get() = str("lanHost")
        set(v) = put("lanHost", v.trim())

    /** Printable width in dots: 576 = 80mm roll, 384 = 58mm roll (203dpi). */
    var paperDots: Int
        get() = p.getInt("paperDots", 576)
        set(v) = p.edit().putInt("paperDots", v).apply()

    /** The service should run (set by "save", survives reboots via BootReceiver). */
    var enabled: Boolean
        get() = p.getBoolean("enabled", false)
        set(v) = p.edit().putBoolean("enabled", v).apply()

    var lastPrintedAt: Long
        get() = p.getLong("lastPrintedAt", 0L)
        set(v) = p.edit().putLong("lastPrintedAt", v).apply()
    var lastError: String
        get() = str("lastError")
        set(v) = put("lastError", v)

    companion object {
        const val DEFAULT_SITE = "https://menux.app"
    }
}
