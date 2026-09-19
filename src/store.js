/**
 * Tiny JSON-file config store — no extra dependency (electron-store etc.)
 * needed for a handful of settings. Lives in the OS's per-app data dir
 * (app.getPath('userData')), same place Electron apps are expected to
 * keep local state.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

const DEFAULTS = {
  siteUrl: '',       // e.g. https://menu.example.com — the Menux site this agent talks to
  pairingToken: '',  // issued by menux_printer_agent_pair (dash/printers.php "add printer" wizard)
  pollSeconds: 5,    // how often to check Menux for new jobs
  // Printer IP:port comes from Menux itself (each job's printer_target
  // field) — the agent holds no local printer config of its own, so
  // adding/editing a printer in the dashboard needs no agent-side change.
};

function load() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    return Object.assign({}, DEFAULTS, JSON.parse(raw));
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

function save(config) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
}

module.exports = { load, save, configPath };
