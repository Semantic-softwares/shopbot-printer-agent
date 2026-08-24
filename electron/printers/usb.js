const { safeLog, logMessage } = require('../logger');

/**
 * Send to a USB printer, routed by platform. Windows never attempts libusb —
 * usbprint.sys already owns the device once it's installed as a Windows printer,
 * so claiming the interface fails with LIBUSB_ERROR_NOT_SUPPORTED even though the
 * printer itself is fine. macOS/Linux keep the direct libusb path.
 */
async function sendToUSBPrinter(data, printer) {
  if (process.platform === 'win32') {
    return sendToUSBPrinterViaSpooler(data, printer);
  }
  // Wrapped in an outer timeout (sendToUSBPrinterInternal has its own endpoint-level
  // timeout too) because a stuck transfer here used to hang the promise forever,
  // which wedged the entire polling loop until the app was manually restarted.
  return Promise.race([
    sendToUSBPrinterInternal(data, printer),
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ success: false, error: 'USB send timed out after 18s' }),
        18000
      )
    ),
  ]);
}

/** macOS/Linux: direct libusb open → claim → transfer. */
function sendToUSBPrinterInternal(data, printer) {
  return new Promise((resolve) => {
    try {
      const usb = require('usb');

      logMessage('DEBUG', 'USBPrint', `🔌 Finding USB device: VID=0x${printer.vendorId.toString(16).toUpperCase()} PID=0x${printer.productId.toString(16).toUpperCase()}`);

      // Match live devices by vendorId+productId — the same criteria job-processor.js
      // already used to pick this printer. busNumber/deviceAddress are OS-assigned and
      // drift on every unplug/replug, so they're only used as a tiebreaker below when
      // more than one identical model is attached, not as a required match — otherwise
      // a printer that's actually connected fine gets reported "not found".
      const candidates = usb.getDeviceList().filter(
        (d) =>
          d.deviceDescriptor.idVendor === printer.vendorId &&
          d.deviceDescriptor.idProduct === printer.productId
      );
      const device =
        candidates.length <= 1
          ? candidates[0]
          : candidates.find(
              (d) => d.busNumber === printer.busNumber && d.deviceAddress === printer.deviceAddress
            ) || candidates[0];

      if (!device) {
        logMessage('ERROR', 'USBPrint', `❌ USB device not found: ${printer.name}`);
        return resolve({ success: false, error: `USB device not found: ${printer.name}` });
      }

      logMessage('DEBUG', 'USBPrint', `✅ Device found, opening...`);
      device.open();
      const iface = device.interfaces[0];

      if (!iface) {
        logMessage('ERROR', 'USBPrint', `❌ No interface found on device`);
        device.close();
        return resolve({ success: false, error: `No interface for ${printer.name}` });
      }

      iface.claim();
      logMessage('DEBUG', 'USBPrint', `✅ Interface claimed`);

      const outEndpoint = iface.endpoints.find((e) => e.direction === 'out');

      if (!outEndpoint) {
        logMessage('ERROR', 'USBPrint', `❌ No OUT endpoint found`);
        iface.release();
        device.close();
        return resolve({ success: false, error: `No OUT endpoint for ${printer.name}` });
      }

      logMessage('DEBUG', 'USBPrint', `✅ OUT endpoint found, transferring ${data.length} bytes...`);

      // Without this, a stuck printer (out of paper, powered off mid-transfer) leaves
      // this transfer callback pending forever — libusb's default endpoint timeout is
      // 0 (infinite). 15s bounds it so the promise always settles.
      outEndpoint.timeout = 15000;

      outEndpoint.transfer(data, (err) => {
        try {
          iface.release();
          device.close();
        } catch {}

        if (err) {
          logMessage('ERROR', 'USBPrint', `❌ Transfer failed: ${err.message}`);
          resolve({ success: false, error: err.message });
        } else {
          logMessage('INFO', 'USBPrint', `📤 Data sent to ${printer.name}`);
          resolve({ success: true });
        }
      });
    } catch (error) {
      logMessage('ERROR', 'USBPrint', `USB printer error (libusb): ${printer.name}`, error.message);
      resolve({ success: false, error: error.message });
    }
  });
}

