/**
 * Sends ready-made ESC/POS bytes to a printer installed in the OS, untouched
 * ("RAW" print job). The printer's driver only forwards the bytes, so it no
 * longer matters which driver is installed: seen live 2026-10-10, the
 * Xprinter 2026 driver printed Windows' own test page fine but turned every
 * page Chromium printed through it into random characters.
 *
 *  - Windows: winspool.drv (OpenPrinter / StartDocPrinter "RAW" /
 *    WritePrinter) through PowerShell + a tiny C# helper, compiled once and
 *    cached as a DLL in the app's data folder (later jobs skip compiling).
 *  - Linux / macOS: CUPS `lp -o raw`.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const CS_SOURCE = `
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class MnxRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool OpenPrinter(string name, out IntPtr h, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);
  public static string Send(string printer, string file) {
    byte[] data = File.ReadAllBytes(file);
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return "open_failed_" + Marshal.GetLastWin32Error();
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = "Menux receipt"; di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) return "startdoc_failed_" + Marshal.GetLastWin32Error();
      try {
        if (!StartPagePrinter(h)) return "startpage_failed_" + Marshal.GetLastWin32Error();
        int written;
        bool ok = WritePrinter(h, data, data.Length, out written);
        EndPagePrinter(h);
        if (!ok || written != data.Length) return "write_failed_" + Marshal.GetLastWin32Error();
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
    return "";
  }
}`;

// Bump the file name when CS_SOURCE changes, so a stale cached DLL is never used.
const DLL_NAME = 'menux-rawprint-v1.dll';

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$dll = $env:MNX_RAW_DLL
if (-not (Test-Path -LiteralPath $dll)) {
  Add-Type -TypeDefinition $env:MNX_RAW_SRC -Language CSharp -OutputAssembly $dll
}
Add-Type -LiteralPath $dll
$p = $env:MNX_RAW_PRINTER
if ([string]::IsNullOrEmpty($p)) {
  $p = (Get-CimInstance Win32_Printer | Where-Object { $_.Default }).Name
  if ([string]::IsNullOrEmpty($p)) { Write-Output 'no_default_printer'; exit 0 }
}
Write-Output ([MnxRawPrint]::Send($p, $env:MNX_RAW_FILE))
`;

function run(cmd, args, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: Object.assign({}, process.env, env || {}), timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((String(stderr || '').trim().split(/\r?\n/).pop() || err.message).slice(0, 160)));
        resolve(String(stdout || '').trim());
      });
  });
}

/** Sends `bytes` as a RAW job to the OS printer `printerName` ('' = the system default). */
async function sendRaw(printerName, bytes) {
  const file = path.join(os.tmpdir(), 'menux-receipt-' + process.pid + '-' + Date.now() + '.bin');
  fs.writeFileSync(file, bytes);
  try {
    if (process.platform === 'win32') {
      const out = await run('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
        {
          MNX_RAW_DLL: path.join(app.getPath('userData'), DLL_NAME),
          MNX_RAW_SRC: CS_SOURCE,
          MNX_RAW_PRINTER: printerName || '',
          MNX_RAW_FILE: file,
        }, 60000);
      const last = out.split(/\r?\n/).pop() || '';
      if (last !== '') throw new Error('raw_print_' + last);
      return;
    }
    const args = ['-o', 'raw'];
    if (printerName) args.unshift('-d', printerName);
    args.push(file);
    await run('lp', args, null, 30000);
  } finally {
    // Windows' spooler has copied the bytes by the time Send() returns.
    setTimeout(() => fs.unlink(file, () => {}), 5000);
  }
}

/**
 * Printers that don't speak ESC/POS (office/inkjet/laser, PDF and other
 * virtual printers): those keep printing through their own driver in
 * "auto" mode. Receipt printers -- Xprinter, POS-80/58, Epson TM, Star,
 * Bixolon, Rongta, Sunmi... -- get the RAW path.
 */
const NOT_ESCPOS = /pdf|xps|onenote|fax|canon|laserjet|officejet|deskjet|envy|brother|ricoh|kyocera|lexmark|xerox|konica|sharp|toshiba|oki|dymo|zebra|zdesigner|tsc|godex|label/i;

function useRaw(mode, printerName) {
  if (mode === 'raw') return true;
  if (mode === 'driver') return false;
  return !NOT_ESCPOS.test(String(printerName || ''));
}

module.exports = { sendRaw, useRaw };
