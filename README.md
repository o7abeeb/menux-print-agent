# Menux Print Agent

A small Electron tray app that pairs with a Menux restaurant account and
prints incoming orders automatically to a network (Wi‑Fi/LAN) thermal
printer — the `network_agent` connection type in Menux's printer
registry (`dash/printers.php`, WordPress theme repo).

Separate from the Menux WordPress theme repo on purpose: independent
versioning, packaging (`electron-builder` → `.exe`/`.dmg`/`.AppImage`),
and release cadence for a desktop app vs. a WordPress theme.

## How it works

1. Owner adds a printer in Menux (`dash/printers.php`), picks "شبكة (عبر
   وكيل)" (network via agent), and gets back a **site URL + pairing
   token** (`menux_printer_agent_pair` AJAX action).
2. They paste both into this app's Setup window (opens automatically on
   first run, or from the tray menu → "Setup…").
3. The app polls `menux_printer_agent_pull_jobs` every few seconds
   (`pollSeconds` in the local config, default 5s). Each returned job
   already includes:
   - `printer_target` — the printer's `IP:PORT` (owner enters this once,
     in the Menux dashboard, not here — the agent has no local printer
     config of its own, so re-pointing a printer at a new IP needs zero
     agent-side change).
   - `receipt_text` — a plain-text receipt Menux renders server-side
     (the agent has no WordPress session and no HTML/CSS engine, so it
     can't fetch/parse `/print-order/{id}` itself).
4. For each job, the app opens a raw TCP socket to `IP:9100` (the
   "JetDirect" raw-print port nearly every network thermal printer
   listens on) and sends ESC/POS bytes (`src/printer.js`), then reports
   success/failure back via `menux_printer_agent_ack`.

## Run from source

```
npm install
npm start
```

## Build a distributable

`npm run dist` (`electron-builder`, produces a proper NSIS `.exe`
installer) **requires Windows Developer Mode enabled** — electron-builder
downloads a `winCodeSign` helper package that needs symlink creation
privileges Windows only grants without admin/elevation once Developer
Mode is on (Settings → Privacy & security → For developers). Without
it, the build fails with `Cannot create symbolic link: A required
privilege is not held by the client.`

Until that's enabled on the build machine, use the portable fallback
instead (no installer wizard, no signing pipeline, works everywhere):

```
npm install --save-dev electron-packager
npx electron-packager . "Menux Print Agent" --platform=win32 --arch=x64 --out=dist-packager --overwrite --ignore="node_modules" --ignore="dist-packager" --ignore="\.git"
```

This produces `dist-packager/Menux Print Agent-win32-x64/` — a portable
folder (~500MB uncompressed, ~220MB zipped; this IS normal for a bundled
Chromium/Electron runtime, not something to "fix"). Zip that folder and
distribute it: the owner extracts it anywhere and double-clicks
`Menux Print Agent.exe` directly, no install step, no admin rights
needed. Where Menux hosts that zip for owners to download is up to the
deployment — `dash/printers.php`'s network-agent wizard currently links
to `{site}/wp-content/uploads/menux-print-agent/MenuxPrintAgent-win-x64.zip`
on the Menux WordPress site itself (upload it there via cPanel File
Manager after building — simplest option, no new hosting/CDN needed).
Re-run this same command and re-upload whenever the agent's code
changes; there's no auto-update mechanism yet (see limitations below).

Once Developer Mode (or a CI runner that already has it, e.g. GitHub
Actions' windows-latest images) is available, switch back to
`npm run dist` for a real signed-look installer with a proper Start Menu
shortcut instead of a raw portable folder.

## Known limitations (first pass — see the WordPress-side plan doc for
the full phased roadmap this belongs to)

- **No auto-update mechanism** — every code change means rebuilding the
  zip/installer and re-uploading it; already-installed agents keep
  running the old version until someone manually re-downloads.
  `electron-updater` (pairs with `electron-builder`, not `-packager`) is
  the standard fix once Developer Mode / a CI runner is available for
  proper installer builds.
- **USB/Bluetooth printers are not yet handled by this agent** — only
  network (TCP) printers. The plan's WebUSB/Web-Bluetooth phases handle
  those directly from an open dashboard browser tab instead; routing
  USB/BT printers through this agent too (so they don't need a tab open)
  is a natural follow-up but needs native Node modules (`node-usb`/
  `@abandonware/noble`) not wired up here yet.
- **No retry/backoff policy yet** if `menux_printer_ack` itself fails
  after a successful print (rare, but the job would stay `sent`
  server-side with no automatic re-poll for it — needs a small
  stuck-job sweep, either here or server-side, before relying on this
  for unattended kitchens).
- `assets/tray-icon.png` is not included — the app runs with a blank
  tray icon until a real one is added; swap in a proper Menux-branded
  icon before shipping a real build.
- Multi-printer-per-agent works already (Menux can point several
  `network_agent` printers at the same paired agent; each job carries
  its own `printer_target`), but only one machine can run this app per
  pairing token today — no "same printer, multiple agents" failover.
