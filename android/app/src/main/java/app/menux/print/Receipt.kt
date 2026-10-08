package app.menux.print

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayOutputStream
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * Turns the receipt Menux sends (job.receipt_html -- the same receipt the
 * dashboard prints) into ESC/POS printer bytes: rendered off-screen in a
 * WebView at the printer's real width, then sent as a 1-bit raster image.
 * Printing an image is what makes Arabic come out right on every receipt
 * printer (their built-in text mode can't join Arabic letters).
 */
object Receipt {
    private const val PAPER_MM = 72.0          // the receipt is laid out for a 72mm printable width
    private const val CSS_PX_PER_MM = 96.0 / 25.4
    private const val MAX_HEIGHT = 12000       // px; a very long order still fits
    private val main = Handler(Looper.getMainLooper())

    /** Fonts, stylesheets and images in? (the page triggers its own font loads first) */
    private const val READY_JS = """(function(){try{
        if(!window.__mnxFontKick&&document.fonts){window.__mnxFontKick=1;
          ['400','500','600','700'].forEach(function(w){document.fonts.load(w+' 12px "IBM Plex Sans Arabic"','ابج 123');});}
        var links=[].slice.call(document.querySelectorAll('link[rel=stylesheet]')).every(function(l){return !!l.sheet;});
        var imgs=[].slice.call(document.images).every(function(i){return i.complete;});
        var fonts=!document.fonts||document.fonts.status==='loaded';
        return links&&imgs&&fonts;}catch(e){return true;}})()"""

    private fun document(receiptHtml: String, zoom: Double): String =
        "<!doctype html><html><head><meta charset=\"utf-8\">" +
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
        "<style>html{zoom:$zoom}@page{margin:0}html,body{margin:0;padding:0;background:#fff}" +
        "body{width:72mm}.receipt{margin:0 auto!important}" +
        "*{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style>" +
        "</head><body>$receiptHtml</body></html>"

    /**
     * Renders on the main thread; the CALLER must be a background thread
     * (it blocks until the image is ready, 25s at most).
     */
    fun render(ctx: Context, receiptHtml: String, widthPx: Int): Bitmap {
        val latch = CountDownLatch(1)
        val done = AtomicBoolean(false)
        var result: Bitmap? = null
        var failure: Exception? = null

        main.post {
            var webView: WebView? = null
            fun finish(bmp: Bitmap?, err: Exception?) {
                if (!done.compareAndSet(false, true)) return
                result = bmp
                failure = err
                try { webView?.destroy() } catch (_: Throwable) {}
                latch.countDown()
            }
            try {
                val density = ctx.resources.displayMetrics.density
                val zoom = (widthPx / density) / (PAPER_MM * CSS_PX_PER_MM)
                val wv = WebView(ctx.applicationContext)
                webView = wv
                wv.setLayerType(View.LAYER_TYPE_SOFTWARE, null)
                wv.setBackgroundColor(Color.WHITE)
                wv.isVerticalScrollBarEnabled = false
                wv.isHorizontalScrollBarEnabled = false
                wv.settings.javaScriptEnabled = true
                wv.settings.loadsImagesAutomatically = true
                wv.settings.useWideViewPort = false
                wv.settings.loadWithOverviewMode = false
                layout(wv, widthPx, 2000)

                val deadline = SystemClock.uptimeMillis() + 12000
                wv.webViewClient = object : WebViewClient() {
                    private var started = false
                    override fun onPageFinished(view: WebView, url: String?) {
                        if (started) return
                        started = true
                        poll(view)
                    }

                    private fun poll(view: WebView) {
                        view.evaluateJavascript(READY_JS) { ready ->
                            if (done.get()) return@evaluateJavascript
                            if (ready != "true" && SystemClock.uptimeMillis() < deadline) {
                                main.postDelayed({ poll(view) }, 250)
                                return@evaluateJavascript
                            }
                            // Full content height, then draw (a short pause lets it paint).
                            main.postDelayed({
                                try {
                                    val h = min(MAX_HEIGHT, max(200, ceil(view.contentHeight * density).toInt() + 60))
                                    layout(view, widthPx, h)
                                    main.postDelayed({
                                        try {
                                            val bmp = Bitmap.createBitmap(widthPx, h, Bitmap.Config.ARGB_8888)
                                            val canvas = Canvas(bmp)
                                            canvas.drawColor(Color.WHITE)
                                            view.draw(canvas)
                                            finish(trimBottom(bmp), null)
                                        } catch (t: Throwable) {
                                            finish(null, Exception("render_failed: " + t.message))
                                        }
                                    }, 350)
                                } catch (t: Throwable) {
                                    finish(null, Exception("render_failed: " + t.message))
                                }
                            }, 100)
                        }
                    }
                }
                wv.loadDataWithBaseURL("https://menux.app/", document(receiptHtml, zoom), "text/html", "utf-8", null)
                main.postDelayed({ finish(null, Exception("render_timeout")) }, 20000)
            } catch (t: Throwable) {
                finish(null, Exception("render_failed: " + t.message))
            }
        }

        if (!latch.await(25, TimeUnit.SECONDS)) throw Exception("render_timeout")
        failure?.let { throw it }
        return result ?: throw Exception("render_failed")
    }

    private fun layout(v: View, w: Int, h: Int) {
        v.measure(
            View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY),
        )
        v.layout(0, 0, w, h)
    }

    /** Drops the white space below the last printed row (keeps a small margin). */
    private fun trimBottom(bmp: Bitmap): Bitmap {
        val w = bmp.width
        val row = IntArray(w)
        var last = -1
        for (y in bmp.height - 1 downTo 0) {
            bmp.getPixels(row, 0, w, 0, y, w, 1)
            if (row.any { isDark(it) }) { last = y; break }
        }
        val h = min(bmp.height, max(1, last + 12))
        return if (h == bmp.height) bmp else Bitmap.createBitmap(bmp, 0, 0, w, h)
    }

    private fun isDark(p: Int): Boolean {
        val a = (p ushr 24) and 0xff
        val r = (p shr 16) and 0xff
        val g = (p shr 8) and 0xff
        val b = p and 0xff
        val lum = (0.299 * r + 0.587 * g + 0.114 * b) * (a / 255.0) + 255.0 * (1 - a / 255.0)
        return lum < 150
    }

    /** ESC/POS job for an image: initialize, raster (GS v 0, 255 rows per block), feed, cut. */
    fun escpos(bmp: Bitmap): ByteArray {
        val w = bmp.width
        val h = bmp.height
        val bytesPerRow = (w + 7) / 8
        val out = ByteArrayOutputStream()
        out.write(byteArrayOf(0x1b, 0x40))
        val row = IntArray(w)
        var y0 = 0
        while (y0 < h) {
            val rows = min(255, h - y0)
            out.write(byteArrayOf(
                0x1d, 0x76, 0x30, 0x00,
                (bytesPerRow and 0xff).toByte(), ((bytesPerRow shr 8) and 0xff).toByte(),
                (rows and 0xff).toByte(), ((rows shr 8) and 0xff).toByte(),
            ))
            val block = ByteArray(bytesPerRow * rows)
            for (y in 0 until rows) {
                bmp.getPixels(row, 0, w, 0, y0 + y, w, 1)
                for (x in 0 until w) {
                    if (isDark(row[x])) {
                        val i = y * bytesPerRow + (x shr 3)
                        block[i] = (block[i].toInt() or (0x80 ushr (x and 7))).toByte()
                    }
                }
            }
            out.write(block)
            y0 += rows
        }
        out.write(byteArrayOf(0x1b, 0x64, 0x04))       // ESC d 4: feed past the last row
        out.write(byteArrayOf(0x1d, 0x56, 0x42, 0x00)) // GS V B 0: feed to the cutter and cut
        return out.toByteArray()
    }

    /** The "test print" page, in the receipt's own look. */
    fun testHtml(ctx: Context, printerLabel: String): String {
        fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
        val now = DateFormat.getDateTimeInstance().format(Date())
        return "<div class=\"receipt\" dir=\"rtl\" style=\"width:70mm;margin:0 auto;padding:4mm 0;text-align:center;color:#000;" +
            "font-family:'IBM Plex Sans Arabic',sans-serif;font-size:11px;line-height:1.5\">" +
            "<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;700&amp;display=block\">" +
            "<div style=\"font-size:18px;font-weight:700\">Menux</div>" +
            "<div style=\"font-size:14px;font-weight:700;margin-top:2mm\">" + esc(ctx.getString(R.string.test_title)) + "</div>" +
            "<div style=\"margin-top:1mm\">" + esc(printerLabel) + "</div>" +
            "<div style=\"margin-top:3mm;border-top:1.5px dashed #000;padding-top:3mm\">" + esc(ctx.getString(R.string.test_body)) + "</div>" +
            "<div style=\"margin-top:2mm;direction:ltr\">" + esc(now) + "</div></div>"
    }
}
