const { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const store = require('./store');
const api = require('./api');
const { printToNetwork } = require('./printer');

let tray = null;
let setupWindow = null;
let pollTimer = null;
let lastError = '';
let lastPrintedAt = null;
let updateStatus = ''; // '', 'checking', 'available', 'downloading', 'ready', 'error'

function isPaired() {
  const c = store.load();
  return !!(c.siteUrl && c.pairingToken);
}

/**
 * Applies the configured "start on login" preference to the OS itself
 * (Windows Registry Run key / macOS Login Items via Electron's own
 * cross-platform API) -- called on every launch and whenever the setting
 * changes, so a reboot doesn't silently leave printing paused until
 * someone remembers to open this app by hand.
 */
function applyStartOnLoginSetting() {
  const { startOnLogin } = store.load();
  try {
    app.setLoginItemSettings({ openAtLogin: !!startOnLogin, openAsHidden: true });
  } catch (e) {
    // Best-effort -- e.g. unsupported on this platform/packaging; the
    // app still runs fine manually either way.
  }
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
  applyStartOnLoginSetting();
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

  const { arabicCodepageTable } = store.load();
  for (const job of jobs) {
    // job.printer_target can be an IP ("192.168.1.50:9100") or a
    // hostname ("kitchen-printer.local:9100") -- net.Socket#connect()
    // resolves either via normal OS DNS, so a printer advertising itself
    // via mDNS/Bonjour (if the OS's own mDNS responder resolves .local
    // names, which Windows/macOS both do out of the box) works here with
    // zero extra code, as a name that survives the printer's IP changing.
    const [host, port] = String(job.printer_target || '').split(':');
    if (!host) {
      await api.ackJob(siteUrl, pairingToken, job.id, false, 'no_printer_target').catch(() => {});
      continue;
    }
    try {
      await printToNetwork(host, parseInt(port, 10) || 9100, job.receipt_text || 'TEST PRINT', 8000, { arabicCodepageTable });
      await api.ackJob(siteUrl, pairingToken, job.id, true);
      lastError = '';
      lastPrintedAt = new Date();
    } catch (err) {
      await api.ackJob(siteUrl, pairingToken, job.id, false, err.message).catch(() => {});
      lastError = (job.printer_name || host) + ': ' + err.message;
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

/**
 * Auto-update, wired to GitHub Releases on the app's own repo
 * (package.json's build.publish -- see README for the tag-to-release
 * pipeline). Checks once on startup and every 4 hours after -- frequent
 * enough that a fix reaches unattended kitchen PCs same-day, infrequent
 * enough it's a non-event on GitHub's API and this machine's network.
 * Downloads happen silently in the background; the new version only
 * actually installs on the next app restart (quitAndInstall), never
 * interrupting an order mid-print.
 */
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => { updateStatus = 'checking'; updateTrayMenu(); });
  autoUpdater.on('update-available', () => { updateStatus = 'downloading'; updateTrayMenu(); });
  autoUpdater.on('update-not-available', () => { updateStatus = ''; updateTrayMenu(); });
  autoUpdater.on('update-downloaded', () => { updateStatus = 'ready'; updateTrayMenu(); });
  autoUpdater.on('error', () => { updateStatus = 'error'; updateTrayMenu(); });
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 4 * 60 * 60 * 1000);
}

function updateStatusLabel() {
  switch (updateStatus) {
    case 'checking': return 'Checking for updates…';
    case 'downloading': return 'Downloading update…';
    case 'ready': return 'Update ready — click to restart';
    case 'error': return 'Update check failed';
    default: return null;
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const paired = isPaired();
  tray.setToolTip('Menux Print Agent — ' + (paired ? (lastError ? 'Error' : 'Running') : 'Not paired'));
  const updLabel = updateStatusLabel();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: paired ? 'Paired ✓' : 'Not paired', enabled: false },
    { label: lastPrintedAt ? ('Last print: ' + lastPrintedAt.toLocaleTimeString()) : 'No prints yet', enabled: false },
    ...(lastError ? [{ label: 'Error: ' + lastError, enabled: false }] : []),
    ...(updLabel ? [{
      label: updLabel,
      enabled: updateStatus === 'ready',
      click: updateStatus === 'ready' ? () => autoUpdater.quitAndInstall() : undefined,
    }] : []),
    { type: 'separator' },
    {
      label: 'Start automatically on login',
      type: 'checkbox',
      checked: !!store.load().startOnLogin,
      click: (item) => {
        store.save(Object.assign({}, store.load(), { startOnLogin: item.checked }));
        applyStartOnLoginSetting();
      },
    },
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
  applyStartOnLoginSetting();
  restartPolling();
  setupAutoUpdater();

  app.dock && app.dock.hide(); // macOS: tray-only app, no dock icon
});

app.on('window-all-closed', (e) => {
  // Tray app -- closing the setup window must not quit the background
  // polling loop.
  e.preventDefault();
});
