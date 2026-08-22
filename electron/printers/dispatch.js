const state = require('../state');
const { safeLog } = require('../logger');
const { sendToNetworkPrinter, checkPrinterStatus } = require('./network');
const { sendToUSBPrinter } = require('./usb');
const { sendToBluetoothPrinterDirect } = require('./bluetooth');

/** Send ESC/POS data to a printer, routed to the right driver by printer.type. */
async function sendToPrinterDevice(printer, data) {
  if (printer.type === 'usb') {
    return await sendToUSBPrinter(data, printer);
  } else if (printer.type === 'bluetooth') {
    return await sendToBluetoothPrinterDirect(data, printer);
  } else {
    return await sendToNetworkPrinter(data, printer);
  }
}

/** Periodic printer status check (every 30 seconds). */
function startPrinterStatusCheck() {
  setInterval(() => {
    if (state.printerStore.printers.length > 0) {
      safeLog('🔍 [STATUS CHECK] Checking all printers...');
      state.printerStore.printers.forEach((printer) => {
        checkPrinterStatus(printer);
      });
    }
  }, 30000); // Check every 30 seconds
}

module.exports = { sendToPrinterDevice, checkPrinterStatus, startPrinterStatusCheck };