/**
 * Discover USB printers. On Windows this always goes through the Windows
 * printer subsystem (WMI), never libusb — libusb enumeration can actually
 * succeed on Windows (it only fails to *claim the interface*, at print time),
 * so relying on it here would register a printer with a vendorId/productId
 * identity but no windowsPrinterName, leaving nothing but an always-ambiguous
 * multi-candidate WMI lookup to resolve it at print time. WMI discovery is
 * unambiguous up front because the user picks the printer by name.
 */
function discoverUSBPrinters() {
  if (process.platform === 'win32') {
    return discoverUSBPrintersWindows();
  }
  try {
    const usb = require('usb');
    const usbDevices = usb.getDeviceList();
    const usbPrinters = [];

    safeLog(`🔍 [USB DISCOVERY] Scanning ${usbDevices.length} USB devices...`);

    usbDevices.forEach((device) => {
      const vendorId = device.deviceDescriptor.idVendor;
      const productId = device.deviceDescriptor.idProduct;

      safeLog(`  📱 Device: VID=0x${vendorId.toString(16).toUpperCase()} (${vendorId}) PID=0x${productId.toString(16).toUpperCase()} (${productId}) Class=${device.deviceDescriptor.bDeviceClass}`);

      // Known printer vendor IDs only - be strict to avoid detecting non-printers
      const printerVendorIds = [
        0x04b8, // Epson
        0x0471, // Philips
        0x067b, // Prolific (common in thermal printers)
        0x1a86, // Zjiang (common thermal printer)
        0x01a2, // Generic thermal printer (some devices)
        0x0418, // Your printer (VID 0x0418)
        0x0519, // Aopvui
        0x0483, // STMicroelectronics
        0x10d6, // Datalogic
        0x1504, // Thermal printers
        0x1a23, // Posiflex
        0x1cb7, // Star Micronics
        0x11aa, // Zebra
        0x055f, // Mustek
        0x0a5f, // Microtek
      ];

      // Only check for known printer vendor IDs
      // Don't use bDeviceClass check as it's too broad (class 0 = composite device)
      safeLog(`  VendorID: ${vendorId} (0x${vendorId.toString(16).toUpperCase()}), in list: ${printerVendorIds.includes(vendorId)}`);
      if (printerVendorIds.includes(vendorId)) {
        const printerInfo = {
          id: `usb-${device.busNumber}-${device.deviceAddress}`,
          name: `USB Printer (${vendorId.toString(16).toUpperCase()}:${productId.toString(16).toUpperCase()})`,
          type: 'usb',
          vendorId: vendorId,
          productId: productId,
          busNumber: device.busNumber,
          deviceAddress: device.deviceAddress,
          status: 'online',
          lastChecked: new Date().toISOString(),
        };
        usbPrinters.push(printerInfo);
        safeLog(`✅ [USB PRINTER] Found: ${printerInfo.name}`);
      } else {
        safeLog(`⏭️ [USB] Skipped (not a known printer vendor): VID=${vendorId.toString(16).toUpperCase()}`);
      }
    });

    safeLog(`🎯 [USB DISCOVERY] Total printers found: ${usbPrinters.length}`);
    return usbPrinters;
  } catch (error) {
    // Windows never reaches here (returned above) — this is the macOS/Linux
    // libusb failure path; silently ignore (avoid EPIPE on broken pipes).
    return [];
  }
}

// ============================================================
// WINDOWS: PRINT SPOOLER (RAW ESC/POS via winspool.Drv)
// Windows owns USB thermal printers through its own print subsystem the
// moment a driver is installed, so libusb can enumerate the device but can
// never claim its interface. These functions discover printers through the
// Windows printer subsystem (WMI) and send raw bytes through the spooler
// instead — the native, supported way to reach a USB printer on Windows.
// ============================================================

