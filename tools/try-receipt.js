/**
 * Manual check of the receipt renderer without Menux or a pairing:
 *   npx electron tools/try-receipt.js <receipt.html> printer [Printer Name]   -> silent print to an OS printer
 *   npx electron tools/try-receipt.js <receipt.html> image <out.png>          -> the network-printer raster, saved as PNG
 * <receipt.html> holds a receipt element as Menux sends it (job.receipt_html).
 */
const fs = require('fs');
const { app } = require('electron');
const render = require('../src/render');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const [file, mode, extra] = args;

app.whenReady().then(async () => {
  try {
    const html = fs.readFileSync(file, 'utf8');
    if (mode === 'image') {
      const img = await render.renderToImage(html);
      fs.writeFileSync(extra, img.toPNG());
      const bytes = render.escposForImage(img);
      console.log('IMAGE ' + img.getSize().width + 'x' + img.getSize().height + ' escpos=' + bytes.length + ' bytes -> ' + extra);
    } else {
      await render.printHtmlToPrinter(html, extra || '');
      console.log('PRINTED to ' + (extra || 'default printer'));
    }
  } catch (e) {
    console.log('ERROR ' + e.message);
  }
  setTimeout(() => app.quit(), 2500);
});
app.on('window-all-closed', () => {});
