package app.menux.print

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * A sideloaded app can't update itself silently: the app checks GitHub's
 * latest release and, when it's newer, shows a banner that opens the APK
 * download (the stable "latest" link).
 */
object Updater {
    const val APK_URL = "https://github.com/o7abeeb/menux-print-agent/releases/latest/download/Menux-Print.apk"
    private const val API = "https://api.github.com/repos/o7abeeb/menux-print-agent/releases/latest"

    /** The latest published version ("0.3.0"), or null when unknown/offline. */
    fun latestVersion(): String? = try {
        val c = URL(API).openConnection() as HttpURLConnection
        c.connectTimeout = 10000
        c.readTimeout = 10000
        c.setRequestProperty("Accept", "application/vnd.github+json")
        c.setRequestProperty("User-Agent", "MenuxPrintAndroid/" + BuildConfig.VERSION_NAME)
        val text = c.inputStream.bufferedReader().use { it.readText() }
        c.disconnect()
        JSONObject(text).optString("tag_name").removePrefix("v").ifEmpty { null }
    } catch (e: Exception) {
        null
    }

    fun isNewer(latest: String, current: String): Boolean {
        val a = latest.split('.', '-').map { it.toIntOrNull() ?: 0 }
        val b = current.split('.', '-').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }
            val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }
}