/** Discover locally-attached Windows printers via WMI (not network-shared ones). */
function discoverUSBPrintersWindows() {
  try {
    const { execSync } = require('child_process');
    safeLog('🔍 [USB DISCOVERY WIN] Using Windows-native printer discovery (PowerShell + WMI)...');

    // `Network = $false` is the robust way to scope this to locally-attached
    // printers — unlike a `PortName -match 'USB'` filter, it doesn't depend on
    // a particular driver's virtual port naming (many thermal-printer drivers,
    // e.g. Epson ESD/POS, use ports like "ESDPRT001" that don't contain "USB").
    const psScript = "Get-WmiObject Win32_Printer | Where-Object { -not $_.Network } | Select-Object Name, PortName, DriverName, PrinterStatus | ConvertTo-Json -Compress";
    const result = execSync(`powershell -NoProfile -Command "${psScript}"`, {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    }).trim();

    if (!result) {
      safeLog('⚠️ [USB DISCOVERY WIN] No local Windows printers found via WMI');
      return [];
    }

    let printers = JSON.parse(result);
    if (!Array.isArray(printers)) printers = [printers]; // Single result comes as object

    const usbPrinters = printers
      .filter(p => p && p.Name)
      .map((p, i) => ({
        id: `usb-win-${i}-${Date.now()}`,
        name: p.Name,
        type: 'usb',
        windowsPrinterName: p.Name,
        portName: p.PortName || '',
        driverName: p.DriverName || '',
        vendorId: 0,
        productId: 0,
        busNumber: 0,
        deviceAddress: i,
        status: (p.PrinterStatus === 0 || p.PrinterStatus === 3) ? 'online' : 'offline',
        lastChecked: new Date().toISOString(),
      }));

    safeLog(`🎯 [USB DISCOVERY WIN] Found ${usbPrinters.length} local printer(s)`);
    usbPrinters.forEach(p => safeLog(`  ✅ ${p.name} (Port: ${p.portName}, Driver: ${p.driverName})`));

    return usbPrinters;
  } catch (error) {
    safeLog(`❌ [USB DISCOVERY WIN] Windows-native discovery failed: ${error.message}`);
    return [];
  }
}

/**
 * Send data to a Windows USB printer, resolving its spooler identity first.
 * Never touches libusb. If the stored printer record already has a
 * `windowsPrinterName` (captured at registration time), it's used directly —
 * no rediscovery. Otherwise this does a one-time bounded backfill: if exactly
 * one local Windows printer is present, adopt and persist its identity onto
 * the printer record; if zero or more than one are present, fail with a
 * clear diagnostic rather than guessing which physical printer to use.
 */
async function sendToUSBPrinterViaSpooler(data, printer) {
  return Promise.race([
    sendToUSBPrinterViaSpoolerInternal(data, printer),
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ success: false, error: 'Windows spooler send timed out after 20s' }),
        20000
      )
    ),
  ]);
}

async function sendToUSBPrinterViaSpoolerInternal(data, printer) {
  let { windowsPrinterName, portName, driverName } = printer;

  if (!windowsPrinterName) {
    const candidates = discoverUSBPrintersWindows();

    if (candidates.length === 1) {
      windowsPrinterName = candidates[0].windowsPrinterName;
      portName = candidates[0].portName;
      driverName = candidates[0].driverName;

      // Persist the backfilled identity onto the live printer record so this
      // resolution only ever has to happen once per printer.
      printer.windowsPrinterName = windowsPrinterName;
      printer.portName = portName;
      printer.driverName = driverName;
      try {
        require('../persistence').savePersistedData();
      } catch (e) {
        logMessage('WARN', 'USBPrintWin', `Resolved Windows printer name but failed to persist it: ${e.message}`);
      }
      logMessage('INFO', 'USBPrintWin', `🔗 Resolved and persisted Windows printer name: "${windowsPrinterName}" (port: ${portName})`);
    } else {
      const error =
        candidates.length === 0
          ? `No local Windows printer found for "${printer.name}" — is it installed in Windows?`
          : `Windows printer name not configured for "${printer.name}" and ${candidates.length} local printers were found — cannot tell which one it is. Re-add this printer from the discovery list to capture its identity.`;
      logMessage('ERROR', 'USBPrintWin', `❌ ${error}`);
      return {
        success: false,
        error,
        diagnostics: { found: false, candidateCount: candidates.length },
      };
    }
  }

  return sendToUSBPrinterWindows(data, { ...printer, windowsPrinterName, portName, driverName });
}

