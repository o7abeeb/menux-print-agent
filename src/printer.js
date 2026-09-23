/**
 * Raw ESC/POS printing over TCP (port 9100, the near-universal "JetDirect"
 * raw socket port every network thermal printer listens on regardless of
 * brand). No printer-specific SDK — a plain byte stream is the one thing
 * that works across Epson/Xprinter/Star/etc. without per-vendor code.
 */
const net = require('net');
const iconv = require('iconv-lite');

const ESC = 0x1b;
const GS = 0x1d;

// Most ESC/POS thermal printers (Epson command set and the countless
// Chinese clones -- Xprinter/Gainscha/etc. -- that copy it) are single-
// byte devices with a selectable "character code table"; they don't
// understand UTF-8 multi-byte sequences at all, so Arabic text sent as
// raw UTF-8 (the old behavior here) prints as garbage or blanks. Fix:
// re-encode into a single-byte Arabic codepage the printer can actually
// read, and tell it which table that is via ESC t n before the text.
// CP1256 (Windows Arabic) is the most common one clone thermal printers
// in this market ship support for; table number 21 is what Epson's own
// numbering (and most clones copying it) call it, but this genuinely
// varies by vendor/firmware -- exposed as a tunable setting
// (arabicCodepageTable in store.js) rather than hardcoded, since there is
// no single number that's guaranteed correct across every printer model.
// If a specific printer still garbles Arabic with this on, the fix is to
// try a different table number here, not to disable it outright.
const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿ]/;

// menux_printer_render_receipt_text() (theme repo, include/menux-printers.php)
// embeds this exact byte (ASCII 0x01, "start of heading" -- never
// legitimate in printable order text) wherever the official SAR/OMR/AED
// currency symbol belongs, since that symbol is a custom icon-font glyph
// with no real character and can't be sent as text at all. opts.currencyImage
// (base64 pre-rendered ESC/POS raster bytes for that one glyph, same value
// reused at every occurrence) gets spliced in at each token position below.
const CURRENCY_TOKEN_BYTE = 0x01;

function buildReceipt(text, opts = {}) {
  const codepageTable = Number.isInteger(opts.arabicCodepageTable) ? opts.arabicCodepageTable : 21;
  const init = Buffer.from([ESC, 0x40]); // ESC @ -- initialize printer
  const raw = text.replace(/\n/g, '\r\n') + '\r\n\r\n\r\n';

  let body;
  let codepageCmd = Buffer.alloc(0);
  if (ARABIC_RE.test(raw)) {
    // ESC t n -- select character code table (n = codepageTable), then
    // send the body re-encoded into that same single-byte codepage.
    codepageCmd = Buffer.from([ESC, 0x74, codepageTable]);
    body = iconv.encode(raw, 'cp1256');
  } else {
    body = Buffer.from(raw, 'utf8');
  }

  if (opts.currencyImage) {
    const imgBytes = Buffer.from(opts.currencyImage, 'base64');
    const parts = [];
    let start = 0;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === CURRENCY_TOKEN_BYTE) {
        parts.push(body.subarray(start, i), imgBytes);
        start = i + 1;
      }
    }
    parts.push(body.subarray(start));
    body = Buffer.concat(parts);
  }

  const cut = Buffer.from([GS, 0x56, 0x42, 0x00]); // GS V B 0 -- full cut w/ feed
  return Buffer.concat([init, codepageCmd, body, cut]);
}

/**
 * Sends a pre-built (or plain-text, auto-wrapped) buffer to ip:port.
 * Resolves/rejects instead of throwing so callers can ack success/failure
 * back to Menux per job.
 */
function printToNetwork(ip, port, textOrBuffer, timeoutMs = 8000, buildOpts = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.isBuffer(textOrBuffer) ? textOrBuffer : buildReceipt(String(textOrBuffer), buildOpts);
    const socket = new net.Socket();
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish(new Error('printer_timeout')));
    socket.on('error', (err) => finish(err));
    socket.connect(port || 9100, ip, () => {
      socket.write(data, (err) => {
        if (err) return finish(err);
        // Give the printer a moment to actually consume the bytes before
        // we tear the socket down -- some clones drop the tail of the
        // buffer if the connection closes immediately after write().
        setTimeout(() => finish(), 300);
      });
    });
  });
}

module.exports = { buildReceipt, printToNetwork };
