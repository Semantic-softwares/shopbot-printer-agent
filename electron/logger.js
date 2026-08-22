const state = require('./state');

/** Safe logger that handles broken pipes gracefully. */
function safeLog(...args) {
  try {
    if (process.stdout.writable) {
      console.log(...args);
    }
  } catch (err) {
    // Ignore EPIPE and other stream errors
    if (err.code !== 'EPIPE') {
      // Re-throw if it's not a pipe error
      // But silently ignore for now
    }
  }
}

/** Logger with levels, gated by config.logLevel. */
function logMessage(level, context, message, data = '') {
  const timestamp = new Date().toISOString();
  const levelEmoji = {
    DEBUG: '🔍',
    INFO: '📋',
    WARN: '⚠️',
    ERROR: '❌',
  }[level] || '•';

  const levelValue = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }[level];
  const configLevelValue = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }[state.config.logLevel];

  if (levelValue >= configLevelValue) {
    safeLog(`${levelEmoji} [${timestamp}] [${level}] [${context}] ${message}`, data || '');
  }
}

module.exports = { safeLog, logMessage };
