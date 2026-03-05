# ShopBot Printer - Backend Polling Integration

## Overview

The ShopBot Printer Electron application now includes backend polling functionality that:

1. **Polls** the backend API every 3 seconds for pending print jobs
2. **Locks** jobs atomically to prevent duplicate processing
3. **Sends** ESC/POS payloads to network and USB printers
4. **Marks** jobs as complete or failed with proper retry handling

## Quick Start

### 1. Setup Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```bash
# Backend API
API_BASE_URL=http://localhost:3000/api
BRANCH_ID=default-branch
DEVICE_ID=printer-device-001

# Polling
POLL_INTERVAL=3000
LOG_LEVEL=INFO
```

### 2. Install Dependencies

```bash
npm install
```

This adds:
- `axios` - HTTP client for API calls
- `dotenv` - Environment variable loading

### 3. Start the Application

```bash
npm start
```

The Electron app will:
1. Start the Express server on port 4001
2. Discover USB printers
3. Begin polling the backend every 3 seconds
4. Print jobs automatically when received

## Configuration

### Environment Variables (.env)

| Variable | Default | Purpose |
|----------|---------|---------|
| `API_BASE_URL` | `http://localhost:3000/api` | Backend API endpoint |
| `BRANCH_ID` | `default-branch` | Store/branch identifier |
| `DEVICE_ID` | `printer-device-001` | Unique device identifier |
| `POLL_INTERVAL` | `3000` | Poll interval in milliseconds |
| `LOG_LEVEL` | `INFO` | Logging level: DEBUG, INFO, WARN, ERROR |

### Example Production Config

```bash
API_BASE_URL=https://api.shopbot.africa/api
BRANCH_ID=store-001-main
DEVICE_ID=store-001-printer-01
POLL_INTERVAL=3000
LOG_LEVEL=INFO
```

## API Endpoints (Local Express Server)

The Electron app exposes these endpoints for control:

### Polling Status
```bash
GET http://localhost:4001/api/polling/status
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

### Start Polling
```bash
POST http://localhost:4001/api/polling/start
```

### Stop Polling
```bash
POST http://localhost:4001/api/polling/stop
```

## Backend Integration

The app integrates with these backend endpoints:

### 1. Poll for Jobs
```
GET /print-jobs/polling/pending?branchId={branchId}&status=pending&limit=10
```

### 2. Lock Job
```
PATCH /print-jobs/{jobId}/lock
Body: { "deviceId": "{deviceId}" }
```

### 3. Complete Job
```
PATCH /print-jobs/{jobId}/complete
Body: { "deviceId": "{deviceId}" }
```

### 4. Fail Job
```
PATCH /print-jobs/{jobId}/fail
Body: { "errorMessage": "...", "deviceId": "{deviceId}" }
```

## Job Processing Flow

```
┌─────────────────────────────────────────────────────┐
│ 1. POLL (every 3 seconds)                           │
│    GET /print-jobs/polling/pending                  │
└────────────┬────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────┐
│ 2. LOCK (atomic operation)                          │
│    PATCH /print-jobs/{id}/lock                      │
│    ├─ Success → Continue                            │
│    └─ Conflict → Skip (another device locked it)    │
└────────────┬────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────┐
│ 3. SEND TO PRINTER                                  │
│    ├─ Network: TCP 9100                             │
│    └─ USB: Direct USB transfer                      │
└────────────┬────────────────────────────────────────┘
             │
        ┌────┴────┐
        │          │
        ▼          ▼
      SUCCESS    FAILED
        │          │
        ▼          ▼
