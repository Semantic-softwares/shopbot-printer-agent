// ============================================================
// LEGACY LOCAL PRINT QUEUE
// Backs the local /api/print, /api/printers/usb/test, and
// /api/printers/usb/print-test endpoints (print requests submitted
// directly to this device's Express API, e.g. by the renderer's own
// test-print actions) — a job/retry model of its own (job.status,
// job.attempts/maxAttempts, pushed into printerStore.printLogs),
// distinct from the backend-polling job pipeline in job-processor.js.
// Kept intentionally separate rather than unified with that pipeline:
// the two have different retry/logging semantics and merging them is
// a real behavioral change, not just an organizational one.
// ============================================================

const net = require('net');
const state = require('./state');
const { safeLog } = require('./logger');
const { resolveWindowsPrinterName, sendToUSBPrinterWindows } = require('./printers/usb');

/** Route to the correct printing method based on printer type. */
function attemptPrint(job, printer) {
  if (printer.type === 'usb') {
    attemptUSBPrint(job, printer);
  } else if (printer.type === 'bluetooth') {
    attemptBluetoothPrint(job, printer);
  } else {
    attemptNetworkPrint(job, printer);
  }
}

function attemptNetworkPrint(job, printer) {
  const socket = new net.Socket();
  socket.setTimeout(5000);

  socket.on('connect', () => {
    socket.write(job.data);
    socket.end();

    job.status = 'success';
    job.completedAt = new Date().toISOString();

    state.printerStore.printLogs.push({
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

        state.printerStore.printLogs.push({
          ...job,
          action: 'completed',
          printer: printer.name,
          timestamp: new Date().toISOString(),
        });

        safeLog(`✅ [USB PRINT] Sent to ${printer.name} (USB)`);
      }
    });
  } catch (error) {
    safeLog(`❌ [USB PRINT] Exception on ${printer.name}: ${error.message}`);

    // On Windows, try native fallback before giving up or retrying
    if (process.platform === 'win32') {
      const winName = resolveWindowsPrinterName(printer);
      if (winName) {
        safeLog(`⚠️ [USB PRINT] libusb failed, trying Windows-native print for "${winName}"...`);
        sendToUSBPrinterWindows(job.data, { ...printer, windowsPrinterName: winName }).then((winResult) => {
          if (winResult.success) {
            job.status = 'success';
            job.completedAt = new Date().toISOString();
            state.printerStore.printLogs.push({
              ...job,
              action: 'completed',
              printer: printer.name,
              timestamp: new Date().toISOString(),
            });
            safeLog(`✅ [USB PRINT] Sent to ${printer.name} via Windows fallback`);
          } else {
            safeLog(`❌ [USB PRINT] Windows fallback also failed: ${winResult.error}`);
            job.status = 'failed';
            job.error = `libusb: ${error.message}, Windows: ${winResult.error}`;
            job.attempts++;
            if (job.attempts < job.maxAttempts) {
              setTimeout(() => attemptUSBPrint(job, printer), 1000);
            }
          }
        }).catch((winErr) => {
          safeLog(`❌ [USB PRINT] Windows fallback exception: ${winErr.message}`);
          job.status = 'failed';
          job.error = error.message;
          job.attempts++;
          if (job.attempts < job.maxAttempts) {
            setTimeout(() => attemptUSBPrint(job, printer), 1000);
          }
        });
        return; // Don't execute normal failure path — Windows fallback handles it
      }
    }

    job.status = 'failed';
    job.error = error.message;
    job.attempts++;

    if (job.attempts < job.maxAttempts) {
      setTimeout(() => attemptUSBPrint(job, printer), 1000);
    }
  }
}

function attemptBluetoothPrint(job, printer) {
  try {
    safeLog(`🔗 [BLUETOOTH PRINT] Using Noble to send to ${printer.name}...`);

    // Use unified Noble implementation
    let noble;
    try {
      noble = require('@abandonware/noble').default || require('@abandonware/noble');
    } catch (e) {
      job.status = 'failed';
      job.error = 'Bluetooth library (Noble) not available';
      safeLog('❌ [BLUETOOTH PRINT] Noble library not available — cannot print');
      return;
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

          state.printerStore.printLogs.push({
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

module.exports = { attemptPrint, attemptUSBPrint };
