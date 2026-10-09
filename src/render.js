/**
 * Prints Menux's own receipt (the HTML the site sends with each job,
 * job.receipt_html -- the same receipt the dashboard prints) instead of the
 * old plain-text receipt. Two ways out, both silent:
 *
 *  - printHtmlToPrinter(): any printer installed in the OS (USB thermal
 *    printers like Xprinter/POS-80, or anything else Windows/macOS can
 *    print to). Electron renders the page and hands it to the printer's
 *    own driver -- real Arabic shaping, the restaurant's logo, QR code, and
 *    the driver's own paper/cut settings.
 *
 *  - printHtmlToNetwork(): a network printer reached directly on IP:9100
 *    (no driver involved). The page is rendered off-screen at the
 *    printer's real resolution (72mm = 576 dots at 203dpi), turned into a
 *    1-bit raster image and sent as ESC/POS "GS v 0" bitmap commands, then
 *    fed and cut. Text sent as text can't do Arabic properly on these
 *    printers (no letter joining); an image always can.
 */
const { BrowserWindow } = require('electron');
const { printToNetwork } = require('./printer');
const { sendRaw, useRaw } = require('./rawprint');

const PRINT_DOTS = 576;          // 72mm printable width at 203dpi (80mm roll)
const CSS_PX_PER_MM = 96 / 25.4; // CSS pixel = 1/96 inch
const PAPER_CSS_PX = 72 * CSS_PX_PER_MM;

/** Wraps the receipt element in a page: white, no margins, 72mm wide. */
function documentFor(receiptHtml) {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<style>@page{margin:0}html,body{margin:0;padding:0;background:#fff}'
    + 'body{width:72mm}.receipt{margin:0 auto!important}'
    + '*{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style>'
    + '</head><body>' + receiptHtml + '</body></html>';
}

/** Resolves when the page's fonts, stylesheets and images are in (or after the time limits). */
const WAIT_READY = `(async () => {
  const wait = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
  const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
  await wait(Promise.all(links.map((l) => l.sheet ? 1 : new Promise((r) => { l.onload = l.onerror = r; }))), 5000);
  if (document.fonts) {
    const faces = ['400 12px "IBM Plex Sans Arabic"', '500 12px "IBM Plex Sans Arabic"', '600 12px "IBM Plex Sans Arabic"', '700 12px "IBM Plex Sans Arabic"'];
    await wait(Promise.all(faces.map((f) => document.fonts.load(f, 'ابج 123').catch(() => {}))), 5000);
    await wait(document.fonts.ready, 2000);
  }
  await wait(Promise.all(Array.from(document.images).map((i) => i.complete ? 1 : new Promise((r) => { i.onload = i.onerror = r; }))), 5000);
  return Math.ceil(document.documentElement.scrollHeight);
})()`;

async function openReceiptWindow(receiptHtml, offscreen) {
  const win = new BrowserWindow({
    show: false,
    width: offscreen ? PRINT_DOTS : Math.ceil(PAPER_CSS_PX) + 2,
    height: 1200,
    useContentSize: true,
    webPreferences: { offscreen: !!offscreen, sandbox: true, contextIsolation: true, javascript: true },
  });
  const url = 'data:text/html;charset=utf-8;base64,' + Buffer.from(documentFor(receiptHtml), 'utf8').toString('base64');
  await win.loadURL(url);
  return win;
}

/** Installed printers, e.g. for the setup window's picker. */
async function listPrinters(webContents) {
  try {
    const list = await webContents.getPrintersAsync();
    return list.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
  } catch (e) {
    return [];
  }
}

/**
 * Silent print to an OS printer. deviceName '' = the system default
 * printer. Rejects with a readable reason (sent back to Menux as the job's
 * error) when the printer doesn't exist or the driver refuses the job.
 */
async function printHtmlToPrinter(receiptHtml, deviceName) {
  const win = await openReceiptWindow(receiptHtml, false);
  try {
    await win.webContents.executeJavaScript(WAIT_READY, true);
    if (deviceName) {
      const printers = await listPrinters(win.webContents);
      if (printers.length && !printers.some((p) => p.name === deviceName)) {
        throw new Error('printer_not_found: ' + deviceName);
      }
    }
    await new Promise((resolve, reject) => {
      win.webContents.print({
        silent: true,
        printBackground: true, // the black order-number / total bars
        deviceName: deviceName || '',
        margins: { marginType: 'none' },
      }, (ok, reason) => (ok ? resolve() : reject(new Error('print_failed: ' + (reason || 'unknown')))));
    });
  } finally {
    // Give the spooler a moment to take the job before the page goes away.
    setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 1500);
  }
}

/**
 * NativeImage (BGRA) -> ESC/POS raster bytes (GS v 0), PRINT_DOTS wide, 1 bit
 * per dot. Blank rows above the first ink and below the last are dropped:
 * the page's own white margins made auto-printed receipts longer than the
 * same receipt printed by hand through the driver (which trims them).
 */
