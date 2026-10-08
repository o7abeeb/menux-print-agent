package app.menux.print

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * The Menux site's print-agent endpoints (theme: include/menux-printers.php),
 * the same ones the desktop agent uses. The app is never a logged-in user:
 * every call carries the pairing token instead.
 */
object Api {
    private val FIREWALL_PAGE = Regex("checking your browser|captcha|challenge|attention required", RegexOption.IGNORE_CASE)

    private fun post(site: String, fields: Map<String, String>): JSONObject {
        val conn = URL(site.trimEnd('/') + "/wp-admin/admin-ajax.php").openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 15000
            conn.readTimeout = 30000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            conn.setRequestProperty("User-Agent", "MenuxPrintAndroid/" + BuildConfig.VERSION_NAME)
            // A host-level "Checking your browser…" JavaScript gate lets a request
            // through once this cookie is set -- a browser does that by itself.
            conn.setRequestProperty("Cookie", "hc_js_gate=1")
            val body = fields.entries.joinToString("&") {
                URLEncoder.encode(it.key, "UTF-8") + "=" + URLEncoder.encode(it.value, "UTF-8")
            }
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code < 400) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            val json = try { JSONObject(text) } catch (e: Exception) { null }
            if (json == null) {
                if (FIREWALL_PAGE.containsMatchIn(text)) throw Exception("blocked_by_site_firewall")
                throw Exception("bad_response_http_$code")
            }
            if (!json.optBoolean("success")) {
                val msg = json.optJSONObject("data")?.optString("message").orEmpty()
                throw Exception(msg.ifEmpty { "request_failed" })
            }
            return json
        } finally {
            conn.disconnect()
        }
    }

    /** Queued jobs for this agent's printers (the site marks them as sent). */
    fun pullJobs(site: String, token: String): List<JSONObject> {
        val data = post(site, mapOf("action" to "menux_printer_agent_pull_jobs", "token" to token)).optJSONObject("data")
        val arr = data?.optJSONArray("jobs") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
    }

    /** Reports a job printed (or failed, with a short reason the dashboard shows). */
    fun ack(site: String, token: String, jobId: Int, success: Boolean, error: String) {
        post(site, mapOf(
            "action" to "menux_printer_agent_ack",
            "token" to token,
            "job_id" to jobId.toString(),
            "success" to if (success) "1" else "0",
            "error" to error,
        ))
    }
}
