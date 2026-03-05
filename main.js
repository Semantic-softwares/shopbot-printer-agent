const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const AutoLaunch = require('auto-launch');
const { autoUpdater } = require('electron-updater');
require('dotenv').config();

// Auto-launch on system startup
const autoLauncher = new AutoLaunch({
  name: 'ShopBot Printer',
  isHidden: false,
});

let mainWindow = null;
let expressServer = null;
let pollingActive = false;
let pollingInterval = null;
let isCurrentlyPolling = false; // Guard against overlapping poll cycles

// In-memory storage
const printerStore = {
  printers: [],
  printLogs: [],
  queue: [],
  nextId: 1,
};

// Active store ID — set by Angular login, replaces hardcoded value
let activeStoreId = null;

// Configuration from .env
const config = {
  apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
  branchId: process.env.BRANCH_ID || 'default-branch',
  deviceId: process.env.DEVICE_ID || `printer-${Date.now()}`,
  pollInterval: parseInt(process.env.POLL_INTERVAL) || 3000,
  logLevel: process.env.LOG_LEVEL || 'INFO',
};

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// Safe logger that handles broken pipes gracefully
function safeLog(...args) {
  try {
    if (process.stdout.writable) {
      console.log(...args);
    }
  } catch (err) {
    // Ignore EPIPE and other stream errors
    if (err.code !== 'EPIPE') {
      // Re-throw if it's not a pipe error
      // But silently ignore for now
    }
  }
}

// Logger with levels
function logMessage(level, context, message, data = '') {
  const timestamp = new Date().toISOString();
  const levelEmoji = {
    DEBUG: '🔍',
    INFO: '📋',
    WARN: '⚠️',
    ERROR: '❌',
  }[level] || '•';

  const levelValue = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }[level];
  const configLevelValue = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }[config.logLevel];

  if (levelValue >= configLevelValue) {
    safeLog(`${levelEmoji} [${timestamp}] [${level}] [${context}] ${message}`, data || '');
  }
}

// ============================================================
// POLLING SYSTEM - Backend Integration
// ============================================================

/**
 * Poll backend for pending print jobs
 */
async function pollPrintJobs() {
  // Prevent overlapping polls — if previous cycle is still processing (e.g. slow BLE print), skip
  if (isCurrentlyPolling) {
    logMessage('DEBUG', 'PollingService', 'Previous poll still running — skipping this cycle');
    return;
  }

  isCurrentlyPolling = true;
  try {
    // Use the store ID configured via login, fall back to env, or skip if none
    const storeId = activeStoreId || process.env.STORE_ID;
    
    if (!storeId) {
      logMessage('DEBUG', 'PollingService', 'No store ID configured — skipping poll. Login required.');
      return;
    }
    
    const url = `${config.apiBaseUrl}/print-jobs/polling/pending`;
    const response = await axios.get(url, {
      params: {
        storeId: storeId,
        status: 'pending',
        limit: 10,
      },
      headers: {
        'X-Device-Id': config.deviceId,
        'X-Store-Id': storeId,
      },
      timeout: 5000,
    });

    if (response.data.success && response.data.data.length > 0) {
      logMessage('INFO', 'PollingService', `Found ${response.data.data.length} pending job(s)`);

      // Process each job sequentially
      for (const job of response.data.data) {
        await processBackendJob(job);
      }
    } else {
      logMessage('DEBUG', 'PollingService', 'No pending jobs');
    }
  } catch (error) {
    logMessage('ERROR', 'PollingService', 'Failed to poll jobs', error.message);
  } finally {
    isCurrentlyPolling = false;
  }
}

/**
 * Process a single job from backend
 */
async function processBackendJob(job) {
  logMessage('INFO', 'JobProcessor', `Processing job: ${job._id} (Type: ${job.type}, Order: ${job.orderMetadata?.reference || job._id})`);

  try {
    // Step 1: Lock job
    const lockSuccess = await lockBackendJob(job._id);
    if (!lockSuccess) {
      logMessage('WARN', 'JobProcessor', `Could not lock job ${job._id}, another device may have locked it`);
      return;
    }

    // Step 2: Find the correct printer using printerDetails from the job
    logMessage('DEBUG', 'JobProcessor', `Looking for printer. Available printers: ${printerStore.printers.length}`);
    logMessage('DEBUG', 'JobProcessor', `Job type: ${job.type}, Printer details: ${JSON.stringify(job.printerDetails || {})}`);
    
    let printer = null;
    const pd = job.printerDetails;

    // Strategy 1: Match by connection details from printerDetails (most reliable)
    if (pd && pd.connection) {
      const connType = pd.connectionType || '';

      if ((connType === 'usb-raw' || connType === 'usb') && pd.connection.vendorId && pd.connection.productId) {
        // Match USB printer by vendorId + productId
        printer = printerStore.printers.find(
          (p) => p.type === 'usb' && p.vendorId === pd.connection.vendorId && p.productId === pd.connection.productId
        );
        if (printer) {
          logMessage('DEBUG', 'JobProcessor', `Matched USB printer by VID/PID: ${printer.name}`);
        }
      } else if (connType === 'bluetooth' && pd.connection.macAddress) {
        // Match Bluetooth printer by macAddress
        printer = printerStore.printers.find(
          (p) => p.type === 'bluetooth' && p.macAddress === pd.connection.macAddress
        );
        if (printer) {
          logMessage('DEBUG', 'JobProcessor', `Matched Bluetooth printer by MAC: ${printer.name}`);
        }
      } else if (pd.connection.ip) {
        // Match network printer by IP
        printer = printerStore.printers.find(
          (p) => p.type === 'network' && p.ip === pd.connection.ip
        );
        if (printer) {
          logMessage('DEBUG', 'JobProcessor', `Matched network printer by IP: ${printer.name}`);
        }
      }
    }

    // Strategy 2: Match by printer name as fallback
    if (!printer && pd && pd.name) {
      printer = printerStore.printers.find(
        (p) => p.name.toLowerCase() === pd.name.toLowerCase()
      );
      if (printer) {
        logMessage('DEBUG', 'JobProcessor', `Matched printer by name: ${printer.name}`);
      }
    }

    // NO fallback to random printers — each job must go to its designated printer
    if (!printer) {
      const printerName = pd ? pd.name : 'unknown';
      const connType = pd ? pd.connectionType : 'unknown';
      logMessage('WARN', 'JobProcessor', `⏭️ No matching local printer for "${printerName}" (${connType}). Job ${job._id} will remain pending.`);
      logMessage('DEBUG', 'JobProcessor', `Registered printers: ${printerStore.printers.map(p => `${p.name}(${p.type})`).join(', ')}`);
      // Release the lock so another device with the right printer can pick it up
      await failBackendJob(job._id, `No matching printer found for "${printerName}" (${connType}). This device does not have this printer connected.`);
      return;
    }

    logMessage('INFO', 'JobProcessor', `✅ Using printer: ${printer.name} (${printer.type}) for ${job.type} job`);

    // Step 3: Parse ESC/POS payload
    if (!job.receipt) {
      logMessage('ERROR', 'JobProcessor', `No receipt data in job`);
      await failBackendJob(job._id, 'No receipt data provided');
      return;
    }

    logMessage('DEBUG', 'JobProcessor', `Parsing receipt payload (${typeof job.receipt.data})`);
    const payload = parseReceiptPayload(job.receipt.data || job.receipt);
    if (!payload) {
      logMessage('ERROR', 'JobProcessor', `Failed to parse receipt payload`);
      await failBackendJob(job._id, 'Failed to parse receipt payload');
      return;
    }

    logMessage('DEBUG', 'JobProcessor', `✅ Receipt parsed: ${payload.length} bytes`);

    // Step 4: Send to printer
    logMessage('INFO', 'JobProcessor', `📤 Sending to printer: ${printer.name}...`);
    const printResult = await sendToPrinterDevice(printer, payload);
    
    if (!printResult.success) {
      logMessage('ERROR', 'JobProcessor', `📤 Print send failed: ${printResult.error}`);
      await failBackendJob(job._id, printResult.error || 'Unknown print error');
      return;
    }

    logMessage('SUCCESS', 'JobProcessor', `✅ Data sent to printer: ${printer.name}`);

    // Step 5: Mark as complete
    const completeSuccess = await completeBackendJob(job._id);
    if (completeSuccess) {
      logMessage('INFO', 'JobProcessor', `✅ Job completed: ${job._id}`);
    } else {
      logMessage('WARN', 'JobProcessor', `Job printed but failed to mark complete: ${job._id}`);
    }
  } catch (error) {
    logMessage('ERROR', 'JobProcessor', `Unexpected error: ${error.message}`, error);
    try {
      await failBackendJob(job._id, error.message);
    } catch (failError) {
      logMessage('ERROR', 'JobProcessor', `Also failed to mark job as failed`, failError.message);
    }
  }
}

