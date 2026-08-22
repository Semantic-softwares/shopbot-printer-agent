const path = require('path');
const { BrowserWindow } = require('electron');
const state = require('./state');

function createWindow() {
  state.mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const startUrl = state.isDev
    ? 'http://localhost:4201'
    : `file://${path.join(__dirname, '..', 'dist/shopbot-printer/browser/index.html')}`;

  state.mainWindow.loadURL(startUrl);

  if (state.isDev) {
    state.mainWindow.webContents.openDevTools();
  }

  state.mainWindow.on('closed', () => {
    state.mainWindow = null;
  });
}

module.exports = { createWindow };
