const axios = require('axios');
const state = require('./state');
const { logMessage } = require('./logger');
const { processBackendJob } = require('./job-processor');

/** Poll backend for pending print jobs (single cycle with timeout protection). */
async function pollPrintJobs() {
  // Prevent overlapping polls — if previous cycle is still processing (e.g. slow BLE print), skip
  if (state.isCurrentlyPolling) {
    logMessage('DEBUG', 'PollingService', 'Previous poll still running — skipping this cycle');
    return;
  }

  state.isCurrentlyPolling = true;
  try {
    // Use the store ID configured via login, fall back to env, or skip if none
    const storeId = state.activeStoreId || process.env.STORE_ID;

    if (!storeId) {
      logMessage('DEBUG', 'PollingService', 'No store ID configured — skipping poll. Login required.');
      return;
    }

    const url = `${state.config.apiBaseUrl}/print-jobs/polling/pending`;

    // AbortController for fetch timeout — prevent hung connections on Windows
    const controller = new AbortController();
    const abortTimeout = setTimeout(() => controller.abort(), 10000);

    const response = await axios.get(url, {
      params: {
        storeId: storeId,
        status: 'pending',
        limit: 10,
      },
      headers: {
        'X-Device-Id': state.config.deviceId,
        'X-Store-Id': storeId,
      },
      timeout: 10000,
      signal: controller.signal,
    });

    clearTimeout(abortTimeout);

    if (response.data.success && response.data.data.length > 0) {
      logMessage('INFO', 'PollingService', `Found ${response.data.data.length} pending job(s)`);

      // Process each job sequentially
      for (const job of response.data.data) {
        await processBackendJob(job);
      }
    } else {
      logMessage('DEBUG', 'PollingService', 'No pending jobs');
    }
  } catch (error) {
    logMessage('ERROR', 'PollingService', 'Failed to poll jobs', error.message);
    throw error; // Re-throw so the scheduler can track consecutive failures
  } finally {
    state.isCurrentlyPolling = false;
  }
}

/**
 * Start resilient polling for backend jobs.
 * Uses setTimeout chain (not setInterval) so a hung request can't block future polls.
 * Includes exponential backoff, watchdog, and power-state recovery.
 */
function startBackendPolling() {
  if (state.pollingActive) {
    logMessage('WARN', 'Polling', 'Polling already active');
    return;
  }

  state.pollingActive = true;
  state.consecutiveFailures = 0;
  state.lastSuccessfulPoll = Date.now();

  logMessage('INFO', 'Polling', `🚀 Starting resilient polling (${state.config.pollInterval}ms)`);
  logMessage('INFO', 'Polling', `API URL: ${state.config.apiBaseUrl}`);
  logMessage('INFO', 'Polling', `Branch ID: ${state.config.branchId}`);
  logMessage('INFO', 'Polling', `Device ID: ${state.config.deviceId}`);

  // Start the setTimeout-based poll loop
  scheduleNextPoll();

  // Start the watchdog that monitors polling health
  startPollWatchdog();

  // Listen for Windows sleep/wake events
  setupPowerMonitor();
}

/**
 * Schedule the next poll using setTimeout (not setInterval).
 * This ensures a hung fetch never blocks future polls.
 */
function scheduleNextPoll() {
  if (!state.pollingActive) return;

  // Exponential backoff on consecutive failures: 3s → 6s → 12s → 24s → max 30s
  let delay = state.config.pollInterval;
  if (state.consecutiveFailures > 0) {
    delay = Math.min(state.config.pollInterval * Math.pow(2, state.consecutiveFailures), 30000);
    logMessage('DEBUG', 'Polling', `Backoff delay: ${delay}ms (failures: ${state.consecutiveFailures})`);
  }

  state.pollingTimeoutId = setTimeout(async () => {
    if (!state.pollingActive) return;

    try {
      await pollPrintJobs();
      state.consecutiveFailures = 0;
      state.lastSuccessfulPoll = Date.now();
    } catch (err) {
      state.consecutiveFailures++;
      logMessage('WARN', 'Polling', `Poll failed (${state.consecutiveFailures}/${state.MAX_CONSECUTIVE_FAILURES}): ${err.message}`);

      if (state.consecutiveFailures >= state.MAX_CONSECUTIVE_FAILURES) {
        logMessage('ERROR', 'Polling', `${state.MAX_CONSECUTIVE_FAILURES} consecutive failures — resetting connection`);
        await resetPollingConnection();
      }
    }

    // Always schedule next poll regardless of success/failure
    scheduleNextPoll();
  }, delay);
}

/**
 * Watchdog: runs on a separate interval, detects if polling has gone silent.
 * If no successful poll in MAX_POLL_SILENCE_MS, force-restart the poll loop.
 */
