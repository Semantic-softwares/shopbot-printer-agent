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

  // Device-scoped socket auth token — minted server-side at login (see
  // electron/api-server.js POST /api/config/store), persisted to disk
  deviceToken: null,

  // Push-delivery (socket) connection state. Print jobs arrive via
  // 'printJob:created' pushes now — there is no recurring poll loop; the only
  // fetches left are one-shot catch-up reads triggered by a socket connect/
  // reconnect event (see electron/polling-service.js's pollPrintJobs(),
  // called from electron/socket-service.js).
  socketConnected: false,
  lastSocketEventAt: Date.now(),
  isCurrentlyPolling: false, // guards a catch-up fetch against overlapping itself
  consecutiveFailures: 0, // consecutive catch-up-fetch failures, for UI health display
  lastSuccessfulPoll: Date.now(), // last successful catch-up fetch, for UI display
};