/**
 * Lock job on backend (atomic operation)
 */
async function lockBackendJob(jobId) {
  try {
    const url = `${config.apiBaseUrl}/print-jobs/${jobId}/lock`;
    const response = await axios.patch(
      url,
      { deviceId: config.deviceId },
      {
        headers: {
          'X-Device-Id': config.deviceId,
          'X-Branch-Id': config.branchId,
        },
        timeout: 5000,
      }
    );

    if (response.data.success) {
      logMessage('DEBUG', 'JobLocking', `🔒 Job locked: ${jobId}`);
      return true;
    }

    return false;
  } catch (error) {
    if (error.response?.status === 409 || error.response?.status === 400) {
      logMessage('DEBUG', 'JobLocking', `Job ${jobId} already locked or unavailable — skipping`);
      return false;
    }
    logMessage('WARN', 'JobLocking', `Error locking job ${jobId}`, error.message);
    return false;
  }
}

/**
 * Complete job on backend
 */
async function completeBackendJob(jobId) {
  try {
    const url = `${config.apiBaseUrl}/print-jobs/${jobId}/complete`;
    const response = await axios.patch(
      url,
      { deviceId: config.deviceId },
      {
        headers: {
          'X-Device-Id': config.deviceId,
          'X-Branch-Id': config.branchId,
        },
        timeout: 5000,
      }
    );

    return response.data.success;
  } catch (error) {
    logMessage('ERROR', 'JobCompletion', `Error completing job ${jobId}`, error.message);
    return false;
  }
}

/**
 * Fail job on backend
 */
async function failBackendJob(jobId, errorMessage) {
  try {
    const url = `${config.apiBaseUrl}/print-jobs/${jobId}/fail`;
    const response = await axios.patch(
      url,
      {
        errorMessage,
        deviceId: config.deviceId,
      },
      {
        headers: {
          'X-Device-Id': config.deviceId,
          'X-Branch-Id': config.branchId,
        },
        timeout: 5000,
      }
    );

    if (response.data.success) {
      const data = response.data.data;
      if (data?.retryable) {
        logMessage('INFO', 'JobFailure', `Job will retry (attempt ${data.retryCount}/3)`);
      } else {
        logMessage('WARN', 'JobFailure', `Job failed permanently (max retries exceeded)`);
      }
    }

    return response.data.success;
  } catch (error) {
    logMessage('ERROR', 'JobFailure', `Error failing job ${jobId}`, error.message);
    return false;
  }
}

/**
 * Parse receipt payload from Base64 or hex
 */
function parseReceiptPayload(receipt) {
  try {
    // If it's base64, decode it
    if (/^[A-Za-z0-9+/=]+$/.test(receipt)) {
      try {
        return Buffer.from(receipt, 'base64');
      } catch {
        // Not valid base64
      }
    }

    // If it's hex string, convert to buffer
    if (/^[0-9A-Fa-f]*$/.test(receipt)) {
      return Buffer.from(receipt, 'hex');
    }

    // Assume it's a string payload
    return Buffer.from(receipt, 'utf8');
  } catch (error) {
    logMessage('ERROR', 'PayloadParser', 'Error parsing receipt payload', error.message);
    return null;
  }
}

/**
 * Send ESC/POS data to printer device
 */
async function sendToPrinterDevice(printer, data) {
  if (printer.type === 'usb') {
    return await sendToUSBPrinter(data, printer);
  } else if (printer.type === 'bluetooth') {
    return await sendToBluetoothPrinterDirect(data, printer);
  } else {
    return await sendToNetworkPrinter(data, printer);
  }
}

/**
 * Send to network printer (TCP 9100)
 */
