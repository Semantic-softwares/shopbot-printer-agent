const axios = require('axios');
const state = require('./state');
const { logMessage } = require('./logger');
const { sendToPrinterDevice } = require('./printers/dispatch');

/** Parse receipt payload from Base64 or hex. */
function parseReceiptPayload(receipt) {
  try {
    // If it's base64, decode it
    if (/^[A-Za-z0-9+/=]+$/.test(receipt)) {
      try {
        return Buffer.from(receipt, 'base64');
      } catch {
        // Not valid base64
      }
    }

    // If it's hex string, convert to buffer
    if (/^[0-9A-Fa-f]*$/.test(receipt)) {
      return Buffer.from(receipt, 'hex');
    }

    // Assume it's a string payload
    return Buffer.from(receipt, 'utf8');
  } catch (error) {
    logMessage('ERROR', 'PayloadParser', 'Error parsing receipt payload', error.message);
    return null;
  }
}

/** Lock job on backend (atomic operation). */
async function lockBackendJob(jobId) {
  try {
    const url = `${state.config.apiBaseUrl}/print-jobs/${jobId}/lock`;
    const response = await axios.patch(
      url,
      { deviceId: state.config.deviceId },
      {
        headers: {
          'X-Device-Id': state.config.deviceId,
          'X-Branch-Id': state.config.branchId,
        },
        timeout: 5000,
      }
    );

    if (response.data.success) {
      logMessage('DEBUG', 'JobLocking', `🔒 Job locked: ${jobId}`);
      return true;
    }

    return false;
  } catch (error) {
    if (error.response?.status === 409 || error.response?.status === 400) {
      logMessage('DEBUG', 'JobLocking', `Job ${jobId} already locked or unavailable — skipping`);
      return false;
    }
    logMessage('WARN', 'JobLocking', `Error locking job ${jobId}`, error.message);
    return false;
  }
}

/** Complete job on backend. */
async function completeBackendJob(jobId) {
  try {
    const url = `${state.config.apiBaseUrl}/print-jobs/${jobId}/complete`;
    const response = await axios.patch(
      url,
      { deviceId: state.config.deviceId },
      {
        headers: {
          'X-Device-Id': state.config.deviceId,
          'X-Branch-Id': state.config.branchId,
        },
        timeout: 5000,
      }
    );

    return response.data.success;
  } catch (error) {
    logMessage('ERROR', 'JobCompletion', `Error completing job ${jobId}`, error.message);
    return false;
  }
}

/** Fail job on backend. */
async function failBackendJob(jobId, errorMessage) {
  try {
    const url = `${state.config.apiBaseUrl}/print-jobs/${jobId}/fail`;
    const response = await axios.patch(
      url,
      {
        errorMessage,
        deviceId: state.config.deviceId,
      },
      {
        headers: {
          'X-Device-Id': state.config.deviceId,
          'X-Branch-Id': state.config.branchId,
        },
        timeout: 5000,
      }
    );

    if (response.data.success) {
      const data = response.data.data;
      if (data?.retryable) {
        logMessage('INFO', 'JobFailure', `Job will retry (attempt ${data.retryCount}/3)`);
      } else {
        logMessage('WARN', 'JobFailure', `Job failed permanently (max retries exceeded)`);
      }
    }

    return response.data.success;
  } catch (error) {
    logMessage('ERROR', 'JobFailure', `Error failing job ${jobId}`, error.message);
    return false;
  }
}

