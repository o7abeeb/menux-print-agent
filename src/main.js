const { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const store = require('./store');
const api = require('./api');
const { printToNetwork } = require('./printer');
const render = require('./render');

let tray = null;
let setupWindow = null;
let pollTimer = null;
let lastError = '';
// Result of the last poll: null = not tried yet, true = the site answered
// with this token, false = it didn't (wrong site, revoked code, offline).
let connected = null;
let connError = '';
let lastPrintedAt = null;
let updateStatus = ''; // '', 'checking', 'available', 'downloading', 'ready', 'error'
let polling = false; // one cycle at a time: printing can outlast the poll interval

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
  if (process.platform === 'linux') {
    applyLinuxAutostart(!!startOnLogin);
    return;
  }
  try {
    app.setLoginItemSettings({ openAtLogin: !!startOnLogin, openAsHidden: true });
  } catch (e) {
    // Best-effort -- e.g. unsupported on this platform/packaging; the
    // app still runs fine manually either way.
  }
}

/**
 * Linux has no login-item API in Electron (setLoginItemSettings is
 * Windows/macOS only): desktops start whatever has a .desktop file in
 * ~/.config/autostart (XDG autostart spec). An AppImage runs from a
 * temporary mount, so Exec must be the AppImage file itself ($APPIMAGE),
 * which also stays right after the AppImage updates itself in place.
 */
function applyLinuxAutostart(enabled) {
  const fs = require('fs');
  const os = require('os');
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');
  const file = path.join(dir, 'menux-print-agent.desktop');
  try {
    if (!enabled) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return;
    }
    const exe = process.env.APPIMAGE || process.execPath;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Menux Print Agent',
      'Comment=Prints Menux orders automatically',
      'Exec="' + exe.replace(/"/g, '\\"') + '" --hidden',
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'), 'utf8');
  } catch (e) {
    // Best-effort, like the Windows/macOS path above.
  }
}

function openSetupWindow() {
  if (setupWindow) { setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 480,
    height: 660,
    resizable: false,
    title: 'Menux Print Agent — Setup',
    icon: path.join(__dirname, '..', 'assets', 'tray-icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile(path.join(__dirname, 'pairing.html'));
  setupWindow.on('closed', () => { setupWindow = null; });
}

ipcMain.handle('get-config', () => store.load());
// Printers installed on this computer, for the setup window's picker.
ipcMain.handle('list-printers', (evt) => render.listPrinters(evt.sender));
// Prints a local test page on the chosen printer -- checks the printer,
// the driver and the paper/cut settings without involving Menux at all.
ipcMain.handle('test-print', async (_evt, printerName, printMode) => {
  try {
    await render.printHtmlToOsPrinter(render.testHtml(printerName || 'Default printer'), printerName || '', printMode || store.load().printMode || 'auto');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('save-config', (_evt, config) => {
  store.save(Object.assign({}, store.load(), config));
  connected = null;
  connError = '';
  applyStartOnLoginSetting();
  restartPolling();
  return store.load();
});
// The setup window asks this after saving: did the site accept the code?
ipcMain.handle('connection-status', async () => {
  for (let i = 0; i < 40 && connected === null && isPaired(); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  return { connected, error: connError, reason: connReason(connError) };
});

/** A pull error -> what the person should do about it. */
function connReason(err) {
  const e = String(err || '');
  if (!e) return '';
  if (/invalid_token/.test(e)) return 'invalid_code';
  if (/bad_response_http_(400|404)/.test(e)) return 'wrong_site';
  if (/rate_limited|http_429/.test(e)) return 'busy';
  if (/firewall/.test(e)) return 'firewall';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network|EAI_AGAIN/i.test(e)) return 'offline';
  return 'other';
}

const REASON_LABEL = {
  invalid_code: 'Pairing code not accepted: create a new one in the dashboard',
  wrong_site: 'Wrong site: paste the full pairing code from the dashboard',
  busy: 'Site busy, retrying…',
  firewall: 'Blocked by the site firewall',
  offline: 'No internet connection, retrying…',
};

/**
 * One poll cycle: pull queued jobs, print each in turn, ack success/
 * failure back to Menux. Failures never throw out of this function --
 * a printer being offline for one cycle must not crash the loop, just
 * get retried next tick (the job stays 'sent' server-side until acked;
 * a stuck 'sent' job is a known limitation to revisit -- see README).
 */
async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    await pollCycle();
  } finally {
    polling = false;
  }
}

/**
 * Where a job goes:
 *  - the job has receipt_html (Menux sends it since agent 0.2): the real
 *    receipt -- to a network printer when the printer's target in Menux is
 *    an IP/host, otherwise to an OS printer: the one named in Menux, else
 *    the one picked in this app's setup window, else the system default.
 *  - no receipt_html (older Menux): the legacy plain-text network path.
 */
async function printJob(job, cfg) {
  const target = String(job.printer_target || '').trim();
  const net = render.parseNetworkTarget(target);
  if (job.receipt_html) {
    if (net) return render.printHtmlToNetwork(job.receipt_html, net.host, net.port);
    return render.printHtmlToOsPrinter(job.receipt_html, target || cfg.printerName || '', cfg.printMode || 'auto');
  }
  if (!net) throw new Error('no_printer_target');
  return printToNetwork(net.host, net.port, job.receipt_text || 'TEST PRINT', 8000, {
    arabicCodepageTable: cfg.arabicCodepageTable,
    currencyImage: job.currency_image || null, // base64 ESC/POS bytes for SAR/OMR/AED's real symbol, see printer.js
  });
}

async function pollCycle() {
  const cfg = store.load();
  const { siteUrl, pairingToken } = cfg;
  if (!siteUrl || !pairingToken) return;

  let jobs;
  try {
    jobs = await api.pullJobs(siteUrl, pairingToken);
  } catch (err) {
    connected = false;
    connError = String(err.message || err);
    lastError = '';
    updateTrayMenu();
    return;
  }
  connected = true;
  connError = '';

  for (const job of jobs) {
    try {
      await printJob(job, cfg);
      await api.ackJob(siteUrl, pairingToken, job.id, true);
      lastError = '';
      lastPrintedAt = new Date();
    } catch (err) {
      await api.ackJob(siteUrl, pairingToken, job.id, false, String(err.message || err).slice(0, 180)).catch(() => {});
      lastError = (job.printer_name || job.printer_target || 'printer') + ': ' + err.message;
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
  const site = paired ? String(store.load().siteUrl || '').replace(/^https?:\/\//, '') : '';
  const state = !paired ? 'Not paired'
    : connected === true ? ('Connected ✓  ' + site)
    : connected === false ? 'Not connected'
    : 'Connecting…';
  const reason = connected === false ? (REASON_LABEL[connReason(connError)] || connError) : '';
  tray.setToolTip('Menux Print Agent — ' + (connected === true ? (lastError ? 'Error' : 'Connected') : state));
  const updLabel = updateStatusLabel();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: state, enabled: false },
    ...(reason ? [{ label: reason, enabled: false }] : []),
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
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 32, height: 32 }));
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