┌──────────────┐ ┌──────────────┐
│ MARK COMPLETE│ │ MARK FAILED   │
│              │ │ (auto-retry)  │
└──────────────┘ └──────────────┘
```

## Logging

### Console Output Examples

```
📋 [2024-02-14T10:30:45.123Z] [INFO] [Polling] 🚀 Starting backend polling (3000ms)
📋 [2024-02-14T10:30:45.456Z] [INFO] [Polling] API URL: http://localhost:3000/api
📋 [2024-02-14T10:30:45.789Z] [INFO] [Polling] Branch ID: default-branch
📋 [2024-02-14T10:30:48.012Z] [INFO] [PollingService] Found 2 pending job(s)
📋 [2024-02-14T10:30:48.345Z] [INFO] [JobProcessor] Processing job: job-123 (Order: ORD-456)
🔒 [2024-02-14T10:30:48.678Z] [DEBUG] [JobLocking] Job locked: job-123
🔍 [2024-02-14T10:30:48.901Z] [DEBUG] [JobProcessor] Using printer: Kitchen Printer
📤 [2024-02-14T10:30:49.234Z] [DEBUG] [NetworkPrint] Data sent to Kitchen Printer
✅ [2024-02-14T10:30:49.567Z] [INFO] [JobProcessor] Job completed: job-123
```

### Adjust Log Level

Set `LOG_LEVEL` in .env:
- `DEBUG` - All messages
- `INFO` - Info and above
- `WARN` - Warnings and errors
- `ERROR` - Errors only

## Printer Support

### Network Printers (TCP 9100)
- Epson TM-T88
- Star Micronics mPop
- Generic thermal printers with ESC/POS

**Configuration:**
- IP address (e.g., `192.168.1.100`)
- Port (default: `9100`)

### USB Printers
- Epson USB thermal printers
- Star Micronics USB printers
- Zebra USB printers
- And 15+ other known vendors

**Automatic Discovery:**
USB printers are auto-discovered on startup

## Troubleshooting

### Polling Not Working

1. **Check API URL:**
   ```bash
   # .env
   API_BASE_URL=http://localhost:3000/api
   ```

2. **Verify Backend is Running:**
   ```bash
   curl http://localhost:3000/api/health
   # Should return: { "status": "ok" }
   ```

3. **Check Branch ID:**
   - Verify branch exists on backend
   - Check it matches a real store/branch

4. **Enable Debug Logging:**
   ```bash
   # .env
   LOG_LEVEL=DEBUG
   ```

### Jobs Not Printing

1. **Verify Printer Registration:**
   - Open DevTools (F12)
   - Check console for printer discovery messages

2. **Test Printer Connection:**
   - Network: `telnet 192.168.1.100 9100`
   - USB: Should show in discovery logs

3. **Check Job Receipt Data:**
   - Verify ESC/POS payload is valid
   - Check in backend logs

### High Memory Usage

- Clear completed jobs from backend database
- Check for stuck locks on failed devices
- Restart Electron app

## Development

### Enable All Logging

```bash
LOG_LEVEL=DEBUG npm start
```

### Test with Mock Backend

```bash
# Terminal 1: Start mock API
npm run mock-api

# Terminal 2: Start printer app
npm start
```

### Check Polling Status

```bash
curl http://localhost:4001/api/polling/status
```

## Production Deployment

### On Linux Server

1. **Create .env file:**
   ```bash
   API_BASE_URL=https://api.shopbot.africa/api
   BRANCH_ID=prod-store-1
   DEVICE_ID=prod-printer-001
   POLL_INTERVAL=3000
   LOG_LEVEL=INFO
   ```

2. **Run with Systemd:**
   ```bash
   sudo systemctl start shopbot-printer
   ```

3. **Monitor Logs:**
   ```bash
   journalctl -u shopbot-printer -f
   ```

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY . .
RUN npm install
ENV API_BASE_URL=http://api:3000/api
ENV BRANCH_ID=prod-store-1
CMD ["npm", "start"]
```

## Support

For issues or questions:
- Check logs: `LOG_LEVEL=DEBUG`
- Verify API connectivity: `curl $API_BASE_URL/health`
- Test printer: Use local printer discovery
