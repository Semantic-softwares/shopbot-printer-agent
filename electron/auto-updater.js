const { dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const state = require('./state');
const { logMessage } = require('./logger');

/** Format bytes to human-readable string. */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/** Send update status to the renderer process. */
function sendUpdateStatus(status, data = {}) {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send('update:status', { status, ...data });
  }
}

function setupAutoUpdater() {
  if (state.isDev) {
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
      .showMessageBox(state.mainWindow, {
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

module.exports = { setupAutoUpdater, sendUpdateStatus, formatBytes };
