const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getPrinters: () => ipcRenderer.invoke('getPrinters'),
  sendMessage: (message) => ipcRenderer.invoke('sendMessage', message),
  onPrinterStatusChanged: (callback) => ipcRenderer.on('printer:status', callback),
  onPrintJobCompleted: (callback) => ipcRenderer.on('print:completed', callback),
});
