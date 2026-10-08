package app.menux.print

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import java.text.DateFormat
import java.util.Date

/**
 * Runs while printing is on: every few seconds asks Menux for queued jobs,
 * prints each one and reports back. A foreground service (with its
 * notification) so Android keeps it alive with the screen off; a partial
 * wake lock so the CPU doesn't sleep between checks -- a cashier tablet is
 * normally on its charger.
 */
class PrintService : Service() {
    @Volatile private var running = false
    private var worker: Thread? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val store = Store(this)
        startInForeground(statusText(store))
        if (wakeLock == null) {
            wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "menux:print").apply {
                    setReferenceCounted(false)
                    acquire()
                }
        }
        if (worker?.isAlive != true) {
            running = true
            worker = Thread({ loop() }, "menux-print").apply { start() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        worker?.interrupt()
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    private fun loop() {
        val store = Store(this)
        while (running) {
            try {
                cycle(store)
            } catch (e: InterruptedException) {
                break
            } catch (t: Throwable) {
                store.lastError = t.message ?: "error"
                updateNotification(store)
            }
            try {
                Thread.sleep(POLL_MS)
            } catch (e: InterruptedException) {
                break
            }
        }
    }

    private fun cycle(store: Store) {
        if (store.token.isEmpty()) return
        val jobs = try {
            Api.pullJobs(store.siteUrl, store.token)
        } catch (e: Exception) {
            val msg = "pull_failed: " + (e.message ?: "")
            if (store.lastError != msg) {
                store.lastError = msg
                updateNotification(store)
            }
            return
        }
        if (store.lastError.startsWith("pull_failed")) {
            store.lastError = ""
            updateNotification(store)
        }
        for (job in jobs) {
            val id = job.optInt("id")
            try {
                val html = job.optString("receipt_html", "")
                if (html.isEmpty()) throw Exception("menux_site_needs_update") // a site older than the receipt renderer
                Printer.print(this, store, html, job.optString("printer_target", ""))
                Api.ack(store.siteUrl, store.token, id, true, "")
                store.lastPrintedAt = System.currentTimeMillis()
                store.lastError = ""
            } catch (e: Exception) {
                val reason = (e.message ?: "print_failed").take(180)
                try {
                    Api.ack(store.siteUrl, store.token, id, false, reason)
                } catch (_: Exception) {
                }
                store.lastError = reason
            }
            updateNotification(store)
        }
    }

    private fun statusText(store: Store): String = when {
        store.lastError.isNotEmpty() -> getString(R.string.status_error, store.lastError)
        store.lastPrintedAt > 0 -> getString(
            R.string.status_last,
            DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(store.lastPrintedAt)),
        )
        else -> getString(R.string.status_running)
    }

    private fun notification(text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW),
            )
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder.setSmallIcon(R.drawable.ic_stat_print)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    private fun startInForeground(text: String) {
        val n = notification(text)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    private fun updateNotification(store: Store) {
        try {
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(statusText(store)))
        } catch (_: Throwable) {
        }
    }

    companion object {
        private const val CHANNEL = "menux_print"
        private const val NOTIFICATION_ID = 7
        private const val POLL_MS = 5000L

        fun start(ctx: Context) {
            val i = Intent(ctx, PrintService::class.java)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, PrintService::class.java))
        }
    }
}
