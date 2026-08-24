const fs = require('fs');
const state = require('./state');
const { safeLog, logMessage } = require('./logger');

// ============================================================
// PERSISTENCE — survives app restart, cleared only on logout
// ============================================================

function loadPersistedData() {
  try {
    if (fs.existsSync(state.PERSIST_FILE)) {
      const raw = fs.readFileSync(state.PERSIST_FILE, 'utf8');
      const data = JSON.parse(raw);
      logMessage('INFO', 'Persistence', `Loaded persisted data from ${state.PERSIST_FILE}`);
      return data;
    }
  } catch (err) {
    safeLog(`⚠️ [PERSIST] Failed to load persisted data: ${err.message}`);
  }
  return null;
}

function savePersistedData() {
  try {
    const data = {
      activeStoreId: state.activeStoreId,
      deviceToken: state.deviceToken,
      printers: state.printerStore.printers,
      nextId: state.printerStore.nextId,
      deviceId: state.config.deviceId,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(state.PERSIST_FILE, JSON.stringify(data, null, 2), 'utf8');
    logMessage('DEBUG', 'Persistence', 'Data saved to disk');
  } catch (err) {
    safeLog(`⚠️ [PERSIST] Failed to save data: ${err.message}`);
  }
}

function clearPersistedData() {
  try {
    if (fs.existsSync(state.PERSIST_FILE)) {
      fs.unlinkSync(state.PERSIST_FILE);
      logMessage('INFO', 'Persistence', 'Persisted data cleared (logout)');
    }
  } catch (err) {
    safeLog(`⚠️ [PERSIST] Failed to clear data: ${err.message}`);
  }
}

module.exports = { loadPersistedData, savePersistedData, clearPersistedData };
