const express = require('express');
const cors = require('cors');
const net = require('net');
const state = require('./state');
const { safeLog, logMessage } = require('./logger');
const { savePersistedData, clearPersistedData } = require('./persistence');
const { connectSocket, stopSocketService } = require('./socket-service');
const { checkPrinterStatus } = require('./printers/network');
const { discoverUSBPrinters } = require('./printers/usb');
const { discoverBluetoothPrinters, getBluetoothDeviceChannel, testBluetoothConnection } = require('./printers/bluetooth');
const { attemptPrint, attemptUSBPrint } = require('./legacy-print-queue');

/** Create and start the local Express API the Angular renderer talks to on :4001. */
function startExpressServer() {
  const expressApp = express();

  expressApp.use(cors());
  expressApp.use(express.json({ limit: '10mb' }));

  // Health check
  expressApp.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Connection status (includes health info). Field names kept stable
  // (pollingActive, consecutiveFailures, lastSuccessfulPoll, ...) since the
  // Angular dashboard/logs pages already read them — they now describe the
  // push-delivery socket's health instead of a poll loop's.
  expressApp.get('/api/polling/status', (req, res) => {
    const silenceMs = Date.now() - state.lastSocketEventAt;
    let health = 'healthy';
    if (!state.socketConnected) health = 'stopped';
    else if (state.consecutiveFailures >= 3) health = 'degraded';
    else if (silenceMs > 5 * 60 * 1000) health = 'stale';

    res.json({
      pollingActive: state.socketConnected,
      socketConnected: state.socketConnected,
      apiBaseUrl: state.config.apiBaseUrl,
      storeId: state.activeStoreId || 'not-configured',
      deviceId: state.config.deviceId,
      printerCount: state.printerStore.printers.length,
      onlinePrinters: state.printerStore.printers.filter((p) => p.status === 'online').length,
      health,
      consecutiveFailures: state.consecutiveFailures,
      lastSuccessfulPoll: new Date(state.lastSuccessfulPoll).toISOString(),
      lastSocketEventAt: new Date(state.lastSocketEventAt).toISOString(),
      silenceMs,
      uptime: process.uptime(),
    });
  });

  // Configure store ID + device token (called from Angular after login). The
  // device token is minted server-side (POST /print-jobs/device-token, using the
  // staff JWT the Angular renderer already has) and handed to this Express
  // process, which has no JWT of its own — same handoff pattern as storeId.
  expressApp.post('/api/config/store', (req, res) => {
    const { storeId, deviceToken } = req.body;
    if (!storeId) {
      return res.status(400).json({ success: false, message: 'storeId is required' });
    }
    state.activeStoreId = storeId;
    if (deviceToken) {
      state.deviceToken = deviceToken;
    }
    logMessage('INFO', 'Config', `Store ID updated to: ${storeId}`);
    savePersistedData(); // Persist to disk

    // Always (re)connect with the new store/token. stopSocketService() is a safe
    // no-op when not connected — calling both unconditionally, rather than only
    // when already connected, ensures a login that follows a prior logout (which
    // disconnects) actually reconnects instead of staying stuck until a restart.
    stopSocketService();
    connectSocket();
    logMessage('INFO', 'Config', 'Push connection (re)started with new store ID');

    res.json({ success: true, message: 'Store ID configured', storeId });
  });

  // Clear store config (called on logout)
  expressApp.delete('/api/config/store', (req, res) => {
    state.activeStoreId = null;
    state.deviceToken = null;
    logMessage('INFO', 'Config', 'Store ID cleared (logout)');
    clearPersistedData(); // Remove persisted data from disk
    // Clear in-memory printer data too
    state.printerStore.printers = [];
    state.printerStore.printLogs = [];
    state.printerStore.queue = [];
    state.printerStore.nextId = 1;
    stopSocketService();
    res.json({ success: true, message: 'Store configuration cleared' });
  });

  // The Angular renderer needs this to mint a device-scoped socket token
  // (POST /print-jobs/device-token on the backend) — deviceId otherwise only
  // exists here in the Electron main process.
  expressApp.get('/api/config/device-id', (req, res) => {
    res.json({ deviceId: state.config.deviceId });
  });

  // Auto-launch status
  expressApp.get('/api/config/auto-launch', async (req, res) => {
    try {
      const enabled = await state.autoLauncher.isEnabled();
      res.json({ success: true, enabled });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Toggle auto-launch
  expressApp.post('/api/config/auto-launch', async (req, res) => {
    try {
      const { enabled } = req.body;
      if (enabled) {
        await state.autoLauncher.enable();
      } else {
        await state.autoLauncher.disable();
      }
      logMessage('INFO', 'AutoLaunch', `Auto-launch ${enabled ? 'enabled' : 'disabled'}`);
      res.json({ success: true, enabled });
    } catch (err) {
      logMessage('ERROR', 'AutoLaunch', 'Failed to toggle auto-launch', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Start push connection
  expressApp.post('/api/polling/start', (req, res) => {
    connectSocket();
    res.json({ success: true, message: 'Push connection started' });
  });

  // Stop push connection
  expressApp.post('/api/polling/stop', (req, res) => {
    stopSocketService();
    res.json({ success: true, message: 'Push connection stopped' });
  });

  // Force reconnect (for manual recovery from Angular UI)
  expressApp.post('/api/polling/restart', (req, res) => {
    logMessage('INFO', 'SocketService', 'Force reconnect requested via API');
    stopSocketService();
    setTimeout(() => {
      connectSocket();
      res.json({ success: true, message: 'Push connection force-reconnected' });
    }, 1000);
  });

  // Printers endpoints
  expressApp.get('/api/printers', (req, res) => {
    res.json(state.printerStore.printers);
  });

  expressApp.post('/api/printers/test', (req, res) => {
    const { ip, port } = req.body;
    if (!ip || !port) {
      return res.status(400).json({ success: false, message: 'IP and port required' });
    }

    const socket = new net.Socket();
    socket.setTimeout(3000);

    socket.on('connect', () => {
      socket.destroy();
      res.json({ success: true, message: `✅ Printer ${ip}:${port} is online` });
    });

    socket.on('timeout', () => {
      socket.destroy();
      res.json({ success: false, message: `❌ Connection timeout (${ip}:${port})` });
    });

    socket.on('error', () => {
      res.json({ success: false, message: `❌ Cannot connect to ${ip}:${port}` });
    });

    socket.connect(port, ip);
  });

  // USB printer test endpoint - tests connection and sends sample print
  expressApp.post('/api/printers/usb/test', (req, res) => {
    const { vendorId, productId, busNumber, deviceAddress, printerId } = req.body;

    if (!vendorId || !productId) {
      return res.status(400).json({ success: false, message: 'VendorId and ProductId required' });
    }

    try {
      const usb = require('usb');
      const devices = usb.getDeviceList();
      safeLog(`🔍 [USB TEST] Scanning ${devices.length} USB devices for VID=0x${vendorId.toString(16).toUpperCase()} PID=0x${productId.toString(16).toUpperCase()}`);

      // Find the device
      const device = devices.find(
        (d) => d.deviceDescriptor.idVendor === vendorId &&
               d.deviceDescriptor.idProduct === productId &&
               d.busNumber === busNumber &&
               d.deviceAddress === deviceAddress
      );
      safeLog(`  Device found: ${!!device} (Bus ${busNumber}, Address ${deviceAddress})`);

      if (!device) {
        return res.json({
          success: false,
          message: `❌ USB device not found (${vendorId.toString(16)}:${productId.toString(16)})`
        });
      }

      // Try to open the device to verify it's accessible
      try {
        device.open();
        device.close();

        // Device is accessible - now send test print
        const testReceipt = Buffer.concat([
          Buffer.from([0x1b, 0x40]),  // Initialize printer
          Buffer.from([0x1b, 0x61, 0x01]),  // Center alignment
          Buffer.from('PRINTER TEST\r\n'),
          Buffer.from([0x1b, 0x2d, 0x01]),  // Underline on
          Buffer.from('Sample Receipt\r\n'),
          Buffer.from([0x1b, 0x2d, 0x00]),  // Underline off
          Buffer.from('\r\n'),
          Buffer.from([0x1b, 0x61, 0x00]),  // Left alignment
          Buffer.from('Item 1..................$10.00\r\n'),
          Buffer.from('Item 2..................$20.00\r\n'),
          Buffer.from('Item 3..................$15.00\r\n'),
          Buffer.from('\r\n'),
          Buffer.from([0x1b, 0x61, 0x02]),  // Right alignment
          Buffer.from('Total: $45.00\r\n'),
          Buffer.from('\r\n'),
          Buffer.from([0x1b, 0x61, 0x01]),  // Center alignment
          Buffer.from('Thank you!\r\n'),
          Buffer.from('Date: '),
          Buffer.from(new Date().toLocaleString()),
          Buffer.from('\r\n\r\n'),
          Buffer.from([0x1d, 0x56, 0x00]),  // Cut paper
        ]);

        const jobId = `test-job-${state.printerStore.nextId++}`;
        const printJob = {
          id: jobId,
          status: 'pending',
          data: testReceipt,
          printerId: printerId || null,
          orderId: 'test',
          orderRef: 'TEST-PRINT',
          createdAt: new Date().toISOString(),
          attempts: 0,
          maxAttempts: 3,
        };

        state.printerStore.queue.push(printJob);
        state.printerStore.printLogs.push({
          ...printJob,
          action: 'created',
          timestamp: new Date().toISOString(),
        });

        // Send directly to the USB printer
        const usbPrinter = state.printerStore.printers.find(
          (p) => p.type === 'usb' && p.vendorId === vendorId && p.productId === productId
        );

        if (usbPrinter) {
          attemptUSBPrint(printJob, usbPrinter);
        }

        return res.json({
          success: true,
          message: `✅ USB printer detected and printing test receipt (${vendorId.toString(16)}:${productId.toString(16)})`,
          jobId
        });
      } catch (err) {
        return res.json({
          success: false,
          message: `❌ Cannot access USB printer: ${err.message}`
        });
      }
    } catch (error) {
      res.json({ success: false, message: `❌ USB test failed: ${error.message}` });
    }
  });

  // USB printer print test - sends a sample receipt
  expressApp.post('/api/printers/usb/print-test', (req, res) => {
    const { vendorId, productId, busNumber, deviceAddress, printerId } = req.body;

    if (!vendorId || !productId) {
      return res.status(400).json({ success: false, message: 'VendorId and ProductId required' });
    }

    try {
      // Generate simple ESC/POS test receipt
      const testReceipt = Buffer.concat([
        Buffer.from([0x1b, 0x40]),  // Initialize printer
        Buffer.from([0x1b, 0x61, 0x01]),  // Center alignment
        Buffer.from('PRINTER TEST\r\n'),
        Buffer.from([0x1b, 0x2d, 0x01]),  // Underline on
        Buffer.from('Sample Receipt\r\n'),
        Buffer.from([0x1b, 0x2d, 0x00]),  // Underline off
        Buffer.from('\r\n'),
        Buffer.from([0x1b, 0x61, 0x00]),  // Left alignment
        Buffer.from('Item 1..................$10.00\r\n'),
        Buffer.from('Item 2..................$20.00\r\n'),
        Buffer.from('Item 3..................$15.00\r\n'),
        Buffer.from('\r\n'),
        Buffer.from([0x1b, 0x61, 0x02]),  // Right alignment
        Buffer.from('Total: $45.00\r\n'),
        Buffer.from('\r\n'),
        Buffer.from([0x1b, 0x61, 0x01]),  // Center alignment
        Buffer.from('Thank you!\r\n'),
        Buffer.from('Date: '),
        Buffer.from(new Date().toLocaleString()),
        Buffer.from('\r\n\r\n'),
        Buffer.from([0x1d, 0x56, 0x00]),  // Cut paper
      ]);

      const jobId = `test-job-${state.printerStore.nextId++}`;
      const printJob = {
        id: jobId,
        status: 'pending',
        data: testReceipt,
        printerId: printerId || null,
        orderId: 'test',
        orderRef: 'TEST-PRINT',
        createdAt: new Date().toISOString(),
        attempts: 0,
        maxAttempts: 3,
      };

      state.printerStore.queue.push(printJob);
      state.printerStore.printLogs.push({
        ...printJob,
        action: 'created',
        timestamp: new Date().toISOString(),
      });

      // Send directly to the USB printer
      const usbPrinter = state.printerStore.printers.find(
        (p) => p.type === 'usb' && p.vendorId === vendorId && p.productId === productId
      );

      if (usbPrinter) {
        attemptUSBPrint(printJob, usbPrinter);
        res.json({ success: true, message: '✅ Test print sent to USB printer', jobId });
      } else {
        res.json({ success: false, message: '❌ USB printer not found in configured printers' });
      }
    } catch (error) {
      res.status(500).json({ success: false, message: `❌ Test print failed: ${error.message}` });
    }
  });

  // USB printer discovery endpoint — reports what's found; does NOT register
  // printers into the store. Registration only happens via /api/printers/add,
  // which the client calls explicitly once the user confirms a name. Auto-adding
  // here as well used to create a duplicate entry for the same physical printer.
  expressApp.post('/api/printers/usb/discover', (req, res) => {
    const usbPrinters = discoverUSBPrinters();

    res.json({
      success: true,
      discovered: usbPrinters.length,
      printers: usbPrinters
    });
  });

  expressApp.post('/api/printers/discover', (req, res) => {
    const { subnet } = req.body;
    if (!subnet) {
      return res.status(400).json({ error: 'Subnet required' });
    }

    const printers = [];
    const baseSubnet = subnet; // e.g., "192.168.1"
    const ips = [];

    // Generate IPs to scan (1-254)
    for (let i = 1; i <= 254; i++) {
      ips.push(`${baseSubnet}.${i}`);
    }

    const timeout = 300; // 300ms timeout per IP

    const checkIp = (ip) => {
      return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(timeout);

        socket.on('connect', () => {
          printers.push({ ip, port: 9100 });
          socket.destroy();
          resolve();
        });

        socket.on('timeout', () => {
          socket.destroy();
          resolve();
        });

        socket.on('error', () => {
          resolve();
        });

        socket.connect(9100, ip);
      });
    };

    // Scan all IPs in parallel with batching
    const batchSize = 20;
    const scanBatches = () => {
      if (ips.length === 0) {
        // Also scan for USB printers. Discovery only reports results — it does
        // NOT register printers into the store, that happens explicitly via
        // /api/printers/add once the user confirms a name (see USB discover
        // endpoint above for why: auto-adding here too used to double-add).
        const usbPrinters = discoverUSBPrinters();
        const allPrinters = [...printers, ...usbPrinters];

        return res.json({
          success: true,
          networkPrinters: printers,
          usbPrinters: usbPrinters,
          totalDiscovered: allPrinters.length,
          printers: allPrinters,
        });
      }

      const batch = ips.splice(0, batchSize);
      Promise.all(batch.map(checkIp)).then(() => scanBatches());
    };

    scanBatches();
  });

  // Bluetooth printer discovery endpoint
  expressApp.post('/api/printers/bluetooth/discover', async (req, res) => {
    try {
      safeLog('🔍 Starting Bluetooth printer discovery...');
      const devices = await discoverBluetoothPrinters();

      if (devices.length === 0) {
        safeLog('⚠️ No Bluetooth printers found');
        return res.json({
          success: true,
          discovered: 0,
          printers: [],
          message: 'No Bluetooth printers found'
        });
      }

      safeLog(`✅ Found ${devices.length} Bluetooth printer(s)`);
      res.json({
        success: true,
        discovered: devices.length,
        printers: devices
      });
    } catch (error) {
      safeLog(`❌ Bluetooth discovery error: ${error.message}`);
      res.json({
        success: false,
        message: `Bluetooth discovery failed: ${error.message}`
      });
    }
  });

  // Get RFCOMM channel for Bluetooth device
  expressApp.post('/api/printers/bluetooth/get-channel', async (req, res) => {
    const { macAddress } = req.body;

    if (!macAddress) {
      return res.status(400).json({
        success: false,
        message: 'MAC address required'
      });
    }

    try {
      safeLog(`🔍 Getting RFCOMM channel for ${macAddress}...`);
      const channel = await getBluetoothDeviceChannel(macAddress);

      res.json({
        success: true,
        macAddress,
        channel,
        message: `RFCOMM channel: ${channel}`
      });
    } catch (error) {
      safeLog(`❌ Error getting channel: ${error.message}`);
      res.json({
        success: false,
        message: `Failed to get channel: ${error.message}`
      });
    }
  });

  // Test Bluetooth printer connection
  expressApp.post('/api/printers/bluetooth/test', async (req, res) => {
    const { macAddress, channel = 1 } = req.body;

    if (!macAddress) {
      return res.status(400).json({
        success: false,
        message: 'MAC address required'
      });
    }

    try {
      safeLog(`🔗 Testing Bluetooth connection: ${macAddress}:${channel}...`);
      const result = await testBluetoothConnection(macAddress, channel);

      res.json(result);
    } catch (error) {
      safeLog(`❌ Bluetooth test error: ${error.message}`);
      res.json({
        success: false,
        message: `Connection test failed: ${error.message}`
      });
    }
  });

  // Add Bluetooth printer
  expressApp.post('/api/printers/bluetooth/add', (req, res) => {
    const { name, macAddress, channel = 1 } = req.body;

    if (!name || !macAddress) {
      return res.status(400).json({
        success: false,
        message: 'Name and MAC address (or device identifier) are required'
      });
    }

    // Check if this printer is already added
    const existing = state.printerStore.printers.find(p => p.macAddress === macAddress);
    if (existing) {
      return res.json({
        success: true,
        printerId: existing.id,
        message: `Bluetooth printer "${existing.name}" already exists`,
      });
    }

    const newPrinter = {
      id: `printer-${state.printerStore.nextId++}`,
      name,
      type: 'bluetooth',
      macAddress,
      channel: channel || 1,
      status: 'online',
      lastChecked: new Date().toISOString(),
    };

    state.printerStore.printers.push(newPrinter);
    savePersistedData();
    safeLog(`🔌 Bluetooth printer added: ${name} (${macAddress}:${channel})`);

    res.json({
      success: true,
      printerId: newPrinter.id,
      message: `Bluetooth printer "${name}" added successfully`
    });
  });

  expressApp.post('/api/printers/add', (req, res) => {
    const { name, ip, port, type, vendorId, productId, busNumber, deviceAddress } = req.body;

    // Validate based on printer type
    if (type === 'usb') {
      if (!name || !vendorId || !productId || busNumber === undefined || !deviceAddress === undefined) {
        return res.status(400).json({ success: false, message: 'USB printer data required' });
      }
    } else {
      if (!name || !ip || !port) {
        return res.status(400).json({ success: false, message: 'Name, IP, and port required' });
      }
    }

    const newPrinter = {
      id: `printer-${state.printerStore.nextId++}`,
      name,
      type: type || 'network',
      status: 'online',
      lastChecked: new Date().toISOString(),
    };

    // Add network-specific fields
    if (type !== 'usb') {
      newPrinter.ip = ip;
      newPrinter.port = port;
    } else {
      // Add USB-specific fields
      newPrinter.vendorId = vendorId;
      newPrinter.productId = productId;
      newPrinter.busNumber = busNumber;
      newPrinter.deviceAddress = deviceAddress;
    }

    state.printerStore.printers.push(newPrinter);
    savePersistedData();
    safeLog(`${type === 'usb' ? '🔌' : '🞨'} Printer added:`, newPrinter);

    // Check status immediately for network printers
    if (type !== 'usb') {
      checkPrinterStatus(newPrinter);
    }

    res.json({ success: true, printerId: newPrinter.id });
  });

  expressApp.delete('/api/printers/:id', (req, res) => {
    const { id } = req.params;
    state.printerStore.printers = state.printerStore.printers.filter((p) => p.id !== id);
    savePersistedData();
    res.json({ success: true });
  });

  expressApp.post('/api/print', (req, res) => {
    const { data, printerId, orderId, orderRef } = req.body;

    if (!data) {
      return res.status(400).json({ success: false, error: 'Print data required' });
    }

    try {
      // Decode base64 data if provided in that format
      let receiptData = data;
      if (typeof data === 'string' && data.startsWith('data:')) {
        // Handle data URL format
        receiptData = atob(data.split(',')[1]);
      } else if (typeof data === 'string') {
        // Try to decode as base64
        try {
          receiptData = Buffer.from(data, 'base64').toString('utf8');
        } catch (e) {
          receiptData = data; // Use as-is if not base64
        }
      }

      const jobId = `job-${state.printerStore.nextId++}`;
      const printJob = {
        id: jobId,
        status: 'pending',
        data: receiptData,
        printerId: printerId || null,
        orderId: orderId || 'unknown',
        orderRef: orderRef || 'N/A',
        createdAt: new Date().toISOString(),
        attempts: 0,
        maxAttempts: 3,
      };

      state.printerStore.queue.push(printJob);
      state.printerStore.printLogs.push({
        ...printJob,
        action: 'created',
        timestamp: new Date().toISOString(),
      });

      safeLog(`📋 [PRINT JOB] Created: ${jobId} for Order: ${orderRef}`);

      // If printerId specified, try to print directly to that printer
      if (printerId) {
        const printer = state.printerStore.printers.find((p) => p.id === printerId);
        if (printer) {
          attemptPrint(printJob, printer);
        }
      } else {
        // Auto-select first available online printer
        const availablePrinter = state.printerStore.printers.find((p) => p.status === 'online');
        if (availablePrinter) {
          attemptPrint(printJob, availablePrinter);
        }
      }

      res.json({ success: true, jobId });
    } catch (error) {
      console.error('❌ [PRINT JOB] Error:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  expressApp.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const logs = state.printerStore.printLogs.slice(-limit);
    res.json(logs);
  });

  expressApp.delete('/api/logs', (req, res) => {
    state.printerStore.printLogs = [];
    res.json({ success: true, message: 'All logs cleared' });
  });

  expressApp.get('/api/queue/stats', (req, res) => {
    const logs = state.printerStore.printLogs;
    const stats = {
      total: logs.length,
      pending: logs.filter((l) => l.status === 'pending').length,
      processing: logs.filter((l) => l.status === 'processing').length,
      printed: logs.filter((l) => l.status === 'printed' || l.status === 'success').length,
      failed: logs.filter((l) => l.status === 'failed').length,
      successRate: logs.length > 0
        ? Math.round(((logs.filter((l) => l.status === 'success' || l.status === 'printed').length / logs.length) * 100))
        : 0,
    };
    res.json(stats);
  });

  state.expressServer = expressApp.listen(4001, () => {
    safeLog('Express server running on http://localhost:4001');
  });
}

module.exports = { startExpressServer };