/**
 * Send raw ESC/POS data to a USB printer on Windows via the print spooler.
 * Uses PowerShell + .NET RawPrinterHelper (winspool.Drv P/Invoke): OpenPrinter →
 * StartDocPrinter (pDataType "RAW") → StartPagePrinter → WritePrinter → cleanup.
 */
function sendToUSBPrinterWindows(data, printer) {
  return new Promise((resolve) => {
    try {
      const { exec } = require('child_process');
      const fs = require('fs');
      const os = require('os');
      const pathModule = require('path');

      const printerName = printer.windowsPrinterName || printer.name;
      const bufData = Buffer.isBuffer(data) ? data : Buffer.from(data);

      // Write raw ESC/POS data to a temp file
      const tempFile = pathModule.join(os.tmpdir(), `shopbot-print-${Date.now()}.bin`);
      fs.writeFileSync(tempFile, bufData);

      logMessage('INFO', 'USBPrintWin', `📤 Sending ${bufData.length} bytes to "${printerName}" via Windows spooler...`);

      // Write the PowerShell script to a temp .ps1 file to avoid escaping issues
      const psScriptPath = pathModule.join(os.tmpdir(), `shopbot-rawprint-${Date.now()}.ps1`);
      const psLines = [
        `$PrinterName = '${printerName.replace(/'/g, "''")}';`,
        `$FilePath = '${tempFile.replace(/\\/g, '\\\\').replace(/'/g, "''")}';`,
        `$bytes = [System.IO.File]::ReadAllBytes($FilePath);`,
        ``,
        `Add-Type -TypeDefinition @"`,
        `using System;`,
        `using System.Runtime.InteropServices;`,
        `public class RawPrinterHelper {`,
        `    [StructLayout(LayoutKind.Sequential)]`,
        `    public struct DOCINFOA {`,
        `        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;`,
        `        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;`,
        `        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;`,
        `    }`,
        `    [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true)]`,
        `    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);`,
        `    [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]`,
        `    public static extern bool ClosePrinter(IntPtr hPrinter);`,
        `    [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]`,
        `    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] ref DOCINFOA di);`,
        `    [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]`,
        `    public static extern bool EndDocPrinter(IntPtr hPrinter);`,
        `    [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]`,
        `    public static extern bool StartPagePrinter(IntPtr hPrinter);`,
        `    [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]`,
        `    public static extern bool EndPagePrinter(IntPtr hPrinter);`,
        `    [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]`,
        `    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);`,
        `    public static string SendBytesToPrinter(string szPrinterName, byte[] data) {`,
        `        IntPtr hPrinter;`,
        `        DOCINFOA di = new DOCINFOA();`,
        `        di.pDocName = "ShopBot Receipt";`,
        `        di.pDataType = "RAW";`,
        `        bool opened = false, started = false, page = false, written = false;`,
        `        int bytesWritten = 0;`,
        `        int lastError = 0;`,
        `        if (OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) {`,
        `            opened = true;`,
        `            if (StartDocPrinter(hPrinter, 1, ref di)) {`,
        `                started = true;`,
        `                if (StartPagePrinter(hPrinter)) {`,
        `                    page = true;`,
        `                    IntPtr ptr = Marshal.AllocHGlobal(data.Length);`,
        `                    Marshal.Copy(data, 0, ptr, data.Length);`,
        `                    int wr;`,
        `                    written = WritePrinter(hPrinter, ptr, data.Length, out wr);`,
        `                    if (!written) { lastError = Marshal.GetLastWin32Error(); }`,
        `                    bytesWritten = wr;`,
        `                    Marshal.FreeHGlobal(ptr);`,
        `                    EndPagePrinter(hPrinter);`,
        `                } else { lastError = Marshal.GetLastWin32Error(); }`,
        `                EndDocPrinter(hPrinter);`,
        `            } else { lastError = Marshal.GetLastWin32Error(); }`,
        `            ClosePrinter(hPrinter);`,
        `        } else { lastError = Marshal.GetLastWin32Error(); }`,
        `        return string.Format("OPEN={0};STARTDOC={1};STARTPAGE={2};WRITE={3};BYTES={4};LASTERROR={5}",`,
        `            opened ? 1 : 0, started ? 1 : 0, page ? 1 : 0, written ? 1 : 0, bytesWritten, lastError);`,
        `    }`,
        `}`,
        `"@`,
        ``,
        `$result = [RawPrinterHelper]::SendBytesToPrinter($PrinterName, $bytes);`,
        `Remove-Item -Path $FilePath -Force -ErrorAction SilentlyContinue;`,
        `Remove-Item -Path $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue;`,
        `Write-Output "RESULT:$result"`,
      ];

      fs.writeFileSync(psScriptPath, psLines.join('\n'), 'utf8');

      exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psScriptPath}"`, {
        timeout: 15000,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        // Cleanup temp files (best-effort — the script also tries to clean up itself)
        try { fs.unlinkSync(tempFile); } catch {}
        try { fs.unlinkSync(psScriptPath); } catch {}

        if (err) {
          logMessage('ERROR', 'USBPrintWin', `PowerShell exec failed: ${err.message}`);
          resolve({
            success: false,
            error: `Windows printer spooler error: ${err.message}`,
            diagnostics: { printerName, portName: printer.portName, driverName: printer.driverName, execFailed: true },
          });
          return;
        }

        const diagnostics = parseSpoolerResult((stdout || '').trim());
        diagnostics.printerName = printerName;
        diagnostics.portName = printer.portName;
        diagnostics.driverName = printer.driverName;

        if (diagnostics.write) {
          logMessage('INFO', 'USBPrintWin', `✅ Printed to "${printerName}" via Windows spooler (${diagnostics.bytesWritten} bytes)`);
          resolve({ success: true, diagnostics });
        } else {
          const failedStep = !diagnostics.open ? 'OpenPrinter' : !diagnostics.startDoc ? 'StartDocPrinter' : !diagnostics.startPage ? 'StartPagePrinter' : 'WritePrinter';
          const error = `Windows printer spooler error: ${failedStep} failed on "${printerName}" (port ${printer.portName || 'unknown'}, driver ${printer.driverName || 'unknown'}, Win32 error ${diagnostics.lastError})`;
          logMessage('ERROR', 'USBPrintWin', `❌ ${error}. Raw output: ${stdout}. Stderr: ${stderr || 'none'}`);
          resolve({ success: false, error, diagnostics });
        }
      });
    } catch (error) {
      logMessage('ERROR', 'USBPrintWin', `Windows print exception: ${error.message}`);
      resolve({ success: false, error: error.message });
    }
  });
}

/** Parse the `RESULT:OPEN=1;STARTDOC=1;STARTPAGE=1;WRITE=0;BYTES=0;LASTERROR=1801` line from the PS script. */
function parseSpoolerResult(output) {
  const line = output.split('\n').find((l) => l.startsWith('RESULT:'));
  const fields = {};
  if (line) {
    line
      .slice('RESULT:'.length)
      .split(';')
      .forEach((pair) => {
        const [key, value] = pair.split('=');
        if (key) fields[key] = value;
      });
  }
  return {
    found: true,
    open: fields.OPEN === '1',
    startDoc: fields.STARTDOC === '1',
    startPage: fields.STARTPAGE === '1',
    write: fields.WRITE === '1',
    bytesWritten: Number(fields.BYTES) || 0,
    lastError: Number(fields.LASTERROR) || 0,
    rawOutput: output,
  };
}

module.exports = {
  sendToUSBPrinter,
  discoverUSBPrinters,
  discoverUSBPrintersWindows,
  sendToUSBPrinterWindows,
};