/** Process a single job from backend: lock, match printer, parse payload, send, complete/fail. */
async function processBackendJob(job) {
  logMessage('INFO', 'JobProcessor', `Processing job: ${job._id} (Type: ${job.type}, Order: ${job.orderMetadata?.reference || job._id})`);

  // Create a log entry upfront so it appears in the UI immediately
  const logEntry = {
    _id: job._id,
    id: job._id,
    jobId: job._id,
    printer: null,
    printerId: null,
    printerName: job.printerDetails?.name || 'Unknown',
    status: 'processing',
    type: job.type || 'print_job',
    jobType: job.type || 'print_job',
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    error: null,
    lastError: null,
    retryCount: 0,
    maxRetries: 3,
    orderRef: job.orderMetadata?.reference || null,
  };
  state.printerStore.printLogs.push(logEntry);

  try {
    // Step 1: Lock job
    const lockSuccess = await lockBackendJob(job._id);
    if (!lockSuccess) {
      logMessage('WARN', 'JobProcessor', `Could not lock job ${job._id}, another device may have locked it`);
      logEntry.status = 'skipped';
      logEntry.error = 'Could not lock — another device may have it';
      return;
    }

    // Step 2: Find the correct printer using printerDetails from the job
    logMessage('DEBUG', 'JobProcessor', `Looking for printer. Available printers: ${state.printerStore.printers.length}`);
    logMessage('DEBUG', 'JobProcessor', `Job type: ${job.type}, Printer details: ${JSON.stringify(job.printerDetails || {})}`);

    let printer = null;
    const pd = job.printerDetails;

    // Strategy 1: Match by connection details from printerDetails (most reliable)
    if (pd && pd.connection) {
      const connType = pd.connectionType || '';

      if ((connType === 'usb-raw' || connType === 'usb') && pd.connection.vendorId && pd.connection.productId) {
        // Match USB printer by vendorId + productId
        printer = state.printerStore.printers.find(
          (p) => p.type === 'usb' && p.vendorId === pd.connection.vendorId && p.productId === pd.connection.productId
        );
        if (printer) {
          logMessage('DEBUG', 'JobProcessor', `Matched USB printer by VID/PID: ${printer.name}`);
        }
      } else if (connType === 'bluetooth' && pd.connection.macAddress) {
        // Match Bluetooth printer by macAddress
        printer = state.printerStore.printers.find(
          (p) => p.type === 'bluetooth' && p.macAddress === pd.connection.macAddress
        );
        if (printer) {
          logMessage('DEBUG', 'JobProcessor', `Matched Bluetooth printer by MAC: ${printer.name}`);
        }
      } else if (pd.connection.ip) {
        // Match network printer by IP
        printer = state.printerStore.printers.find(
          (p) => p.type === 'network' && p.ip === pd.connection.ip
        );
        if (printer) {
          logMessage('DEBUG', 'JobProcessor', `Matched network printer by IP: ${printer.name}`);
        }
      }
    }

    // Strategy 2: Match by printer name as fallback
    if (!printer && pd && pd.name) {
      printer = state.printerStore.printers.find(
        (p) => p.name.toLowerCase() === pd.name.toLowerCase()
      );
      if (printer) {
        logMessage('DEBUG', 'JobProcessor', `Matched printer by name: ${printer.name}`);
      }
    }

    // NO fallback to random printers — each job must go to its designated printer
    if (!printer) {
      const printerName = pd ? pd.name : 'unknown';
      const connType = pd ? pd.connectionType : 'unknown';
      logMessage('WARN', 'JobProcessor', `⏭️ No matching local printer for "${printerName}" (${connType}). Job ${job._id} will remain pending.`);
      logMessage('DEBUG', 'JobProcessor', `Registered printers: ${state.printerStore.printers.map(p => `${p.name}(${p.type})`).join(', ')}`);
      // Release the lock so another device with the right printer can pick it up
      await failBackendJob(job._id, `No matching printer found for "${printerName}" (${connType}). This device does not have this printer connected.`);
      logEntry.status = 'failed';
      logEntry.error = `No matching printer for "${printerName}" (${connType})`;
      return;
    }

    logMessage('INFO', 'JobProcessor', `✅ Using printer: ${printer.name} (${printer.type}) for ${job.type} job`);
    logEntry.printer = printer.id || printer.name;
    logEntry.printerId = printer.id || printer.name;
    logEntry.printerName = printer.name;

    // Step 3: Parse ESC/POS payload
    if (!job.receipt) {
      logMessage('ERROR', 'JobProcessor', `No receipt data in job`);
      await failBackendJob(job._id, 'No receipt data provided');
      logEntry.status = 'failed';
      logEntry.error = 'No receipt data provided';
      return;
    }

    logMessage('DEBUG', 'JobProcessor', `Parsing receipt payload (${typeof job.receipt.data})`);
    const payload = parseReceiptPayload(job.receipt.data || job.receipt);
    if (!payload) {
      logMessage('ERROR', 'JobProcessor', `Failed to parse receipt payload`);
      await failBackendJob(job._id, 'Failed to parse receipt payload');
      logEntry.status = 'failed';
      logEntry.error = 'Failed to parse receipt payload';
      return;
    }

    logMessage('DEBUG', 'JobProcessor', `✅ Receipt parsed: ${payload.length} bytes`);

    // Step 4: Send to printer
    logMessage('INFO', 'JobProcessor', `📤 Sending to printer: ${printer.name}...`);
    const printResult = await sendToPrinterDevice(printer, payload);

    if (!printResult.success) {
      logMessage('ERROR', 'JobProcessor', `📤 Print send failed: ${printResult.error}`);
      await failBackendJob(job._id, printResult.error || 'Unknown print error');
      logEntry.status = 'failed';
      logEntry.error = printResult.error || 'Unknown print error';
      return;
    }

    logMessage('SUCCESS', 'JobProcessor', `✅ Data sent to printer: ${printer.name}`);

    // Step 5: Mark as complete
    const completeSuccess = await completeBackendJob(job._id);
    if (completeSuccess) {
      logMessage('INFO', 'JobProcessor', `✅ Job completed: ${job._id}`);
      logEntry.status = 'printed';
    } else {
      logMessage('WARN', 'JobProcessor', `Job printed but failed to mark complete: ${job._id}`);
      logEntry.status = 'printed';
      logEntry.error = 'Printed but failed to mark complete on server';
    }
  } catch (error) {
    logMessage('ERROR', 'JobProcessor', `Unexpected error: ${error.message}`, error);
    logEntry.status = 'failed';
    logEntry.error = error.message;
    try {
      await failBackendJob(job._id, error.message);
    } catch (failError) {
      logMessage('ERROR', 'JobProcessor', `Also failed to mark job as failed`, failError.message);
    }
  }
}

module.exports = {
  processBackendJob,
  parseReceiptPayload,
  lockBackendJob,
  completeBackendJob,
  failBackendJob,
};
