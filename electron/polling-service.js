const axios = require('axios');
const state = require('./state');
const { logMessage } = require('./logger');
const { processBackendJob, matchLocalPrinter } = require('./job-processor');

/**
 * Process a batch of jobs grouped by their matched local printer: different
 * printers run concurrently instead of waiting behind each other, while jobs
 * headed to the SAME printer stay sequential (avoids interleaving raw bytes on
 * one physical device). A job with no local match gets its own group so it fails
 * out on its own instead of blocking, or being blocked by, anything else.
 */
async function processJobsGroupedByPrinter(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const printer = matchLocalPrinter(job);
    const key = printer ? `${printer.type}:${printer.id || printer.name}` : `unmatched:${job._id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }

  await Promise.all(
    Array.from(groups.values()).map(async (groupJobs) => {
      for (const job of groupJobs) {
        await processBackendJob(job);
      }
    })
  );
}

/**
 * Fetch and process pending print jobs — a single one-shot catch-up read, not a
 * recurring poll. Print jobs are delivered by push now (see electron/socket-
 * service.js's 'printJob:created' listener); this exists purely as the recovery
 * path for whatever a push could have missed — called once whenever the socket
 * connects or reconnects, and independently, the backend also self-heals by
 * re-pushing anything that's sat pending too long (see PrintJobSweepService
 * server-side) — so nothing here needs to run on a timer.
 */
async function pollPrintJobs() {
  // Guard against an overlapping call (e.g. a reconnect firing again mid-fetch)
  if (state.isCurrentlyPolling) {
    logMessage('DEBUG', 'PollingService', 'A catch-up fetch is already running — skipping');
    return;
  }

  state.isCurrentlyPolling = true;
  try {
    const storeId = state.activeStoreId || process.env.STORE_ID;

    if (!storeId) {
      logMessage('DEBUG', 'PollingService', 'No store ID configured — skipping fetch. Login required.');
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
      logMessage('INFO', 'PollingService', `Catch-up fetch found ${response.data.data.length} pending job(s)`);
      await processJobsGroupedByPrinter(response.data.data);
    } else {
      logMessage('DEBUG', 'PollingService', 'Catch-up fetch: no pending jobs');
    }

    state.consecutiveFailures = 0;
    state.lastSuccessfulPoll = Date.now();
  } catch (error) {
    state.consecutiveFailures++;
    logMessage('ERROR', 'PollingService', 'Catch-up fetch failed', error.message);
    throw error;
  } finally {
    state.isCurrentlyPolling = false;
  }
}

module.exports = { pollPrintJobs, processJobsGroupedByPrinter };
