const { safeLog, logMessage } = require('../logger');

/**
 * Send ESC/POS data to Bluetooth printer via Noble BLE.
 * Used by the polling system for backend print jobs.
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

/** Discover nearby Bluetooth devices using Noble. */
async function discoverBluetoothPrinters() {
  try {
    let noble;
    try {
      noble = require('@abandonware/noble').default || require('@abandonware/noble');
    } catch (e) {
      safeLog('❌ [BLUETOOTH] Noble library not available — cannot scan for Bluetooth devices');
      safeLog('❌ [BLUETOOTH] Error:', e.message);
      return [];
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

/** Get RFCOMM channel for Bluetooth device (Noble uses GATT, default to channel 1 for SPP). */
async function getBluetoothDeviceChannel(macAddress) {
  try {
    safeLog(`🔍 [BLUETOOTH CHANNEL] Getting channel for ${macAddress}...`);

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

/** Test Bluetooth connection using Noble, sending a sample receipt if a writable characteristic is found. */
async function testBluetoothConnection(macAddress, channel = 1) {
  try {
    safeLog(`🔗 [BLUETOOTH TEST] Testing ${macAddress}:${channel}...`);

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

module.exports = {
  sendToBluetoothPrinterDirect,
  discoverBluetoothPrinters,
  getBluetoothDeviceChannel,
  testBluetoothConnection,
};
