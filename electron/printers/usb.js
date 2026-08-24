const { safeLog, logMessage } = require('../logger');

/**
 * Send to USB printer via libusb (macOS/Linux, and Windows when usbprint.sys allows it).
 * Wrapped in an outer timeout (sendToUSBPrinterInternal has its own endpoint-level
 * timeout too) because a stuck transfer here used to hang the promise forever,
 * which wedged the entire polling loop until the app was manually restarted.
 */
async function sendToUSBPrinter(data, printer) {
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
          // On Windows, try native fallback if USB transfer fails
          if (process.platform === 'win32') {
            const winName = resolveWindowsPrinterName(printer);
            if (winName) {
              logMessage('INFO', 'USBPrint', `⚠️ Transfer failed, trying Windows-native print for "${winName}"...`);
              sendToUSBPrinterWindows(data, { ...printer, windowsPrinterName: winName }).then(resolve);
              return;
            }
          }
          resolve({ success: false, error: err.message });
        } else {
          logMessage('INFO', 'USBPrint', `📤 Data sent to ${printer.name}`);
          resolve({ success: true });
        }
      });
    } catch (error) {
      logMessage('ERROR', 'USBPrint', `USB printer error (libusb): ${printer.name}`, error.message);
      // On Windows, fallback to native printing via Windows spooler
      if (process.platform === 'win32') {
        const winName = resolveWindowsPrinterName(printer);
        if (winName) {
          logMessage('INFO', 'USBPrint', `⚠️ libusb failed, falling back to Windows-native print for "${winName}"...`);
          sendToUSBPrinterWindows(data, { ...printer, windowsPrinterName: winName }).then(resolve);
          return;
        }
      }
      resolve({ success: false, error: error.message });
    }
  });
}

/** Discover USB printers via libusb, matched against a known-vendor allowlist. */
function discoverUSBPrinters() {
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
    // libusb failed — on Windows this is common (usbprint.sys blocks libusb access)
    // Fall back to Windows-native printer discovery via PowerShell + WMI
    if (process.platform === 'win32') {
      safeLog(`⚠️ [USB DISCOVERY] libusb failed (${error.message}), trying Windows-native discovery...`);
      return discoverUSBPrintersWindows();
    }
    // On other platforms, silently ignore (avoid EPIPE on broken pipes)
    return [];
  }
}

// ============================================================
// WINDOWS-NATIVE USB PRINTING FALLBACK
// When libusb fails on Windows (usbprint.sys blocks access),
// these functions use PowerShell + WMI for discovery and
// .NET RawPrinterHelper (winspool.Drv) for raw byte printing.
// ============================================================

