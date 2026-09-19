/**
 * Raw ESC/POS printing over TCP (port 9100, the near-universal "JetDirect"
 * raw socket port every network thermal printer listens on regardless of
 * brand). No printer-specific SDK — a plain byte stream is the one thing
 * that works across Epson/Xprinter/Star/etc. without per-vendor code.
 */
const net = require('net');

const ESC = 0x1b;
const GS = 0x1d;

// Minimal, universal ESC/POS command set: init, left-align text mode,
// then feed + full paper cut. Deliberately NOT using bold/double-height/
// centering codes here -- those vary more between clones than the basics
// do, and a plain readable receipt beats a garbled "fancy" one.
function buildReceipt(text) {
  const init = Buffer.from([ESC, 0x40]); // ESC @ -- initialize printer
  const body = Buffer.from(text.replace(/\n/g, '\r\n') + '\r\n\r\n\r\n', 'utf8');
  const cut = Buffer.from([GS, 0x56, 0x42, 0x00]); // GS V B 0 -- full cut w/ feed
  return Buffer.concat([init, body, cut]);
}

/**
 * Sends a pre-built (or plain-text, auto-wrapped) buffer to ip:port.
 * Resolves/rejects instead of throwing so callers can ack success/failure
 * back to Menux per job.
 */
function printToNetwork(ip, port, textOrBuffer, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const data = Buffer.isBuffer(textOrBuffer) ? textOrBuffer : buildReceipt(String(textOrBuffer));
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
