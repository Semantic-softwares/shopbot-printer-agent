const { io } = require('socket.io-client');
const state = require('./state');
const { logMessage } = require('./logger');
const { processBackendJob } = require('./job-processor');
const { pollPrintJobs } = require('./polling-service');

let socket = null;

/**
 * Connect to the backend's SharedGateway and start receiving print jobs by push
 * instead of polling for them. Requires both a store (set at login) and a device
 * token (minted server-side at login time, see electron/api-server.js) — without
 * a token the gateway rejects the connection outright.
 */
function connectSocket() {
  if (socket) {
    logMessage('DEBUG', 'SocketService', 'Already connected/connecting — skipping');
    return;
  }

  const storeId = state.activeStoreId || process.env.STORE_ID;
  if (!storeId) {
    logMessage('DEBUG', 'SocketService', 'No store ID configured — skipping connect. Login required.');
    return;
  }
  if (!state.deviceToken) {
    logMessage('WARN', 'SocketService', 'No device token configured — cannot connect. Login required.');
    return;
  }

  socket = io(state.config.apiBaseUrl, {
    auth: { token: state.deviceToken },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30000,
  });

  // Fires on the initial connection AND every time Socket.IO re-establishes the
  // connection after a drop — there is no separate "reconnected" case to handle,
  // this covers both, which is why there's no recurring poll loop anymore.
  socket.on('connect', () => {
    state.socketConnected = true;
    state.lastSocketEventAt = Date.now();
    logMessage('INFO', 'SocketService', `🔌 Connected (${socket.id}) — joining store ${storeId}`);
    socket.emit('joinStore', storeId);

    // Catch-up fetch: pick up anything created while we were disconnected (or,
    // on the very first connection, anything created before the app was running).
    pollPrintJobs().catch((err) =>
      logMessage('WARN', 'SocketService', `Catch-up fetch failed: ${err.message}`)
    );
  });

  socket.on('disconnect', (reason) => {
    state.socketConnected = false;
    logMessage('WARN', 'SocketService', `🔌 Disconnected: ${reason}`);
  });

  socket.on('connect_error', (err) => {
    state.socketConnected = false;
    logMessage('WARN', 'SocketService', `Connection error: ${err.message}`);
  });

  socket.on('printJob:created', (payload) => {
    state.lastSocketEventAt = Date.now();
    const job = payload?.printJob;
    if (!job || !job._id) {
      logMessage('WARN', 'SocketService', 'Received printJob:created with no usable job payload — ignoring');
      return;
    }
    logMessage('INFO', 'SocketService', `📨 Received job ${job._id} via push`);
    processBackendJob(job).catch((err) =>
      logMessage('ERROR', 'SocketService', `Error processing pushed job ${job._id}: ${err.message}`)
    );
  });

  setupPowerMonitor();
}

/** Disconnect and tear down the socket (called on logout). */
function stopSocketService() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  state.socketConnected = false;
}

/**
 * OS sleep can leave a socket in a half-open state that Socket.IO's own
 * reconnection logic doesn't always notice promptly — force a clean reconnect
 * (which triggers the 'connect' handler's catch-up fetch) on wake.
 */
function setupPowerMonitor() {
  const { powerMonitor } = require('electron');
  if (!powerMonitor) return;

  powerMonitor.removeAllListeners('resume');
  powerMonitor.on('resume', () => {
    logMessage('INFO', 'Power', '⚡ System resumed — forcing socket reconnect');
    if (socket) {
      socket.disconnect();
      socket.connect();
    }
  });
}

module.exports = { connectSocket, stopSocketService };