/** Discover USB printers on Windows using WMI (fallback when libusb fails). */
function discoverUSBPrintersWindows() {
  try {
    const { execSync } = require('child_process');
    safeLog('🔍 [USB DISCOVERY WIN] Using Windows-native printer discovery (PowerShell + WMI)...');

    // Query WMI for any printer connected on a USB port
    const psScript = "Get-WmiObject Win32_Printer | Where-Object { $_.PortName -match 'USB' } | Select-Object Name, PortName, DriverName, PrinterStatus | ConvertTo-Json -Compress";
    const result = execSync(`powershell -NoProfile -Command "${psScript}"`, {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    }).trim();

    if (!result) {
      safeLog('⚠️ [USB DISCOVERY WIN] No Windows USB printers found via WMI');
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

    safeLog(`🎯 [USB DISCOVERY WIN] Found ${usbPrinters.length} USB printer(s)`);
    usbPrinters.forEach(p => safeLog(`  ✅ ${p.name} (Port: ${p.portName}, Driver: ${p.driverName})`));

    return usbPrinters;
  } catch (error) {
    safeLog(`❌ [USB DISCOVERY WIN] Windows-native discovery also failed: ${error.message}`);
    return [];
  }
}

/**
 * Send raw ESC/POS data to a USB printer on Windows via the print spooler.
 * Uses PowerShell + .NET RawPrinterHelper (winspool.Drv P/Invoke) to bypass libusb.
 * This is only called as a fallback when the normal libusb approach fails.
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

      logMessage('INFO', 'USBPrintWin', `📤 Windows fallback: Sending ${bufData.length} bytes to "${printerName}"...`);

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
        `    public static bool SendBytesToPrinter(string szPrinterName, byte[] data) {`,
        `        IntPtr hPrinter;`,
        `        DOCINFOA di = new DOCINFOA();`,
        `        di.pDocName = "ShopBot Receipt";`,
        `        di.pDataType = "RAW";`,
        `        bool ok = false;`,
        `        if (OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) {`,
        `            if (StartDocPrinter(hPrinter, 1, ref di)) {`,
        `                if (StartPagePrinter(hPrinter)) {`,
        `                    IntPtr ptr = Marshal.AllocHGlobal(data.Length);`,
        `                    Marshal.Copy(data, 0, ptr, data.Length);`,
        `                    int written;`,
        `                    ok = WritePrinter(hPrinter, ptr, data.Length, out written);`,
        `                    Marshal.FreeHGlobal(ptr);`,
        `                    EndPagePrinter(hPrinter);`,
        `                }`,
        `                EndDocPrinter(hPrinter);`,
        `            }`,
        `            ClosePrinter(hPrinter);`,
        `        }`,
        `        return ok;`,
        `    }`,
        `}`,
        `"@`,
        ``,
        `$result = [RawPrinterHelper]::SendBytesToPrinter($PrinterName, $bytes);`,
        `Remove-Item -Path $FilePath -Force -ErrorAction SilentlyContinue;`,
        `Remove-Item -Path $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue;`,
        `if ($result) { Write-Output 'SUCCESS' } else { Write-Output 'FAILED' }`,
      ];

      fs.writeFileSync(psScriptPath, psLines.join('\n'), 'utf8');

      exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psScriptPath}"`, {
        timeout: 15000,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        // Cleanup temp files
        try { fs.unlinkSync(tempFile); } catch {}
        try { fs.unlinkSync(psScriptPath); } catch {}

        if (err) {
          logMessage('ERROR', 'USBPrintWin', `PowerShell print failed: ${err.message}`);
          resolve({ success: false, error: `Windows spooler error: ${err.message}` });
          return;
        }

        const output = (stdout || '').trim();
        if (output.includes('SUCCESS')) {
          logMessage('INFO', 'USBPrintWin', `✅ Printed to "${printerName}" via Windows spooler`);
          resolve({ success: true });
        } else {
          logMessage('ERROR', 'USBPrintWin', `Windows print returned: ${output}. Stderr: ${stderr || 'none'}`);
          resolve({ success: false, error: `Windows spooler: ${output || 'unknown error'}` });
        }
      });
    } catch (error) {
      logMessage('ERROR', 'USBPrintWin', `Windows print exception: ${error.message}`);
      resolve({ success: false, error: error.message });
    }
  });
}

/**
 * Resolve the Windows printer name for a USB printer on-the-fly.
 * Called when libusb fails and we need the Windows spooler name.
 */
function resolveWindowsPrinterName(printer) {
  if (printer.windowsPrinterName) return printer.windowsPrinterName;
  if (process.platform !== 'win32') return null;

  try {
    const winPrinters = discoverUSBPrintersWindows();
    if (winPrinters.length > 0) {
      // Use the first Windows USB printer found
      const winPrinter = winPrinters[0];
      // Cache it on the printer object for future calls
      printer.windowsPrinterName = winPrinter.windowsPrinterName;
      printer.portName = winPrinter.portName;
      safeLog(`🔗 [USB] Resolved Windows printer name: "${winPrinter.windowsPrinterName}" (port: ${winPrinter.portName})`);
      return winPrinter.windowsPrinterName;
    }
  } catch (e) {
    safeLog(`⚠️ [USB] Failed to resolve Windows printer name: ${e.message}`);
  }
  return null;
}

module.exports = {
  sendToUSBPrinter,
  discoverUSBPrinters,
  discoverUSBPrintersWindows,
  sendToUSBPrinterWindows,
  resolveWindowsPrinterName,
};
