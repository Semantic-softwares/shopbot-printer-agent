const net = require('net');
const { safeLog, logMessage } = require('../logger');

/** Send to network printer (TCP 9100). */
function sendToNetworkPrinter(data, printer) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(5000);

    logMessage('DEBUG', 'NetworkPrint', `📡 Connecting to ${printer.name} at ${printer.ip}:${printer.port}...`);

    socket.on('connect', () => {
      logMessage('DEBUG', 'NetworkPrint', `✅ Connected, sending ${data.length} bytes...`);
      socket.write(data);
      socket.end();
      logMessage('INFO', 'NetworkPrint', `📤 Data sent to ${printer.name}`);
      resolve({ success: true });
    });

    socket.on('timeout', () => {
      socket.destroy();
      logMessage('ERROR', 'NetworkPrint', `⏱️ Timeout connecting to ${printer.ip}:${printer.port}`);
      resolve({ success: false, error: `Timeout connecting to ${printer.ip}:${printer.port}` });
    });

    socket.on('error', (err) => {
      socket.destroy();
      logMessage('ERROR', 'NetworkPrint', `Connection error to ${printer.name}`, err.message);
      resolve({ success: false, error: err.message });
    });

    try {
      socket.connect(printer.port, printer.ip);
    } catch (error) {
      logMessage('ERROR', 'NetworkPrint', `Connect error for ${printer.name}`, error.message);
      resolve({ success: false, error: error.message });
    }
  });
}

/**
 * Check a printer's online/offline status via a TCP probe. USB printers are
 * skipped (marked online unconditionally) since they have no network
 * connectivity to probe.
 */
function checkPrinterStatus(printer) {
  if (printer.type === 'usb') {
    printer.status = 'online';
    printer.lastChecked = new Date().toISOString();
    return;
  }

  if (!printer.ip || !printer.port) {
    return;
  }

  const socket = new net.Socket();
  socket.setTimeout(2000);

  let handled = false;

  const handleComplete = (status, message) => {
    if (handled) return;
    handled = true;

    printer.status = status;
    printer.lastChecked = new Date().toISOString();

    try {
      if (!socket.destroyed) {
        socket.destroy();
      }
    } catch (err) {
      // Socket already closed, ignore
    }

    safeLog(message);
  };

  socket.on('connect', () => {
    handleComplete('online', `✅ [PRINTER] ${printer.name} (${printer.ip}:${printer.port}) - ONLINE`);
  });

  socket.on('timeout', () => {
    handleComplete('offline', `⏱️ [PRINTER] ${printer.name} (${printer.ip}:${printer.port}) - OFFLINE (timeout)`);
  });

  socket.on('error', (err) => {
    handleComplete('offline', `❌ [PRINTER] ${printer.name} (${printer.ip}:${printer.port}) - OFFLINE (${err.code || 'error'})`);
  });

  socket.on('close', () => {
    if (!handled) {
      handleComplete('offline', `❌ [PRINTER] ${printer.name} (${printer.ip}:${printer.port}) - OFFLINE (connection closed)`);
    }
  });

  try {
    socket.connect(printer.port, printer.ip);
  } catch (err) {
    handleComplete('offline', `❌ [PRINTER] ${printer.name} (${printer.ip}:${printer.port}) - OFFLINE (connect error)`);
  }
}

module.exports = { sendToNetworkPrinter, checkPrinterStatus };
