/**
 * Fake network printer -- listens on port 9100 (the same raw "JetDirect"
 * port a real thermal printer would) and, instead of printing, dumps
 * whatever bytes it receives to the console and to received-N.txt.
 *
 * Lets the WHOLE pipeline (WordPress -> agent -> raw TCP send) be tested
 * end-to-end without owning a real printer -- the only thing this can't
 * verify is whether paper actually comes out correctly on real hardware.
 *
 * Usage: node tools/fake-printer.js [port]  (default 9100)
 */
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2], 10) || 9100;
let count = 0;

const server = net.createServer((socket) => {
  const chunks = [];
  const remote = socket.remoteAddress + ':' + socket.remotePort;
  console.log('[fake-printer] connection from', remote);

  socket.on('data', (chunk) => chunks.push(chunk));

  socket.on('end', () => {
    count++;
    const buf = Buffer.concat(chunks);
    const outFile = path.join(__dirname, `received-${count}.txt`);
    fs.writeFileSync(outFile, buf);
    console.log(`[fake-printer] job #${count}: ${buf.length} bytes -> ${outFile}`);
    console.log('---------------------------------------------');
    // Strip the ESC/POS control bytes (init header + cut trailer) just
    // for a readable console preview -- the raw bytes are still saved
    // untouched in the file above.
    console.log(buf.toString('utf8').replace(/[\x00-\x08\x0e-\x1f]/g, ''));
    console.log('---------------------------------------------');
  });

  socket.on('error', (err) => console.error('[fake-printer] socket error:', err.message));
});

server.listen(PORT, () => {
  console.log(`[fake-printer] listening on port ${PORT} -- point a printer at THIS machine's IP:${PORT}`);
  console.log('[fake-printer] (Ctrl+C to stop)');
});
