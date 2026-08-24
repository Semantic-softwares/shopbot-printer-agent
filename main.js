const { app, BrowserWindow } = require('electron');
require('dotenv').config();

// NOTE: dotenv.config() must run before any ./electron/* module is required —
// electron/state.js reads process.env synchronously at module-load time to
// build the `config` object (apiBaseUrl, deviceId, pollInterval, ...).

const state = require('./electron/state');
const { logMessage } = require('./electron/logger');
const { loadPersistedData } = require('./electron/persistence');
const { startExpressServer } = require('./electron/api-server');
const { connectSocket } = require('./electron/socket-service');
const { startPrinterStatusCheck } = require('./electron/printers/dispatch');
const { createWindow } = require('./electron/window');
const { setupAutoUpdater } = require('./electron/auto-updater');
const { registerIpcHandlers } = require('./electron/ipc-handlers');

registerIpcHandlers();

// App Lifecycle
app.whenReady().then(async () => {
  // Enable auto-launch on system startup (production only)
  if (!state.isDev) {
    try {
      const isEnabled = await state.autoLauncher.isEnabled();
      if (!isEnabled) {
        await state.autoLauncher.enable();
        logMessage('INFO', 'AutoLaunch', 'Auto-launch enabled for system startup');
      }
    } catch (err) {
      logMessage('ERROR', 'AutoLaunch', 'Failed to configure auto-launch', err.message);
    }
  }

  // Restore persisted data (storeId, printers) before starting services
  const persisted = loadPersistedData();
  if (persisted) {
    if (persisted.activeStoreId) {
      state.activeStoreId = persisted.activeStoreId;
      logMessage('INFO', 'Startup', `Restored store ID: ${state.activeStoreId}`);
    }
    if (persisted.deviceToken) {
      state.deviceToken = persisted.deviceToken;
    }
    if (persisted.printers && persisted.printers.length > 0) {
      state.printerStore.printers = persisted.printers;
      logMessage('INFO', 'Startup', `Restored ${persisted.printers.length} printer(s)`);
    }
    if (persisted.nextId) {
      state.printerStore.nextId = persisted.nextId;
    }
    if (persisted.deviceId) {
      state.config.deviceId = persisted.deviceId;
    }
  }

  startExpressServer();
  startPrinterStatusCheck(); // Start periodic status checks
  connectSocket(); // Connect for pushed print jobs (uses restored storeId/deviceToken)
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
