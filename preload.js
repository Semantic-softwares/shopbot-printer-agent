const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Printer APIs
  getPrinters: () => ipcRenderer.invoke('getPrinters'),
  sendMessage: (message) => ipcRenderer.invoke('sendMessage', message),
  onPrinterStatusChanged: (callback) => ipcRenderer.on('printer:status', callback),
  onPrintJobCompleted: (callback) => ipcRenderer.on('print:completed', callback),

  // Auto-Update APIs
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onUpdateStatus: (callback) => ipcRenderer.on('update:status', (_event, data) => callback(data)),
  removeUpdateListener: () => ipcRenderer.removeAllListeners('update:status'),
});
