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

`printer_target` can also be a hostname (e.g. `kitchen-printer.local:9100`)
instead of a raw IP — `net.Socket#connect()` resolves either through
normal OS DNS, so a printer whose name the OS's own mDNS/Bonjour
responder can resolve survives its IP changing without any config
update. No printer-discovery UI is built here; this only works if
something already resolves that name (Windows 10+/macOS both ship a
basic mDNS responder; the printer itself advertising over mDNS is what's
NOT guaranteed across vendors).

## Arabic on the printed receipt

Most ESC/POS thermal printers (Epson's own command set, and the many
Xprinter/Gainscha-style clones that copy it) are single-byte devices that
don't understand UTF-8 — Arabic text sent as raw UTF-8 prints as garbage
or blanks. `src/printer.js` detects Arabic in the receipt text and:

1. Re-encodes it into **CP1256** (Windows Arabic), a codepage most
   Arabic-market clone printers support.
2. Sends `ESC t <table>` first so the printer knows to interpret the
   following bytes as that codepage.

`table` defaults to **21** (`arabicCodepageTable` in the local config,
`store.js`) — Epson's own numbering for "WPC1256 Arabic", copied by most
clones, but this genuinely varies by printer model/firmware. **If a
specific printer still garbles Arabic with this on, try a different
table number** (edit the config file directly, or wire a settings-page
field to it) rather than assuming Arabic printing can't work on that
printer — there's no single number guaranteed correct across every
vendor. A more robust (but heavier) alternative for a printer that
supports no usable codepage at all is rendering the receipt as a bitmap
image and sending it via `GS v 0` instead of text — not implemented here
yet (needs a canvas/rasterizing dependency and Arabic shaping/bidi
handling), flagged as the natural next step if CP1256 doesn't cover a
merchant's specific hardware.

## Run from source

```
npm install
npm start
```

## Releasing a new version (auto-update pipeline)

This repo is hosted at `github.com/o7abeeb/menux-print-agent` (private)
specifically so `electron-updater` has somewhere to check for new
releases against — every installed agent checks on startup and every 4
hours, downloads silently in the background, and installs on next
restart (`src/main.js`'s `setupAutoUpdater()`).

To ship a new version:

```
npm version patch   # or minor/major -- bumps package.json AND creates a git tag
git push && git push --tags
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds
on a `windows-latest` GitHub Actions runner and runs
`electron-builder --publish always` — this both builds the NSIS
installer AND uploads it as a GitHub Release electron-updater's clients
poll against, in one step. **Runs on `windows-latest` specifically**
because that runner already has Developer Mode / symlink privileges
enabled by default — the exact thing that blocks a plain `npm run dist`
on an ordinary dev machine without elevation (see the error below). No
manual upload step, no local NSIS build needed for a normal release.

**First-time installs still need a manual download** (auto-update only
updates an *already-installed* agent) — point new merchants at the
latest release's `.exe` from the repo's Releases page instead of the old
static `MenuxPrintAgent-win-x64.zip` URL once this pipeline has produced
at least one real release.

### Building locally (manual/emergency only)

`npm run dist` (`electron-builder`) **requires Windows Developer Mode
enabled** on THIS machine — electron-builder downloads a `winCodeSign`
helper package that needs symlink creation privileges Windows only
grants without admin/elevation once Developer Mode is on (Settings →
Privacy & security → For developers). Without it, the build fails with
`Cannot create symbolic link: A required privilege is not held by the
client.` (This is exactly why releases go through CI instead, per above.)

Without Developer Mode, use the portable fallback instead (no installer
wizard, no auto-update support, no signing pipeline, works everywhere —
fine for a one-off test build, not for a real release):

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

## Reliability features (added 2026-09-21, risk-report follow-up)

- **Starts automatically on login by default** (`startOnLogin` in the
  config, toggleable from the tray menu checkbox) — `app.setLoginItemSettings()`
  registers it with the OS (Windows Registry Run key / macOS Login
  Items) on every launch and whenever the setting changes. Addresses the
  most commonly expected failure mode: the cashier PC reboots and
  nobody remembers to reopen this app.
- **Stuck-job recovery is now server-side, not agent-side** — if this
  agent claims a job (`queued` → `sent`) and then crashes/loses network
  before ack'ing, `menux-printers.php`'s WP-Cron sweep (every 10 min)
  releases it back to `queued` automatically, up to
  `MENUX_PRINTER_JOB_MAX_ATTEMPTS` (3) tries before it's surfaced to the
  merchant as a manually-printable "failed" job. Nothing to do here on
  the agent side for this — just don't rely on `sent` meaning "will
  definitely print" without it.
- **Arabic receipts** — see the dedicated section above.

## Known limitations (see the WordPress-side plan doc for the full
phased roadmap this belongs to)

- **No code signing yet** — the NSIS installer built by CI is unsigned,
  so Windows SmartScreen will show an "unknown publisher" warning on
  first install (auto-updates after that are silent, this only affects
  the very first install). Fixing it needs a code-signing certificate
  (a real-world cost/process decision, not something to wire up
  speculatively) — not blocking, just a rougher first-run UX until
  then.
- **USB/Bluetooth printers are not yet handled by this agent** — only
  network (TCP, or a resolvable hostname — see above) printers. The
  plan's WebUSB/Web-Bluetooth phases handle those directly from an open
  dashboard browser tab instead; routing USB/BT printers through this
  agent too (so they don't need a tab open) is a natural follow-up but
  needs native Node modules (`node-usb`/`@abandonware/noble`) not wired
  up here yet.
- **No real-time printer status query** (paper out / cover open) — the
  agent only knows a print "succeeded" once the socket write completes,
  not whether the printer actually had paper. ESC/POS's `DLE EOT n`
  real-time status query exists for this, but the response byte's bit
  meanings vary enough across vendor firmwares that guessing at them
  risked reporting false paper-out errors on printers that were fine —
  not implemented until it can be verified against real hardware.
- `assets/tray-icon.png` is not included — the app runs with a blank
  tray icon until a real one is added; swap in a proper Menux-branded
  icon before shipping a real build.
- Multi-printer-per-agent works already (Menux can point several
  `network_agent` printers at the same paired agent; each job carries
  its own `printer_target`), but only one machine can run this app per
  pairing token today — no "same printer, multiple agents" failover.

## License & code signing

MIT-licensed (see `LICENSE`) — required to qualify for free code signing
through the SignPath Foundation (signpath.org/foundation), which is how
the Windows installer is meant to get signed so SmartScreen stops showing
"Unknown publisher". Signing is not wired into CI until the Foundation
approves the project; until then installers are unsigned.
