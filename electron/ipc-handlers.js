const { app, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const { safeLog } = require('./logger');
const state = require('./state');

function registerIpcHandlers() {
  // Allow renderer to trigger manual update check
  ipcMain.handle('check-for-updates', async () => {
    if (state.isDev) return { status: 'dev-mode' };
    try {
      const result = await autoUpdater.checkForUpdates();
      return { status: 'checking', version: result?.updateInfo?.version };
    } catch (err) {
      return { status: 'error', error: err.message };
    }
  });

  // Allow renderer to trigger quit-and-install
  ipcMain.handle('quit-and-install', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  // Get current app version
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  ipcMain.handle('getPrinters', async () => {
    return [];
  });

  ipcMain.handle('sendMessage', (event, message) => {
    safeLog('Message from Renderer:', message);
  });
}

module.exports = { registerIpcHandlers };
