# ShopBot Printer - Quick Reference

## Setup (5 Minutes)

```bash
# 1. Copy .env template
cp .env.example .env

# 2. Edit .env (set API URL, branch ID)
nano .env
# API_BASE_URL=http://localhost:3000/api
# BRANCH_ID=default-branch
# DEVICE_ID=printer-001

# 3. Install dependencies
npm install

# 4. Start app
npm start
```

## Configuration

### .env File
```bash
# REQUIRED
API_BASE_URL=http://localhost:3000/api
BRANCH_ID=your-branch-id
DEVICE_ID=your-device-id

# OPTIONAL
POLL_INTERVAL=3000          # milliseconds
LOG_LEVEL=INFO              # DEBUG, INFO, WARN, ERROR
ENABLE_USB_DISCOVERY=true
ENABLE_NETWORK_DISCOVERY=false
```

## Monitoring

### Check Polling Status
```bash
curl http://localhost:4001/api/polling/status
```

### Start/Stop Polling
```bash
# Start
curl -X POST http://localhost:4001/api/polling/start

# Stop
curl -X POST http://localhost:4001/api/polling/stop
```

### Debug Mode
```bash
LOG_LEVEL=DEBUG npm start
```

## Job Processing Flow

```
1. POLL (3s) → GET /print-jobs/polling/pending
2. LOCK (atomic) → PATCH /print-jobs/:id/lock
3. SEND → Network (TCP) or USB
4. COMPLETE → PATCH /print-jobs/:id/complete
   OR FAIL → PATCH /print-jobs/:id/fail (auto-retry)
```

## Printer Setup

### Network Printer
```
IP: 192.168.1.100
Port: 9100
Type: TCP
ESC/POS compatible
```

### USB Printer
```
Auto-discovered on startup
Supported vendors: Epson, Star, Zebra, etc.
ESC/POS compatible
```

## API Endpoints

### Backend (ShopBot Server)
```
GET    /print-jobs/polling/pending     ← Poll jobs
PATCH  /print-jobs/:id/lock             ← Lock atomically
PATCH  /print-jobs/:id/complete         ← Mark success
PATCH  /print-jobs/:id/fail             ← Mark failed
```

### Local (Electron App)
```
GET    /api/polling/status              ← Polling info
POST   /api/polling/start               ← Start polling
POST   /api/polling/stop                ← Stop polling
```

## Log Levels

| Level | Usage |
|-------|-------|
| `DEBUG` | All messages (development) |
| `INFO` | Normal operation (default) |
| `WARN` | Issues that can recover |
| `ERROR` | Critical failures |

## Common Issues

### "API unreachable"
```bash
# Check backend is running
curl http://localhost:3000/api/health

# Verify .env API_BASE_URL
grep API_BASE_URL .env
```

### "No jobs being processed"
```bash
# Enable debug logging
LOG_LEVEL=DEBUG npm start

# Check branch ID matches
grep BRANCH_ID .env
curl http://localhost:3000/api/branches
```

### "Printer not found"
```bash
# USB auto-discovery should show printers
# Check console logs for device list
# Verify USB printer is connected
```

## Files Reference

| File | Purpose |
|------|---------|
| `main.js` | Polling + printer logic |
| `.env` | Configuration (keep secret!) |
| `.env.example` | Template (commit to git) |
| `POLLING_INTEGRATION.md` | Detailed guide |
| `POLLING_IMPLEMENTATION.md` | Summary |

## Important Notes

🔒 **Never commit .env to git**
- .env is in .gitignore
- Only commit .env.example

📱 **Device ID**
- Must be unique per device
- Auto-generated if not set
- Used for tracking locks

🔄 **Polling Interval**
- Default: 3000ms (3 seconds)
- Production: 3000-5000ms recommended
- Too frequent = high API load
- Too slow = delayed printing

🔐 **Atomic Locking**
- Prevents duplicate printing
- Only one device per job
- Returns 409 Conflict if locked

⚡ **Auto-Retry**
- Failed jobs retry up to 3 times
- Exponential backoff
- Max retry configurable on backend

## Testing

```bash
# Terminal 1: Start printer app
npm start

# Terminal 2: Create a test job on backend
curl -X POST http://localhost:3000/api/print-jobs/test

# Watch Terminal 1 for polling and printing
# Check status
curl http://localhost:4001/api/polling/status
```

## Production Checklist

- [ ] Copy .env.example to .env
- [ ] Set API_BASE_URL to production API
- [ ] Set BRANCH_ID to correct store
- [ ] Set DEVICE_ID with unique identifier
- [ ] Set LOG_LEVEL to INFO (not DEBUG)
- [ ] Install dependencies: `npm install`
- [ ] Test polling: `curl http://localhost:4001/api/polling/status`
- [ ] Create test job and verify printing
- [ ] Setup logging/monitoring
- [ ] Deploy Electron app

## Support Commands

```bash
# Check if polling is active
curl http://localhost:4001/api/polling/status

# View recent logs
tail -f ~/.npm-debug.log

# Test API connectivity
curl -v http://localhost:3000/api/health

# List devices
curl http://localhost:3000/api/devices

# Test specific branch
curl "http://localhost:3000/api/print-jobs/polling/pending?branchId=YOUR_BRANCH"
```

## More Info

- Read: `POLLING_INTEGRATION.md` (detailed guide)
- Read: `POLLING_IMPLEMENTATION.md` (summary)
- Code: See `main.js` polling functions
- Config: See `.env.example` template
