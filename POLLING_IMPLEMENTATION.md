# ShopBot Printer - Backend Polling Implementation Summary

## What Was Added

The existing ShopBot Printer Electron application now includes **backend polling functionality** that automatically fetches print jobs from the ShopBot Server API and prints them.

## Key Changes

### 1. Environment Configuration (.env)

Created `.env.example` template with:
```bash
API_BASE_URL=http://localhost:3000/api
BRANCH_ID=default-branch
DEVICE_ID=printer-device-001
POLL_INTERVAL=3000
LOG_LEVEL=INFO
```

**Setup:**
```bash
cp .env.example .env
# Edit .env with your API endpoint
```

### 2. Main Process Updates (main.js)

**Added imports:**
- `axios` - HTTP client for API calls
- `dotenv` - Environment variable loading

**Added polling system with functions:**
- `pollPrintJobs()` - Poll backend every N seconds
- `processBackendJob()` - Handle job from backend
- `lockBackendJob()` - Atomic lock to prevent duplicates
- `completeBackendJob()` - Mark job as printed
- `failBackendJob()` - Mark job as failed (auto-retry)
- `startBackendPolling()` - Start polling loop
- `stopBackendPolling()` - Stop polling loop

**Updated logger:**
- Added `logMessage()` function with log levels
- Supports DEBUG, INFO, WARN, ERROR levels

### 3. Express Server Endpoints

Added new endpoints for control:
- `GET /api/polling/status` - Check polling status
- `POST /api/polling/start` - Start polling
- `POST /api/polling/stop` - Stop polling

### 4. Dependencies

Updated `package.json` to add:
```json
{
  "axios": "^1.6.2",
  "dotenv": "^16.0.0"
}
```

Run `npm install` to add these.

## How It Works

### Polling Loop (Every 3 Seconds)

1. **Poll** → `GET /print-jobs/polling/pending?branchId=...`
2. **Lock** → `PATCH /print-jobs/{id}/lock` (atomic)
3. **Send** → TCP (network) or USB (direct)
4. **Complete** → `PATCH /print-jobs/{id}/complete`
5. **Or Fail** → `PATCH /print-jobs/{id}/fail` (auto-retry)

### Auto-Start on App Launch

When you start the Electron app:
1. Express server starts (port 4001)
2. Printers are discovered (USB)
3. Backend polling automatically starts
4. Console logs show polling activity

## Configuration

### Minimal Setup (Local Development)

```bash
# Create .env
API_BASE_URL=http://localhost:3000/api
BRANCH_ID=default-branch
DEVICE_ID=printer-001

# Install deps
npm install

# Start
npm start
```

### Production Setup

```bash
# .env
API_BASE_URL=https://api.shopbot.africa/api
BRANCH_ID=store-001-main
DEVICE_ID=store-001-printer-01
POLL_INTERVAL=3000
LOG_LEVEL=INFO
```

## API Integration

The app integrates with these **backend endpoints** you already created:

### GET /print-jobs/polling/pending
Fetch pending jobs
```
Query: branchId, status, limit
Returns: { success, count, data: [...jobs] }
```

### PATCH /print-jobs/:id/lock
Atomically lock job
```
Body: { deviceId }
Returns: { success, data: { status: 'processing', lockedBy, lockedAt } }
Status 409: Already locked
```

### PATCH /print-jobs/:id/complete
Mark as successfully printed
```
Body: { deviceId }
Returns: { success, data: { status: 'success', printedAt } }
```

### PATCH /print-jobs/:id/fail
Mark as failed (auto-retries if < 3 attempts)
```
Body: { errorMessage, deviceId }
Returns: { success, data: { status: 'pending'|'failed', retryable } }
```

## Files Modified

| File | Changes |
|------|---------|
| `main.js` | Added 500+ lines for polling system |
| `package.json` | Added axios, dotenv dependencies |
| `.gitignore` | Added .env patterns |
| `.env.example` | Created new config template |

## Files Created