function sendToNetworkPrinter(data, printer) {
  return new Promise((resolve) => {
    const net = require('net');
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
 * Send to USB printer
 */
async function sendToUSBPrinter(data, printer) {
  return new Promise((resolve) => {
    try {
      const usb = require('usb');

      logMessage('DEBUG', 'USBPrint', `🔌 Finding USB device: VID=0x${printer.vendorId.toString(16).toUpperCase()} PID=0x${printer.productId.toString(16).toUpperCase()}`);

      const device = usb.getDeviceList().find(
        (d) =>
          d.deviceDescriptor.idVendor === printer.vendorId &&
          d.deviceDescriptor.idProduct === printer.productId &&
          d.busNumber === printer.busNumber &&
          d.deviceAddress === printer.deviceAddress
      );

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
      logMessage('ERROR', 'USBPrint', `USB printer error: ${printer.name}`, error.message);
      resolve({ success: false, error: error.message });
    }
  });
}

/**
 * Send ESC/POS data to Bluetooth printer via Noble BLE
 * Used by the polling system for backend print jobs
 */
async function sendToBluetoothPrinterDirect(data, printer) {
  return new Promise((resolve) => {
    let noble;
    try {
      noble = require('@abandonware/noble').default || require('@abandonware/noble');
    } catch (e) {
      logMessage('ERROR', 'BluetoothPrint', 'Noble library not available');
      return resolve({ success: false, error: 'Bluetooth library not available' });
    }

    const scanTimeout = setTimeout(() => {
      noble.stopScanning();
      noble.removeAllListeners('discover');
      logMessage('ERROR', 'BluetoothPrint', `Device ${printer.macAddress} not found within 10s`);
      resolve({ success: false, error: 'Bluetooth device not found (scan timeout)' });
    }, 10000);

    const onDiscover = (peripheral) => {
      const peripheralId = peripheral.address && peripheral.address !== '' ? peripheral.address : peripheral.id;
      if (peripheralId === printer.macAddress || peripheral.address === printer.macAddress || peripheral.id === printer.macAddress) {
        clearTimeout(scanTimeout);
        noble.stopScanning();
        noble.removeListener('discover', onDiscover);

        logMessage('INFO', 'BluetoothPrint', `Found ${printer.name}, connecting...`);

        const doConnect = () => {
          peripheral.connect((err) => {
            if (err) {
              logMessage('ERROR', 'BluetoothPrint', `Connection error: ${err.message}`);
              return resolve({ success: false, error: err.message });
            }

          peripheral.discoverAllServicesAndCharacteristics((err, services, characteristics) => {
            if (err) {
              peripheral.disconnect();
              logMessage('ERROR', 'BluetoothPrint', `Service discovery error: ${err.message}`);
              return resolve({ success: false, error: err.message });
            }

            const writableChar = characteristics.find(c => {
              const props = c.properties || [];
              return props.includes('write') || props.includes('writeWithoutResponse');
            });

            if (!writableChar) {
              peripheral.disconnect();
              logMessage('ERROR', 'BluetoothPrint', 'No writable characteristic found');
              return resolve({ success: false, error: 'No writable BLE characteristic found' });
            }

            // Subscribe to RX notifications first (required for BLE UART)
            const notifyChar = characteristics.find(c => {
              const props = c.properties || [];
              return (props.includes('notify') || props.includes('indicate')) && c.uuid !== writableChar.uuid;
            });

            const sendData = () => {
              const props = writableChar.properties || [];
              const useWithoutResponse = props.includes('writeWithoutResponse');
              const chunkSize = 20;
              const chunks = [];
              for (let i = 0; i < data.length; i += chunkSize) {
                chunks.push(data.slice(i, i + chunkSize));
              }

              logMessage('INFO', 'BluetoothPrint', `Sending ${chunks.length} chunks (${data.length} bytes) to ${printer.name}...`);

              let chunkIndex = 0;
              const sendNextChunk = () => {
                if (chunkIndex >= chunks.length) {
                  logMessage('INFO', 'BluetoothPrint', `All ${chunks.length} chunks sent to ${printer.name}`);
                  setTimeout(() => {
                    peripheral.disconnect();
                    resolve({ success: true });
                  }, 2000);
                  return;
                }

                writableChar.write(chunks[chunkIndex], useWithoutResponse, (writeErr) => {
                  if (writeErr) {
                    logMessage('ERROR', 'BluetoothPrint', `Write error on chunk ${chunkIndex + 1}: ${writeErr.message}`);
                    peripheral.disconnect();
                    return resolve({ success: false, error: writeErr.message });
                  }
                  chunkIndex++;
                  setTimeout(sendNextChunk, 50);
                });
              };

              sendNextChunk();
            };

            if (notifyChar) {
              logMessage('DEBUG', 'BluetoothPrint', `Subscribing to RX notifications on ${notifyChar.uuid}...`);
              notifyChar.subscribe((subErr) => {
                if (subErr) {
                  logMessage('WARN', 'BluetoothPrint', `RX subscribe error: ${subErr.message} (continuing)`);
                } else {
                  logMessage('DEBUG', 'BluetoothPrint', 'Subscribed to RX notifications');
                }
                setTimeout(sendData, 200);
              });
            } else {
              sendData();
            }
          });
        });
        };

        // If peripheral is already connected, disconnect first then reconnect cleanly
        if (peripheral.state === 'connected') {
          logMessage('WARN', 'BluetoothPrint', 'Peripheral already connected, disconnecting first...');
          peripheral.disconnect(() => {
            setTimeout(doConnect, 500);
          });
        } else {
          doConnect();
        }
      }
    };

    noble.on('discover', onDiscover);
    logMessage('DEBUG', 'BluetoothPrint', `Scanning for ${printer.macAddress}...`);
    noble.startScanning([], true);
  });
}

/**
 * Start polling for backend jobs
 */
function startBackendPolling() {
  if (pollingActive) {
    logMessage('WARN', 'Polling', 'Polling already active');
    return;
  }

  pollingActive = true;
  logMessage('INFO', 'Polling', `🚀 Starting backend polling (${config.pollInterval}ms)`);
  logMessage('INFO', 'Polling', `API URL: ${config.apiBaseUrl}`);
  logMessage('INFO', 'Polling', `Branch ID: ${config.branchId}`);
  logMessage('INFO', 'Polling', `Device ID: ${config.deviceId}`);

  // Initial poll
  pollPrintJobs();

  // Regular polling
  pollingInterval = setInterval(() => {
    pollPrintJobs();
  }, config.pollInterval);
}

/**
 * Stop polling
 */
function stopBackendPolling() {
  if (!pollingActive) {
    return;
  }

  pollingActive = false;
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }

  logMessage('INFO', 'Polling', '🛑 Backend polling stopped');
}
function checkPrinterStatus(printer) {
  // Skip USB printers - they don't have network connectivity checks
  if (printer.type === 'usb') {
    printer.status = 'online';
    printer.lastChecked = new Date().toISOString();
    return;
  }

  // Only check network printers with IP and port
  if (!printer.ip || !printer.port) {
    return;
  }

  const net = require('net');
  const socket = new net.Socket();
  socket.setTimeout(2000);

  // Flag to track if socket is already handled
  let handled = false;

  const handleComplete = (status, message) => {
    if (handled) return;
    handled = true;
    
    printer.status = status;
    printer.lastChecked = new Date().toISOString();
    
    // Safely destroy the socket
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
    // Socket closed, ensure we've marked it as handled
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

// Discover USB printers
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
    // Silently ignore USB errors - avoid EPIPE on broken pipes
    return [];
  }
}

// Bluetooth discovery function using Noble
async function discoverBluetoothPrinters() {
  try {
    let noble;
    try {
      noble = require('@abandonware/noble').default || require('@abandonware/noble');
    } catch (e) {
      safeLog('⚠️ [BLUETOOTH] Noble library not available, showing mock devices');
      return getMockBluetoothDevices();
    }

    safeLog('🔍 [BLUETOOTH DISCOVERY] Starting Noble BLE/Classic scan...');

    return new Promise((resolve) => {
      const discoveredDevices = [];
      let scanTimeout;

      const cleanup = () => {
        try {
          noble.stopScanning();
        } catch (e) { /* ignore */ }
        noble.removeAllListeners('discover');
        noble.removeAllListeners('stateChange');
      };

      // Handle Noble state
      const onStateChange = (state) => {
        safeLog(`📱 [BLUETOOTH] Noble state: ${state}`);
        
        if (state === 'poweredOn') {
          safeLog('🔍 [BLUETOOTH] Starting scan for ALL nearby devices...');
          noble.startScanning([], true);
          
          // Scan for 10 seconds then return results
          scanTimeout = setTimeout(() => {
            cleanup();
            safeLog(`🎯 [BLUETOOTH] Scan complete. Found ${discoveredDevices.length} device(s)`);
            resolve(discoveredDevices);
          }, 10000);
        } else {
          if (scanTimeout) clearTimeout(scanTimeout);
          cleanup();
          
          safeLog(`⚠️ [BLUETOOTH] Bluetooth not available (state: ${state})`);
          resolve([]);
        }
      };

      const onDiscover = (peripheral) => {
        const name = peripheral.advertisement?.localName || peripheral.advertisement?.serviceData?.[0]?.uuid || '';
        // On macOS, peripheral.address is empty for BLE — try every possible identifier
        const rawAddress = peripheral.address && peripheral.address !== '' && peripheral.address !== 'unknown'
          ? peripheral.address
          : null;
        const peripheralId = rawAddress || peripheral.id || peripheral.uuid || null;
        const rssi = peripheral.rssi;

        // Generate a stable unique key: use identifier if available, otherwise name + a hash
        const deviceKey = peripheralId || `${name}-${peripheral._noble?._bindings?._peripherals?.[peripheral.id]?.uuid || Math.random().toString(36).slice(2)}`;

        safeLog(`📡 [BLUETOOTH] Discovered: ${name || '(unnamed)'} (id=${peripheral.id || 'none'}, addr=${peripheral.address || 'none'}) - RSSI: ${rssi}`);

        // Dedup by device key
        if (!discoveredDevices.find(d => d._key === deviceKey)) {
          discoveredDevices.push({
            id: deviceKey,
            _key: deviceKey,
            name: name || `Unknown Device (${deviceKey.slice(0, 8)})`,
            macAddress: peripheralId || deviceKey,
            rssi,
            type: 'bluetooth',
          });
          safeLog(`✅ [BLUETOOTH] Added device: ${name || '(unnamed)'} (${peripheralId || deviceKey})`);
        }
      };

      noble.on('stateChange', onStateChange);
      noble.on('discover', onDiscover);

      // Check current state
      if (noble.state === 'poweredOn') {
        noble.emit('stateChange', 'poweredOn');
      }
    });
  } catch (error) {
    safeLog('❌ [BLUETOOTH] Discovery error:', error.message);
    return [];
  }
}

// Mock Bluetooth devices for testing/development
function getMockBluetoothDevices() {
  safeLog('📋 [BLUETOOTH] Returning mock devices for development/testing');
  return [
    {
      id: 'mock-1',
      name: 'Kitchen Printer (XP-58)',
      macAddress: '50:05:EB:40:C3:A0',
      rssi: -45,
      type: 'bluetooth',
      isMock: true,
    },
    {
      id: 'mock-2',
      name: 'Receipt Printer Thermal',
      macAddress: '00:1A:2B:3C:4D:5E',
      rssi: -52,
      type: 'bluetooth',
      isMock: true,
    },
    {
      id: 'mock-3',
      name: 'POS Printer 80mm',
      macAddress: 'AC:3F:A4:9C:27:B1',
      rssi: -38,
      type: 'bluetooth',
      isMock: true,
    },
  ];
}

// Get RFCOMM channel for Bluetooth device (Noble uses GATT, default to channel 1 for SPP)
async function getBluetoothDeviceChannel(macAddress) {
  try {
    safeLog(`🔍 [BLUETOOTH CHANNEL] Getting channel for ${macAddress}...`);
    
    // For mock devices
    if (macAddress.includes('mock-')) {
      return 1;
    }

    let noble;
    try {
      noble = require('@abandonware/noble').default || require('@abandonware/noble');
    } catch (e) {
      safeLog('⚠️ [BLUETOOTH CHANNEL] Noble not available, using default channel 1');
      return 1;
    }

    // Noble uses GATT services, not RFCOMM channels
    // For SPP (Serial Port Profile), we typically use channel 1
    // This is a simplified approach - real implementation might scan for SPP services
    safeLog(`📍 [BLUETOOTH CHANNEL] Using default SPP channel 1 for ${macAddress}`);
    return 1;
  } catch (error) {
    safeLog('❌ [BLUETOOTH CHANNEL] Error:', error.message);
    return 1;
  }
}

// Test Bluetooth connection using Noble
async function testBluetoothConnection(macAddress, channel = 1) {
  try {
    safeLog(`🔗 [BLUETOOTH TEST] Testing ${macAddress}:${channel}...`);

    // For mock devices
    if (macAddress.includes('mock-')) {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            success: true,
            message: `✅ Connection test (mock) successful to ${macAddress}:${channel}`,
            macAddress,
            channel,
          });
        }, 1000);
      });
    }

    let noble;
    try {
      noble = require('@abandonware/noble').default || require('@abandonware/noble');
    } catch (e) {
      safeLog('⚠️ [BLUETOOTH TEST] Noble not available, simulating connection test');
      return {
        success: true,
        message: `✅ Would test connection to ${macAddress}:${channel}`,
        macAddress,
        channel,
      };
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        safeLog(`⏱️ [BLUETOOTH TEST] Timeout connecting to ${macAddress}`);
        resolve({ 
          success: false, 
          message: 'Connection timeout - printer may be out of range',
          macAddress,
          channel,
        });
      }, 10000);

      const onDiscover = (peripheral) => {
        // Match by address OR by peripheral.id (UUID on macOS)
        const peripheralId = peripheral.address && peripheral.address !== '' ? peripheral.address : peripheral.id;
        if (peripheralId === macAddress || peripheral.address === macAddress || peripheral.id === macAddress) {
          safeLog(`📡 [BLUETOOTH TEST] Found device ${macAddress}`);
          clearTimeout(timeout);
          noble.stopScanning();
          noble.removeListener('discover', onDiscover);

          const doConnect = () => {
          // Try to connect and discover services
          peripheral.connect((err) => {
            if (err) {
              safeLog(`❌ [BLUETOOTH TEST] Connection error: ${err.message}`);
              resolve({ 
                success: false, 
                message: `Connection failed: ${err.message}`,
                macAddress,
                channel,
              });
              return;
            }

            safeLog(`✅ [BLUETOOTH TEST] Connected to ${macAddress}`);

            // Generate test receipt
            const testReceipt = Buffer.concat([
              Buffer.from([0x1b, 0x40]),           // Initialize printer
              Buffer.from([0x1b, 0x61, 0x01]),     // Center alignment
              Buffer.from([0x1b, 0x45, 0x01]),     // Bold on
              Buffer.from('PRINTER TEST\n'),
              Buffer.from([0x1b, 0x45, 0x00]),     // Bold off
              Buffer.from('--------------------------------\n'),
              Buffer.from([0x1b, 0x61, 0x00]),     // Left alignment
              Buffer.from('Item 1.................$10.00\n'),
              Buffer.from('Item 2.................$20.00\n'),
              Buffer.from('Item 3.................$15.00\n'),
              Buffer.from('--------------------------------\n'),
              Buffer.from([0x1b, 0x61, 0x02]),     // Right alignment
              Buffer.from([0x1b, 0x45, 0x01]),     // Bold on
              Buffer.from('Total: $45.00\n'),
              Buffer.from([0x1b, 0x45, 0x00]),     // Bold off
              Buffer.from('\n'),
              Buffer.from([0x1b, 0x61, 0x01]),     // Center alignment
              Buffer.from('Thank you!\n'),
              Buffer.from(`${new Date().toLocaleString()}\n`),
              Buffer.from('\n\n\n'),
              Buffer.from([0x1d, 0x56, 0x00]),     // Cut paper
            ]);

            // Discover all services and characteristics to find a writable one
            peripheral.discoverAllServicesAndCharacteristics((err, services, characteristics) => {
              if (err) {
                safeLog(`❌ [BLUETOOTH TEST] Service discovery error: ${err.message}`);
                peripheral.disconnect();
                resolve({ 
                  success: false, 
                  message: `Connected but service discovery failed: ${err.message}`,
                  macAddress,
                  channel,
                });
                return;
              }

              safeLog(`✅ [BLUETOOTH TEST] Found ${services.length} service(s), ${characteristics.length} characteristic(s)`);

              // Log ALL services and characteristics for debugging
              services.forEach((svc, i) => {
                safeLog(`  📦 Service [${i}]: ${svc.uuid}`);
              });
              characteristics.forEach((c, i) => {
                safeLog(`  📝 Char [${i}]: ${c.uuid} — properties: ${(c.properties || []).join(', ')}`);
              });

              // Find a writable characteristic (TX — for sending data to the printer)
              const writableChar = characteristics.find(c => {
                const props = c.properties || [];
                return props.includes('write') || props.includes('writeWithoutResponse');
              });

              if (!writableChar) {
                safeLog(`⚠️ [BLUETOOTH TEST] No writable characteristic found`);
                peripheral.disconnect();
                resolve({ 
                  success: true, 
                  message: `✅ Connected to ${macAddress} but no writable characteristic found for printing. The device may use a different protocol.`,
                  macAddress,
                  channel,
                });
                return;
              }

              // Find a notify/indicate characteristic (RX — for receiving data from the printer)
              // CRITICAL: Many BLE UART devices (ISSC, Nordic UART, etc.) require you to
              // subscribe to notifications on the RX characteristic BEFORE they will process
              // data written to the TX characteristic. Without this, data is silently discarded.
              const notifyChar = characteristics.find(c => {
                const props = c.properties || [];
                return (props.includes('notify') || props.includes('indicate')) && c.uuid !== writableChar.uuid;
              });

              const proceedWithWrite = () => {
                safeLog(`📤 [BLUETOOTH TEST] Writing test receipt (${testReceipt.length} bytes) to characteristic ${writableChar.uuid}...`);
                safeLog(`📤 [BLUETOOTH TEST] Characteristic properties: ${(writableChar.properties || []).join(', ')}`);

                // For BLE UART printers, writeWithoutResponse is typically preferred (faster throughput)
                const props = writableChar.properties || [];
                const useWithoutResponse = props.includes('writeWithoutResponse');
                safeLog(`📤 [BLUETOOTH TEST] Write mode: ${useWithoutResponse ? 'writeWithoutResponse' : 'write (with response)'}`);

                // BLE default MTU is 23 bytes (20 payload). Use 20-byte chunks for maximum compatibility.
                // Larger chunks can silently fail if MTU negotiation didn't happen.
                const chunkSize = 20;
                const chunks = [];
                for (let i = 0; i < testReceipt.length; i += chunkSize) {
                  chunks.push(testReceipt.slice(i, i + chunkSize));
                }

                safeLog(`📤 [BLUETOOTH TEST] Sending ${chunks.length} chunks of ${chunkSize} bytes...`);

                let chunkIndex = 0;
                const sendNextChunk = () => {
                  if (chunkIndex >= chunks.length) {
                    safeLog(`✅ [BLUETOOTH TEST] All ${chunks.length} chunks sent successfully!`);
                    // Give the printer time to process before disconnecting
                    setTimeout(() => {
                      peripheral.disconnect();
                      resolve({
                        success: true,
                        message: `✅ Test print sent to ${macAddress}`,
                        macAddress,
                        channel,
                      });
                    }, 2000);
                    return;
                  }

                  writableChar.write(chunks[chunkIndex], useWithoutResponse, (writeErr) => {
                    if (writeErr) {
                      safeLog(`❌ [BLUETOOTH TEST] Write error on chunk ${chunkIndex + 1}: ${writeErr.message}`);
                      peripheral.disconnect();
                      resolve({
                        success: false,
                        message: `Connected but write failed on chunk ${chunkIndex + 1}: ${writeErr.message}`,
                        macAddress,
                        channel,
                      });
                      return;
                    }
                    chunkIndex++;
                    // 50ms delay between chunks to let the printer buffer process
                    setTimeout(sendNextChunk, 50);
                  });
                };

                sendNextChunk();
              };

              // Step 1: Subscribe to notifications on the RX characteristic (if found)
              if (notifyChar) {
                safeLog(`📡 [BLUETOOTH TEST] Subscribing to notifications on RX characteristic ${notifyChar.uuid}...`);
                
                notifyChar.on('data', (data) => {
                  safeLog(`📥 [BLUETOOTH TEST] Received ${data.length} bytes from printer: ${data.toString('hex')}`);
                });

                notifyChar.subscribe((err) => {
                  if (err) {
                    safeLog(`⚠️ [BLUETOOTH TEST] Notification subscribe error: ${err.message} (continuing anyway)`);
                  } else {
                    safeLog(`✅ [BLUETOOTH TEST] Subscribed to RX notifications`);
                  }
                  // Short delay after subscribing to let the device settle
                  setTimeout(proceedWithWrite, 200);
                });
              } else {
                safeLog(`⚠️ [BLUETOOTH TEST] No notify characteristic found, writing directly`);
                proceedWithWrite();
              }
            });
          });
          };

          // If peripheral is already connected, disconnect first
          if (peripheral.state === 'connected') {
            safeLog(`⚠️ [BLUETOOTH TEST] Peripheral already connected, disconnecting first...`);
            peripheral.disconnect(() => {
              setTimeout(doConnect, 500);
            });
          } else {
            doConnect();
          }
        }
      };

      noble.on('discover', onDiscover);
      safeLog(`🔍 [BLUETOOTH TEST] Scanning for ${macAddress}...`);
      noble.startScanning([], true);
    });
  } catch (error) {
    safeLog('❌ [BLUETOOTH TEST] Error:', error.message);
    return { 
      success: false, 
      message: error.message,
      macAddress,
      channel,
    };
  }
}

