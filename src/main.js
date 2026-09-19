const { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const store = require('./store');
const api = require('./api');
const { printToNetwork } = require('./printer');

let tray = null;
let setupWindow = null;
let pollTimer = null;
let lastError = '';
let lastPrintedAt = null;

function isPaired() {
  const c = store.load();
  return !!(c.siteUrl && c.pairingToken);
}

function openSetupWindow() {
  if (setupWindow) { setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 460,
    height: 420,
    resizable: false,
    title: 'Menux Print Agent — Setup',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile(path.join(__dirname, 'pairing.html'));
  setupWindow.on('closed', () => { setupWindow = null; });
}

ipcMain.handle('get-config', () => store.load());
ipcMain.handle('save-config', (_evt, config) => {
  store.save(Object.assign({}, store.load(), config));
  restartPolling();
  return store.load();
});

/**
 * One poll cycle: pull queued jobs, print each in turn, ack success/
 * failure back to Menux. Failures never throw out of this function --
 * a printer being offline for one cycle must not crash the loop, just
 * get retried next tick (the job stays 'sent' server-side until acked;
 * a stuck 'sent' job is a known limitation to revisit -- see README).
 */
async function pollOnce() {
  const { siteUrl, pairingToken } = store.load();
  if (!siteUrl || !pairingToken) return;

  let jobs;
  try {
    jobs = await api.pullJobs(siteUrl, pairingToken);
  } catch (err) {
    lastError = 'pull_failed: ' + err.message;
    updateTrayMenu();
    return;
  }

  for (const job of jobs) {
    const [ip, port] = String(job.printer_target || '').split(':');
    if (!ip) {
      await api.ackJob(siteUrl, pairingToken, job.id, false, 'no_printer_target').catch(() => {});
      continue;
    }
    try {
      await printToNetwork(ip, parseInt(port, 10) || 9100, job.receipt_text || 'TEST PRINT');
      await api.ackJob(siteUrl, pairingToken, job.id, true);
      lastError = '';
      lastPrintedAt = new Date();
    } catch (err) {
      await api.ackJob(siteUrl, pairingToken, job.id, false, err.message).catch(() => {});
      lastError = (job.printer_name || ip) + ': ' + err.message;
    }
  }
  updateTrayMenu();
}

function restartPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const { pollSeconds } = store.load();
  pollTimer = setInterval(pollOnce, Math.max(3, pollSeconds || 5) * 1000);
  pollOnce();
}

function updateTrayMenu() {
  if (!tray) return;
  const paired = isPaired();
  tray.setToolTip('Menux Print Agent — ' + (paired ? (lastError ? 'Error' : 'Running') : 'Not paired'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: paired ? 'Paired ✓' : 'Not paired', enabled: false },
    { label: lastPrintedAt ? ('Last print: ' + lastPrintedAt.toLocaleTimeString()) : 'No prints yet', enabled: false },
    ...(lastError ? [{ label: 'Error: ' + lastError, enabled: false }] : []),
    { type: 'separator' },
    { label: 'Setup…', click: openSetupWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

app.whenReady().then(() => {
  // Electron requires a real icon file; a 16x16 blank PNG is provided
  // under assets/ so the app runs out of the box -- swap in a real
  // Menux-branded icon before shipping a build.
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray-icon.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  updateTrayMenu();

  if (!isPaired()) openSetupWindow();
  restartPolling();

  app.dock && app.dock.hide(); // macOS: tray-only app, no dock icon
});

app.on('window-all-closed', (e) => {
  // Tray app -- closing the setup window must not quit the background
  // polling loop.
  e.preventDefault();
});
