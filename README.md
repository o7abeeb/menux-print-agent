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

## Build an installer

```
npm run dist
```

## Known limitations (first pass — see the WordPress-side plan doc for
the full phased roadmap this belongs to)

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