| File | Purpose |
|------|---------|
| `POLLING_INTEGRATION.md` | Detailed integration guide |
| `.env.example` | Environment template |

## Logging

### Enable Debug Mode
```bash
LOG_LEVEL=DEBUG npm start
```

### Example Logs
```
📋 [2024-02-14T10:30:45.123Z] [INFO] [Polling] 🚀 Starting backend polling (3000ms)
📋 [2024-02-14T10:30:48.012Z] [INFO] [PollingService] Found 2 pending job(s)
📋 [2024-02-14T10:30:48.345Z] [INFO] [JobProcessor] Processing job: job-123
🔒 [2024-02-14T10:30:48.678Z] [DEBUG] [JobLocking] Job locked: job-123
📤 [2024-02-14T10:30:49.234Z] [DEBUG] [NetworkPrint] Data sent to Kitchen Printer
✅ [2024-02-14T10:30:49.567Z] [INFO] [JobProcessor] Job completed: job-123
```

## Testing

### Verify Polling Is Active
```bash
curl http://localhost:4001/api/polling/status
```

Response:
```json
{
  "active": true,
  "interval": 3000,
  "apiUrl": "http://localhost:3000/api",
  "branchId": "default-branch",
  "deviceId": "printer-device-001"
}
```

### Test Print Job Flow

1. Create print job in backend
2. Watch console for polling messages
3. Job should print automatically
4. Status updates on backend

## Printer Support

### Network Printers
- TCP connection to port 9100
- ESC/POS thermal printers
- Auto-discovered or manually added

### USB Printers
- Direct USB transfers
- Known vendor IDs only
- Auto-discovered on startup

## Troubleshooting

### Polling not starting
```bash
# Check logs with DEBUG
LOG_LEVEL=DEBUG npm start

# Check API is reachable
curl http://localhost:3000/api/health
```

### Jobs not printing
1. Verify `BRANCH_ID` matches backend
2. Check printer is connected and online
3. Verify ESC/POS payload in job.receipt
4. Test with `LOG_LEVEL=DEBUG`

### High memory usage
- Restart app
- Check for stuck jobs on backend
- Clear old print logs

## Next Steps

1. **Setup .env:**
   ```bash
   cp .env.example .env
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start printer app:**
   ```bash
   npm start
   ```

4. **Verify polling:**
   ```bash
   curl http://localhost:4001/api/polling/status
   ```

5. **Create test jobs** in backend and watch them print!

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│   ShopBot Printer (Electron App)            │
│   - main.js (polling system)                │
│   - Express server (4001)                   │
│   - Printer discovery & sending             │
└────────────┬────────────────────────────────┘
             │
      ┌──────┴──────┐
      │ Polling Loop│ (every 3 seconds)
      │ .env config │
      └──────┬──────┘
             │
             ▼
┌─────────────────────────────────────────────┐
│   ShopBot Server API (localhost:3000)       │
│   - GET /print-jobs/polling/pending         │
│   - PATCH /print-jobs/:id/lock              │
│   - PATCH /print-jobs/:id/complete          │
│   - PATCH /print-jobs/:id/fail              │
└─────────────────────────────────────────────┘
             │
      ┌──────┴──────┐
      ▼             ▼
  [Network]      [USB]
  TCP 9100       Direct
```

## Key Features

✅ **Automatic Polling** - Fetches jobs every 3 seconds  
✅ **Atomic Locking** - Prevents duplicate processing  
✅ **Auto-Retry** - Up to 3 retries on failure  
✅ **Network & USB** - Supports both printer types  
✅ **Environment Config** - .env for easy setup  
✅ **Structured Logging** - Multiple log levels  
✅ **Graceful Shutdown** - Proper cleanup on exit  
✅ **Status Monitoring** - HTTP endpoints for control  

## Questions?

Refer to:
- `POLLING_INTEGRATION.md` - Detailed guide
- Console logs with `LOG_LEVEL=DEBUG`
- Backend API endpoints in shopbot-server
