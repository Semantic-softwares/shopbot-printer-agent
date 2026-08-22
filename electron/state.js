const path = require('path');
const { app } = require('electron');
const AutoLaunch = require('auto-launch');

// ============================================================
// SHARED MUTABLE STATE
// A single object (not separate `let` bindings) so every module that
// requires('./state') sees the same live values — Node's require cache
// makes this a singleton, and mutating a property here is visible
// everywhere else it's required. Always write `state.x = y`, never
// destructure primitives out (`const { x } = state`), or the binding
// stops following future mutations.
// ============================================================

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

const config = {
  apiBaseUrl:
    process.env.API_BASE_URL ||
    (isDev ? 'http://localhost:3000' : 'https://shopbot-server-7d7f5c27c0b7.herokuapp.com'),
  branchId: process.env.BRANCH_ID || 'default-branch',
  deviceId: process.env.DEVICE_ID || `printer-${Date.now()}`,
  pollInterval: parseInt(process.env.POLL_INTERVAL) || 3000,
  logLevel: process.env.LOG_LEVEL || 'INFO',
};

// In-memory printer/job storage
const printerStore = {
  printers: [],
  printLogs: [],
  queue: [],
  nextId: 1,
};

const autoLauncher = new AutoLaunch({
  name: 'ShopBot Printer',
  isHidden: false,
});

module.exports = {
  isDev,
  config,
  printerStore,
  autoLauncher,
  PERSIST_FILE: path.join(app.getPath('userData'), 'shopbot-persist.json'),

  // Electron window/server handles
  mainWindow: null,
  expressServer: null,

  // Active store — set by the Angular login flow, persisted to disk
  activeStoreId: null,

  // Polling loop state
  pollingActive: false,
  pollingTimeoutId: null, // setTimeout-based chain (NOT setInterval)
  isCurrentlyPolling: false, // guards against overlapping poll cycles
  consecutiveFailures: 0,
  lastSuccessfulPoll: Date.now(),
  pollWatchdogId: null,
  MAX_CONSECUTIVE_FAILURES: 10,
  WATCHDOG_INTERVAL_MS: 15000, // check every 15s that polling is alive
  MAX_POLL_SILENCE_MS: 30000, // if no success in 30s, force restart
};