function rasterFromImage(image) {
  let img = image;
  if (img.getSize().width !== PRINT_DOTS) img = img.resize({ width: PRINT_DOTS, quality: 'best' });
  const { width, height } = img.getSize();
  const bmp = img.toBitmap(); // BGRA, row-major
  const bytesPerRow = Math.ceil(width / 8);
  const dots = Buffer.alloc(bytesPerRow * height);
  let first = -1;
  let last = -1;
  for (let y = 0; y < height; y++) {
    let ink = false;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = bmp[i + 3] / 255;
      // luminance over a white background; < 150 = burn a dot
      const lum = (0.114 * bmp[i] + 0.587 * bmp[i + 1] + 0.299 * bmp[i + 2]) * a + 255 * (1 - a);
      if (lum < 150) { dots[y * bytesPerRow + (x >> 3)] |= (0x80 >> (x & 7)); ink = true; }
    }
    if (ink) { if (first < 0) first = y; last = y; }
  }
  if (first < 0) return Buffer.alloc(0); // nothing to print
  const out = [];
  const ROWS_PER_BLOCK = 255; // some clones choke on taller single blocks
  for (let y0 = first; y0 <= last; y0 += ROWS_PER_BLOCK) {
    const rows = Math.min(ROWS_PER_BLOCK, last + 1 - y0);
    const block = Buffer.alloc(8 + bytesPerRow * rows);
    block.set([0x1d, 0x76, 0x30, 0x00, bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff, rows & 0xff, (rows >> 8) & 0xff], 0);
    dots.copy(block, 8, y0 * bytesPerRow, (y0 + rows) * bytesPerRow);
    out.push(block);
  }
  return Buffer.concat(out);
}

/** The receipt as an image exactly PRINT_DOTS wide (one CSS mm = 8 dots). */
async function renderToImage(receiptHtml) {
  const win = await openReceiptWindow(receiptHtml, true);
  try {
    const zoom = PRINT_DOTS / PAPER_CSS_PX;
    win.webContents.setZoomFactor(zoom);
    const cssHeight = await win.webContents.executeJavaScript(WAIT_READY, true);
    const height = Math.min(16000, Math.ceil(cssHeight * zoom) + 4);
    win.setContentSize(PRINT_DOTS, height);
    await new Promise((r) => setTimeout(r, 400)); // let the resized frame paint
    return await win.webContents.capturePage({ x: 0, y: 0, width: PRINT_DOTS, height });
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** Full ESC/POS job for a receipt image: init, raster, feed, cut. */
function escposForImage(image) {
  return Buffer.concat([
    Buffer.from([0x1b, 0x40]),             // ESC @  initialize
    rasterFromImage(image),
    // GS V B n: feed until the last printed row is at the cutter, plus n
    // dots (~4mm), then cut -- the same small tail a hand-printed receipt has.
    Buffer.from([0x1d, 0x56, 0x42, 0x20]),
  ]);
}

/** Network printer (IP:9100): render -> raster -> ESC/POS -> feed + cut. */
async function printHtmlToNetwork(receiptHtml, host, port) {
  const image = await renderToImage(receiptHtml);
  await printToNetwork(host, port, escposForImage(image), 15000);
}

/**
 * An OS printer (USB etc.). mode 'auto' (default) / 'raw' / 'driver':
 * receipt printers get the same raster ESC/POS as network printers, sent
 * RAW through the OS so the installed driver can't garble it; office and
 * virtual printers keep using their driver ('auto' tells them apart by name).
 */
async function printHtmlToOsPrinter(receiptHtml, deviceName, mode) {
  let name = String(deviceName || '');
  const probe = new BrowserWindow({ show: false, width: 100, height: 100, webPreferences: { offscreen: true, sandbox: true } });
  let printers = [];
  try { printers = await listPrinters(probe.webContents); } finally { if (!probe.isDestroyed()) probe.destroy(); }
  if (name && printers.length && !printers.some((p) => p.name === name)) throw new Error('printer_not_found: ' + name);
  if (!name) name = (printers.find((p) => p.isDefault) || {}).name || '';
  if (!useRaw(mode, name)) return printHtmlToPrinter(receiptHtml, name);
  const image = await renderToImage(receiptHtml);
  await sendRaw(name, escposForImage(image));
}

/** "IP[:port]" / "host.local[:port]" = a network printer; anything else = an OS printer name. */
function parseNetworkTarget(target) {
  const t = String(target || '').trim();
  const m = t.match(/^((?:\d{1,3}\.){3}\d{1,3}|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.local)(?::(\d{1,5}))?$/i);
  return m ? { host: m[1], port: parseInt(m[2], 10) || 9100 } : null;
}

/** The page the setup window's "test print" button prints. */
function testHtml(printerLabel) {
  const now = new Date().toLocaleString();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return '<div class="receipt" dir="rtl" style="width:70mm;margin:0 auto;padding:4mm 0;text-align:center;color:#000;font-family:\'IBM Plex Sans Arabic\',Tahoma,Arial,sans-serif;font-size:11px;line-height:1.5">'
    + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;700&display=block">'
    + '<div style="font-size:18px;font-weight:700">Menux</div>'
    + '<div style="font-size:14px;font-weight:700;margin-top:2mm">طباعة تجريبية — Test print</div>'
    + '<div style="margin-top:1mm">' + esc(printerLabel) + '</div>'
    + '<div style="margin-top:3mm;border-top:1.5px dashed #000;padding-top:3mm">برنامج الطباعة يعمل — Print Agent is working</div>'
    + '<div style="margin-top:2mm;direction:ltr">' + esc(now) + '</div></div>';
}

module.exports = { printHtmlToPrinter, printHtmlToOsPrinter, printHtmlToNetwork, parseNetworkTarget, listPrinters, testHtml, rasterFromImage, renderToImage, escposForImage };
