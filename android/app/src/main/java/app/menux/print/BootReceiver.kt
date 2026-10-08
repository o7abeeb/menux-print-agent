package app.menux.print

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Back to printing after a reboot or an app update, if printing was on. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val store = Store(context)
        if (store.enabled && store.token.isNotEmpty()) {
            try {
                PrintService.start(context)
            } catch (_: Throwable) {
            }
        }
    }
}