function startPollWatchdog() {
  if (state.pollWatchdogId) {
    clearInterval(state.pollWatchdogId);
  }

  state.pollWatchdogId = setInterval(() => {
    if (!state.pollingActive) return;

    const silenceMs = Date.now() - state.lastSuccessfulPoll;

    if (silenceMs > state.MAX_POLL_SILENCE_MS) {
      logMessage('WARN', 'Watchdog', `No successful poll in ${Math.round(silenceMs / 1000)}s — force restarting poll loop`);

      // Kill the current pending timeout
      if (state.pollingTimeoutId) {
        clearTimeout(state.pollingTimeoutId);
        state.pollingTimeoutId = null;
      }

      state.consecutiveFailures = 0;
      state.lastSuccessfulPoll = Date.now(); // Prevent immediate re-trigger
      scheduleNextPoll();
    }

    // Emit heartbeat to Angular frontend
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send('polling:heartbeat', {
        pollingActive: state.pollingActive,
        lastSuccessfulPoll: new Date(state.lastSuccessfulPoll).toISOString(),
        consecutiveFailures: state.consecutiveFailures,
        silenceMs,
        uptime: process.uptime(),
      });
    }
  }, state.WATCHDOG_INTERVAL_MS);
}

/**
 * Reset polling connection after too many consecutive failures.
 * Waits a few seconds for the network to stabilize.
 */
async function resetPollingConnection() {
  logMessage('INFO', 'Polling', 'Resetting polling connection...');
  state.consecutiveFailures = 0;

  // Wait 5s to let the network recover (e.g. after Windows sleep)
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Test connectivity before resuming
  try {
    await axios.get(`${state.config.apiBaseUrl}/health`, { timeout: 5000 });
    logMessage('INFO', 'Polling', 'Server reachable — polling will resume normally');
  } catch (_err) {
    logMessage('WARN', 'Polling', 'Server not reachable — continuing with backoff');
    state.consecutiveFailures = 3; // Start with some backoff
  }
}

/**
 * Setup Electron powerMonitor to handle Windows sleep/wake/lock/unlock.
 * Timers freeze during sleep and may not resume — this forces a restart.
 */
function setupPowerMonitor() {
  const { powerMonitor } = require('electron');
  if (!powerMonitor) return;

  // Remove any previous listeners to avoid duplicates
  powerMonitor.removeAllListeners('suspend');
  powerMonitor.removeAllListeners('resume');
  powerMonitor.removeAllListeners('lock-screen');
  powerMonitor.removeAllListeners('unlock-screen');

  powerMonitor.on('suspend', () => {
    logMessage('INFO', 'Power', '⚡ System suspending — pausing poll timer');
    if (state.pollingTimeoutId) {
      clearTimeout(state.pollingTimeoutId);
      state.pollingTimeoutId = null;
    }
  });

  powerMonitor.on('resume', () => {
    logMessage('INFO', 'Power', '⚡ System resumed — restarting polling in 3s');
    setTimeout(() => {
      if (state.pollingActive) {
        state.consecutiveFailures = 0;
        state.lastSuccessfulPoll = Date.now();
        logMessage('INFO', 'Power', '⚡ Restarting poll loop after wake');
        scheduleNextPoll();
      }
    }, 3000);
  });

  powerMonitor.on('lock-screen', () => {
    logMessage('INFO', 'Power', '🔒 Screen locked — polling continues');
  });

  powerMonitor.on('unlock-screen', () => {
    logMessage('INFO', 'Power', '🔓 Screen unlocked — verifying polling health');
    const silenceMs = Date.now() - state.lastSuccessfulPoll;
    if (silenceMs > state.MAX_POLL_SILENCE_MS && state.pollingActive) {
      logMessage('WARN', 'Power', `Post-unlock: polling silent for ${Math.round(silenceMs / 1000)}s — restarting`);
      if (state.pollingTimeoutId) {
        clearTimeout(state.pollingTimeoutId);
        state.pollingTimeoutId = null;
      }
      state.consecutiveFailures = 0;
      state.lastSuccessfulPoll = Date.now();
      scheduleNextPoll();
    }
  });
}

/**
 * Stop polling completely — clears the poll loop and the watchdog.
 */
function stopBackendPolling() {
  if (!state.pollingActive) {
    return;
  }

  state.pollingActive = false;

  if (state.pollingTimeoutId) {
    clearTimeout(state.pollingTimeoutId);
    state.pollingTimeoutId = null;
  }

  if (state.pollWatchdogId) {
    clearInterval(state.pollWatchdogId);
    state.pollWatchdogId = null;
  }

  state.consecutiveFailures = 0;
  logMessage('INFO', 'Polling', '🛑 Backend polling stopped');
}

module.exports = { pollPrintJobs, startBackendPolling, stopBackendPolling };