// Periodic printer status check (every 30 seconds)
function startPrinterStatusCheck() {
  setInterval(() => {
    if (printerStore.printers.length > 0) {
      safeLog('🔍 [STATUS CHECK] Checking all printers...');
      printerStore.printers.forEach((printer) => {
        checkPrinterStatus(printer);
      });
    }
  }, 30000); // Check every 30 seconds
}

// Create Express server
function startExpressServer() {
  const expressApp = express();
  
  expressApp.use(cors());
  expressApp.use(express.json());

  // Health check
  expressApp.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Polling status
  expressApp.get('/api/polling/status', (req, res) => {
    res.json({
      pollingActive: pollingActive,
      pollInterval: config.pollInterval,
      apiBaseUrl: config.apiBaseUrl,
      storeId: activeStoreId || 'not-configured',
      deviceId: config.deviceId,
      printerCount: printerStore.printers.length,
      onlinePrinters: printerStore.printers.filter((p) => p.status === 'online').length,
    });
  });

  // Configure store ID (called from Angular after login)
  expressApp.post('/api/config/store', (req, res) => {
    const { storeId } = req.body;
    if (!storeId) {
      return res.status(400).json({ success: false, message: 'storeId is required' });
    }
    activeStoreId = storeId;
    logMessage('INFO', 'Config', `Store ID updated to: ${storeId}`);

    // Restart polling if already active so it picks up the new store ID
    if (pollingActive) {
      stopBackendPolling();
      startBackendPolling();
      logMessage('INFO', 'Config', 'Polling restarted with new store ID');
    }

    res.json({ success: true, message: 'Store ID configured', storeId });
  });

  // Clear store config (called on logout)
  expressApp.delete('/api/config/store', (req, res) => {
    activeStoreId = null;
    logMessage('INFO', 'Config', 'Store ID cleared (logout)');
    stopBackendPolling();
    res.json({ success: true, message: 'Store configuration cleared' });
  });

  // Auto-launch status
  expressApp.get('/api/config/auto-launch', async (req, res) => {
    try {
      const enabled = await autoLauncher.isEnabled();
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
        await autoLauncher.enable();
      } else {
        await autoLauncher.disable();
      }
      logMessage('INFO', 'AutoLaunch', `Auto-launch ${enabled ? 'enabled' : 'disabled'}`);
      res.json({ success: true, enabled });
    } catch (err) {
      logMessage('ERROR', 'AutoLaunch', 'Failed to toggle auto-launch', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Start polling
  expressApp.post('/api/polling/start', (req, res) => {
    startBackendPolling();
    res.json({ success: true, message: 'Polling started' });
  });

  // Stop polling
  expressApp.post('/api/polling/stop', (req, res) => {
    stopBackendPolling();
    res.json({ success: true, message: 'Polling stopped' });
  });

  // Printers endpoints
  expressApp.get('/api/printers', (req, res) => {
    res.json(printerStore.printers);
  });

  expressApp.post('/api/printers/test', (req, res) => {
    const { ip, port } = req.body;
    if (!ip || !port) {
      return res.status(400).json({ success: false, message: 'IP and port required' });
    }

    const net = require('net');
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

        const jobId = `test-job-${printerStore.nextId++}`;
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

        printerStore.queue.push(printJob);
        printerStore.printLogs.push({
          ...printJob,
          action: 'created',
          timestamp: new Date().toISOString(),
        });

        // Send directly to the USB printer
        const usbPrinter = printerStore.printers.find(
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

      const jobId = `test-job-${printerStore.nextId++}`;
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

      printerStore.queue.push(printJob);
      printerStore.printLogs.push({
        ...printJob,
        action: 'created',
        timestamp: new Date().toISOString(),
      });

      // Send directly to the USB printer
      const usbPrinter = printerStore.printers.find(
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

  // USB printer discovery endpoint
  expressApp.post('/api/printers/usb/discover', (req, res) => {
    const usbPrinters = discoverUSBPrinters();
    
    // Add discovered printers to store if not already present
    usbPrinters.forEach((usbPrinter) => {
      const exists = printerStore.printers.find((p) => p.id === usbPrinter.id);
      if (!exists) {
        printerStore.printers.push(usbPrinter);
        safeLog(`➡️ [USB] Added: ${usbPrinter.name}`);
      }
    });
    
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

    const net = require('net');
    const printers = [];
    const baseSubnet = subnet; // e.g., "192.168.1"
    const ips = [];

    // Generate IPs to scan (1-254)
    for (let i = 1; i <= 254; i++) {
      ips.push(`${baseSubnet}.${i}`);
    }

    let completed = 0;
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
        // Also scan for USB printers
        const usbPrinters = discoverUSBPrinters();
        const allPrinters = [...printers, ...usbPrinters];

        // Add discovered printers to store
        allPrinters.forEach((printer) => {
          const exists = printerStore.printers.find((p) => p.id === printer.id);
          if (!exists) {
            printerStore.printers.push(printer);
          }
        });

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
    const existing = printerStore.printers.find(p => p.macAddress === macAddress);
    if (existing) {
      return res.json({
        success: true,
        printerId: existing.id,
        message: `Bluetooth printer "${existing.name}" already exists`,
      });
    }

    const newPrinter = {
      id: `printer-${printerStore.nextId++}`,
      name,
      type: 'bluetooth',
      macAddress,
      channel: channel || 1,
      status: 'online',
      lastChecked: new Date().toISOString(),
    };

    printerStore.printers.push(newPrinter);
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
      id: `printer-${printerStore.nextId++}`,
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

    printerStore.printers.push(newPrinter);
    safeLog(`${type === 'usb' ? '🔌' : '🞨'} Printer added:`, newPrinter);
    
    // Check status immediately for network printers
    if (type !== 'usb') {
      checkPrinterStatus(newPrinter);
    }
    
    res.json({ success: true, printerId: newPrinter.id });
  });

  expressApp.delete('/api/printers/:id', (req, res) => {
    const { id } = req.params;
    printerStore.printers = printerStore.printers.filter((p) => p.id !== id);
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

      const jobId = `job-${printerStore.nextId++}`;
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

      printerStore.queue.push(printJob);
      printerStore.printLogs.push({
        ...printJob,
        action: 'created',
        timestamp: new Date().toISOString(),
      });

      safeLog(`📋 [PRINT JOB] Created: ${jobId} for Order: ${orderRef}`);

      // If printerId specified, try to print directly to that printer
      if (printerId) {
        const printer = printerStore.printers.find((p) => p.id === printerId);
        if (printer) {
          attemptPrint(printJob, printer);
        }
      } else {
        // Auto-select first available online printer
        const availablePrinter = printerStore.printers.find((p) => p.status === 'online');
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

  // Helper function to attempt printing to a specific printer
  function attemptPrint(job, printer) {
    // Route to correct printing method based on printer type
    if (printer.type === 'usb') {
      attemptUSBPrint(job, printer);
    } else if (printer.type === 'bluetooth') {
      attemptBluetoothPrint(job, printer);
    } else {
      attemptNetworkPrint(job, printer);
    }
  }

  function attemptNetworkPrint(job, printer) {
    const net = require('net');
    const socket = new net.Socket();
    socket.setTimeout(5000);

    socket.on('connect', () => {
      socket.write(job.data);
      socket.end();
      
      job.status = 'success';
      job.completedAt = new Date().toISOString();
      
      printerStore.printLogs.push({
        ...job,
        action: 'completed',
        printer: printer.name,
        timestamp: new Date().toISOString(),
      });
      
      safeLog(`✅ [PRINT] Sent to ${printer.name} (${printer.ip}:${printer.port})`);
    });

    socket.on('timeout', () => {
      socket.destroy();
      job.status = 'failed';
      job.error = 'Connection timeout';
      job.attempts++;
      
      safeLog(`⏱️ [PRINT] Timeout for ${printer.name} - Attempt ${job.attempts}/${job.maxAttempts}`);
      
      if (job.attempts < job.maxAttempts) {
        setTimeout(() => attemptNetworkPrint(job, printer), 1000);
      }
    });

    socket.on('error', (err) => {
      job.status = 'failed';
      job.error = err.message;
      job.attempts++;
      
      safeLog(`❌ [PRINT] Error on ${printer.name} - Attempt ${job.attempts}/${job.maxAttempts}`);
      
      if (job.attempts < job.maxAttempts) {
        setTimeout(() => attemptNetworkPrint(job, printer), 1000);
      }
    });

    socket.connect(printer.port, printer.ip);
  }

  function attemptUSBPrint(job, printer) {
    try {
      const usb = require('usb');

      // Find USB device by bus and device address
      const device = usb.getDeviceList().find(
        (dev) => dev.busNumber === printer.busNumber && dev.deviceAddress === printer.deviceAddress
      );

      if (!device) {
        job.status = 'failed';
        job.error = 'USB device not found';
        job.attempts++;
        safeLog(`❌ [USB PRINT] Device not found for ${printer.name}`);
        
        if (job.attempts < job.maxAttempts) {
          setTimeout(() => attemptUSBPrint(job, printer), 1000);
        }
        return;
      }

      // Open USB device and send data directly
      device.open();

      // Find the OUT endpoint (usually endpoint 1 or 3)
      const iface = device.interfaces[0];
      if (!iface) {
        device.close();
        job.status = 'failed';
        job.error = 'No USB interface found';
        safeLog(`❌ [USB PRINT] No interface for ${printer.name}`);
        return;
      }

      iface.claim();

      // Find OUT endpoint
      let outEndpoint = null;
      for (const endpoint of iface.endpoints) {
        if (endpoint.direction === 'out') {
          outEndpoint = endpoint;
          break;
        }
      }

      if (!outEndpoint) {
        iface.release();
        device.close();
        job.status = 'failed';
        job.error = 'No OUT endpoint found';
        safeLog(`❌ [USB PRINT] No OUT endpoint for ${printer.name}`);
        return;
      }

      // Prepare data
      let printData = job.data;
      if (typeof printData === 'string') {
        // Try base64 decode first
        try {
          printData = Buffer.from(printData, 'base64');
        } catch (e) {
          // If not base64, use as UTF-8 string
          printData = Buffer.from(printData, 'utf8');
        }
      }

      // Send data to printer
      outEndpoint.transfer(printData, (err) => {
        try {
          iface.release();
          device.close();
        } catch (e) {
          // Ignore cleanup errors
        }

        if (err) {
          job.status = 'failed';
          job.error = err.message;
          job.attempts++;
          safeLog(`❌ [USB PRINT] Error on ${printer.name} - Attempt ${job.attempts}/${job.maxAttempts}: ${err.message}`);

          if (job.attempts < job.maxAttempts) {
            setTimeout(() => attemptUSBPrint(job, printer), 1000);
          }
        } else {
          job.status = 'success';
          job.completedAt = new Date().toISOString();

          printerStore.printLogs.push({
            ...job,
            action: 'completed',
            printer: printer.name,
            timestamp: new Date().toISOString(),
          });

          safeLog(`✅ [USB PRINT] Sent to ${printer.name} (USB)`);
        }
      });
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      job.attempts++;

      safeLog(`❌ [USB PRINT] Exception on ${printer.name}: ${error.message}`);

      if (job.attempts < job.maxAttempts) {
        setTimeout(() => attemptUSBPrint(job, printer), 1000);
      }
    }
  }

  function attemptBluetoothPrint(job, printer) {
    try {
      safeLog(`🔗 [BLUETOOTH PRINT] Using Noble to send to ${printer.name}...`);

      // Handle mock printers
      if (printer.macAddress.includes('mock-')) {
        return attemptBluetoothPrintMock(job, printer);
      }

      // Use unified Noble implementation
      let noble;
      try {
        noble = require('@abandonware/noble').default || require('@abandonware/noble');
      } catch (e) {
        // Fallback to mock if noble not available
        return attemptBluetoothPrintMock(job, printer);
      }

      attemptBluetoothPrintWithNoble(job, printer, noble);
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      job.attempts++;

      safeLog(`❌ [BLUETOOTH PRINT] Exception on ${printer.name}: ${error.message}`);

      if (job.attempts < job.maxAttempts) {
        setTimeout(() => attemptBluetoothPrint(job, printer), 2000);
      }
    }
  }

  function attemptBluetoothPrintWithNoble(job, printer, noble) {
    safeLog(`📱 [BLUETOOTH PRINT NOBLE] Scanning for ${printer.name} (${printer.macAddress})...`);

    let timeout;
    let found = false;

    const onDiscover = (peripheral) => {
      // Match by address or peripheral.id (UUID on macOS where address is empty)
      const peripheralId = peripheral.address && peripheral.address !== '' ? peripheral.address : peripheral.id;
      if (peripheralId === printer.macAddress || peripheral.address === printer.macAddress || peripheral.id === printer.macAddress) {
        found = true;
        clearTimeout(timeout);
        noble.stopScanning();
        noble.removeListener('discover', onDiscover);

        safeLog(`📡 [BLUETOOTH PRINT] Found device, connecting...`);

        const doConnect = () => {
        peripheral.connect((err) => {
          if (err) {
            job.status = 'failed';
            job.error = `Connection error: ${err.message}`;
            job.attempts++;
            safeLog(`❌ [BLUETOOTH PRINT] Connection error: ${err.message}`);

            if (job.attempts < job.maxAttempts) {
              setTimeout(() => attemptBluetoothPrint(job, printer), 2000);
            }
            return;
          }

          safeLog(`✅ [BLUETOOTH PRINT] Connected, discovering all services & characteristics...`);

          // Discover ALL services and characteristics — BLE printers use various UART services
          // (ISSC, Nordic UART, custom), not Classic Bluetooth SPP (1101)
          peripheral.discoverAllServicesAndCharacteristics((err, services, characteristics) => {
            if (err) {
              peripheral.disconnect();
              job.status = 'failed';
              job.error = `Service discovery error: ${err.message}`;
              job.attempts++;
              safeLog(`❌ [BLUETOOTH PRINT] Service discovery error: ${err.message}`);

              if (job.attempts < job.maxAttempts) {
                setTimeout(() => attemptBluetoothPrint(job, printer), 2000);
              }
              return;
            }

            safeLog(`📋 [BLUETOOTH PRINT] Found ${services.length} service(s), ${characteristics.length} characteristic(s)`);
            characteristics.forEach((c, i) => {
              safeLog(`  📝 Char [${i}]: ${c.uuid} — properties: ${(c.properties || []).join(', ')}`);
            });

            // Find writable characteristic (TX)
            const writableChar = characteristics.find(c => {
              const props = c.properties || [];
              return props.includes('write') || props.includes('writeWithoutResponse');
            });

            if (!writableChar) {
              peripheral.disconnect();
              job.status = 'failed';
              job.error = 'No writable characteristic found';
              job.attempts++;
              safeLog(`❌ [BLUETOOTH PRINT] No writable characteristic found`);

              if (job.attempts < job.maxAttempts) {
                setTimeout(() => attemptBluetoothPrint(job, printer), 2000);
              }
              return;
            }

            // Find notify characteristic (RX) — must subscribe before writing
            const notifyChar = characteristics.find(c => {
              const props = c.properties || [];
              return (props.includes('notify') || props.includes('indicate')) && c.uuid !== writableChar.uuid;
            });

            const proceedWithWrite = () => {
              attemptWriteToPrinter(job, printer, peripheral, writableChar);
            };

            if (notifyChar) {
              safeLog(`📡 [BLUETOOTH PRINT] Subscribing to RX notifications on ${notifyChar.uuid}...`);
              
              notifyChar.on('data', (data) => {
                safeLog(`📥 [BLUETOOTH PRINT] Received ${data.length} bytes from printer`);
              });

              notifyChar.subscribe((subErr) => {
                if (subErr) {
                  safeLog(`⚠️ [BLUETOOTH PRINT] Notification subscribe error: ${subErr.message} (continuing)`);
                } else {
                  safeLog(`✅ [BLUETOOTH PRINT] Subscribed to RX notifications`);
                }
                setTimeout(proceedWithWrite, 200);
              });
            } else {
              safeLog(`⚠️ [BLUETOOTH PRINT] No notify characteristic found, writing directly`);
              proceedWithWrite();
            }
          });
        });
        };

        // If peripheral is already connected, disconnect first
        if (peripheral.state === 'connected') {
          safeLog(`⚠️ [BLUETOOTH PRINT] Peripheral already connected, disconnecting first...`);
          peripheral.disconnect(() => {
            setTimeout(doConnect, 500);
          });
        } else {
          doConnect();
        }
      }
    };

    noble.on('discover', onDiscover);

    timeout = setTimeout(() => {
      if (!found) {
        noble.stopScanning();
        noble.removeListener('discover', onDiscover);

        job.status = 'failed';
        job.error = 'Device not found during scan';
        job.attempts++;
        safeLog(`❌ [BLUETOOTH PRINT] Device not found after 10 second scan`);

        if (job.attempts < job.maxAttempts) {
          setTimeout(() => attemptBluetoothPrint(job, printer), 2000);
        }
      }
    }, 10000);

    safeLog(`🔍 [BLUETOOTH PRINT] Starting scan...`);
    noble.startScanning([], true);
  }

  function attemptWriteToPrinter(job, printer, peripheral, characteristic) {
    try {
      let printData = job.data;
      if (typeof printData === 'string') {
        try {
          printData = Buffer.from(printData, 'base64');
        } catch (e) {
          printData = Buffer.from(printData, 'utf8');
        }
      }
      if (!Buffer.isBuffer(printData)) {
        printData = Buffer.from(printData);
      }

      safeLog(`📤 [BLUETOOTH PRINT] Writing ${printData.length} bytes to ${printer.name} via characteristic ${characteristic.uuid}...`);

      const props = characteristic.properties || [];
      const useWithoutResponse = props.includes('writeWithoutResponse');
      safeLog(`📤 [BLUETOOTH PRINT] Write mode: ${useWithoutResponse ? 'writeWithoutResponse' : 'write (with response)'}`);

      // Chunk data to fit within BLE MTU (default 20 bytes payload)
      const chunkSize = 20;
      const chunks = [];
      for (let i = 0; i < printData.length; i += chunkSize) {
        chunks.push(printData.slice(i, i + chunkSize));
      }

      safeLog(`📤 [BLUETOOTH PRINT] Sending ${chunks.length} chunks of ${chunkSize} bytes...`);

      let chunkIndex = 0;
      const sendNextChunk = () => {
        if (chunkIndex >= chunks.length) {
          safeLog(`✅ [BLUETOOTH PRINT] All ${chunks.length} chunks sent to ${printer.name}`);
          // Wait for printer to process before disconnecting
          setTimeout(() => {
            peripheral.disconnect();

            job.status = 'success';
            job.completedAt = new Date().toISOString();

            printerStore.printLogs.push({
              ...job,
              action: 'completed',
              printer: printer.name,
              timestamp: new Date().toISOString(),
            });

            safeLog(`✅ [BLUETOOTH PRINT] Successfully sent ${printData.length} bytes to ${printer.name}`);
          }, 2000);
          return;
        }

        characteristic.write(chunks[chunkIndex], useWithoutResponse, (err) => {
          if (err) {
            safeLog(`❌ [BLUETOOTH PRINT] Write error on chunk ${chunkIndex + 1}/${chunks.length}: ${err.message}`);
            peripheral.disconnect();

            job.status = 'failed';
            job.error = `Write error on chunk ${chunkIndex + 1}: ${err.message}`;
            job.attempts++;

            if (job.attempts < job.maxAttempts) {
              setTimeout(() => attemptBluetoothPrint(job, printer), 2000);
            }
            return;
          }
          chunkIndex++;
          // 50ms delay between chunks for printer buffer processing
          setTimeout(sendNextChunk, 50);
        });
      };

      sendNextChunk();
    } catch (error) {
      peripheral.disconnect();

      job.status = 'failed';
      job.error = error.message;
      job.attempts++;

      safeLog(`❌ [BLUETOOTH PRINT] Write exception: ${error.message}`);

      if (job.attempts < job.maxAttempts) {
        setTimeout(() => attemptBluetoothPrint(job, printer), 2000);
      }
    }
  }

  function attemptBluetoothPrintMock(job, printer) {
    // Simulate successful printing for mock devices
    safeLog(`📱 [BLUETOOTH PRINT MOCK] Simulating print to ${printer.name}...`);
    
    setTimeout(() => {
      job.status = 'success';
      job.completedAt = new Date().toISOString();

      printerStore.printLogs.push({
        ...job,
        action: 'completed',
        printer: printer.name,
        timestamp: new Date().toISOString(),
      });

      safeLog(`✅ [BLUETOOTH PRINT MOCK] Successfully printed to ${printer.name} (${printer.macAddress})`);
    }, 500);
  }

  expressApp.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const logs = printerStore.printLogs.slice(-limit);
    res.json(logs);
  });

  expressApp.delete('/api/logs', (req, res) => {
    printerStore.printLogs = [];
    res.json({ success: true, message: 'All logs cleared' });
  });

  expressApp.get('/api/queue/stats', (req, res) => {
    const logs = printerStore.printLogs;
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

  expressServer = expressApp.listen(4001, () => {
    safeLog('Express server running on http://localhost:4001');
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const startUrl = isDev
    ? 'http://localhost:4201'
    : `file://${path.join(__dirname, 'dist/shopbot-printer/browser/index.html')}`;

  mainWindow.loadURL(startUrl);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ============================================================
// AUTO-UPDATER SYSTEM
// ============================================================

function setupAutoUpdater() {
  if (isDev) {
    logMessage('INFO', 'AutoUpdater', 'Skipping auto-updater in dev mode');
    return;
  }

  // Configure logging
  autoUpdater.logger = {
    info: (msg) => logMessage('INFO', 'AutoUpdater', msg),
    warn: (msg) => logMessage('WARN', 'AutoUpdater', msg),
    error: (msg) => logMessage('ERROR', 'AutoUpdater', msg),
    debug: (msg) => logMessage('DEBUG', 'AutoUpdater', msg),
  };

  // Don't auto-download — we control the flow
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // ── Event: Checking for updates ──
  autoUpdater.on('checking-for-update', () => {
    logMessage('INFO', 'AutoUpdater', '🔍 Checking for updates...');
    sendUpdateStatus('checking');
  });

  // ── Event: Update available ──
  autoUpdater.on('update-available', (info) => {
    logMessage('INFO', 'AutoUpdater', `🆕 Update available: v${info.version}`);
    sendUpdateStatus('available', { version: info.version, releaseDate: info.releaseDate });
    // Start downloading automatically
    autoUpdater.downloadUpdate();
  });

  // ── Event: No update ──
  autoUpdater.on('update-not-available', (info) => {
    logMessage('INFO', 'AutoUpdater', `✅ App is up to date (v${info.version})`);
    sendUpdateStatus('not-available', { version: info.version });
  });

  // ── Event: Download progress ──
  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent);
    logMessage('INFO', 'AutoUpdater', `⬇️ Downloading: ${percent}% (${formatBytes(progress.transferred)}/${formatBytes(progress.total)})`);
    sendUpdateStatus('downloading', {
      percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  // ── Event: Update downloaded — prompt user to restart ──
  autoUpdater.on('update-downloaded', (info) => {
    logMessage('INFO', 'AutoUpdater', `✅ Update downloaded: v${info.version}. Ready to install.`);
    sendUpdateStatus('downloaded', { version: info.version });

    // Show dialog asking user to restart
    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Ready',
        message: `ShopBot Printer v${info.version} has been downloaded.`,
        detail: 'The update will be installed when you restart the application. Restart now?',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          logMessage('INFO', 'AutoUpdater', '🔄 User accepted restart — installing update...');
          autoUpdater.quitAndInstall(false, true);
        } else {
          logMessage('INFO', 'AutoUpdater', '⏳ User deferred restart — update will install on next quit');
        }
      });
  });

  // ── Event: Error ──
  autoUpdater.on('error', (err) => {
    logMessage('ERROR', 'AutoUpdater', `❌ Update error: ${err.message}`);
    sendUpdateStatus('error', { error: err.message });
  });

  // Check for updates now, then every 30 minutes
  autoUpdater.checkForUpdatesAndNotify();
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify();
  }, 30 * 60 * 1000);
}

/**
 * Send update status to the renderer process
 */
function sendUpdateStatus(status, data = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', { status, ...data });
  }
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// IPC: Allow renderer to trigger manual update check
ipcMain.handle('check-for-updates', async () => {
  if (isDev) return { status: 'dev-mode' };
  try {
    const result = await autoUpdater.checkForUpdates();
    return { status: 'checking', version: result?.updateInfo?.version };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
});

// IPC: Allow renderer to trigger quit-and-install
ipcMain.handle('quit-and-install', () => {
  autoUpdater.quitAndInstall(false, true);
});

// IPC: Get current app version
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// App Lifecycle
app.whenReady().then(async () => {
  // Enable auto-launch on system startup (production only)
  if (!isDev) {
    try {
      const isEnabled = await autoLauncher.isEnabled();
      if (!isEnabled) {
        await autoLauncher.enable();
        logMessage('INFO', 'AutoLaunch', 'Auto-launch enabled for system startup');
      }
    } catch (err) {
      logMessage('ERROR', 'AutoLaunch', 'Failed to configure auto-launch', err.message);
    }
  }

  startExpressServer();
  startPrinterStatusCheck(); // Start periodic status checks
  startBackendPolling(); // Start polling for backend jobs
  createWindow();
  setupAutoUpdater(); // Check for updates after window is created
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC Handlers
ipcMain.handle('getPrinters', async () => {
  return [];
});

ipcMain.handle('sendMessage', (event, message) => {
  safeLog('Message from Renderer:', message);
});
