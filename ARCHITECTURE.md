# System Architecture & Data Flow

## High-Level Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                    ShopBot Printer                             │
│                  (Electron App)                                │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  main.js                                                │ │
│  │  ├─ Polling System                                      │ │
│  │  │  ├─ Every 3 seconds                                  │ │
│  │  │  ├─ Fetch from API                                  │ │
│  │  │  └─ Process jobs                                    │ │
│  │  ├─ Printer Service                                    │ │
│  │  │  ├─ Network (TCP 9100)                             │ │
│  │  │  └─ USB (Direct)                                   │ │
│  │  ├─ Logger                                             │ │
│  │  │  ├─ DEBUG                                           │ │
│  │  │  ├─ INFO                                            │ │
│  │  │  ├─ WARN                                            │ │
│  │  │  └─ ERROR                                           │ │
│  │  └─ Express Server (4001)                             │ │
│  │     ├─ /api/polling/status                            │ │
│  │     ├─ /api/polling/start                             │ │
│  │     └─ /api/polling/stop                              │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                                │
│  Configuration (.env)                                         │
│  └─ API_BASE_URL                                             │
│  └─ BRANCH_ID                                                │
│  └─ DEVICE_ID                                                │
│  └─ POLL_INTERVAL                                            │
│  └─ LOG_LEVEL                                                │
└────────────────────────────────────────────────────────────────┘
                    │                    │
                    │ HTTP/REST          │
         ┌──────────┴────────────┐      │
         ▼                       ▼      │
    ┌─────────────┐    ┌──────────────┐│
    │  Backend    │    │   Printers   ││
    │   API       │    │              ││
    │ (Port 3000) │    │ ├─ Network   ││
    └─────────────┘    │ │  (TCP)     ││
                       │ └─ USB       ││
                       └──────────────┘│
                                       │
                              (Thermal Paper Out)
```

## Polling Loop Sequence

```
Time T: 0s
┌─────────────────────────────────────────────────────────────┐
│ Start Polling Loop                                          │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 1. GET /print-jobs/polling/pending?branchId=xxx            │
│    └─ Query params: status=pending, limit=10              │
│    └─ Headers: X-Device-Id, X-Branch-Id                   │
└─────────────────────────────────────────────────────────────┘
                          ↓
              ┌───────────┴───────────┐
              │                       │
              ▼                       ▼
    ┌──────────────────┐   ┌──────────────────┐
    │ Jobs Found (2)   │   │ No Jobs          │
    └────────┬─────────┘   └──────────────────┘
             │
             ▼
    FOR EACH JOB:
    ┌─────────────────────────────────────────────────────────┐
    │ 2. LOCK JOB (Atomic)                                    │
    │    PATCH /print-jobs/{id}/lock                          │
    │    Body: { deviceId: "printer-device-001" }            │
    └──────────┬──────────────────────────────────────────────┘
               │
        ┌──────┴──────┐
        │             │
        ▼             ▼
    ┌────────┐   ┌──────────┐
    │ LOCKED │   │ CONFLICT │
    │        │   │ (409)    │
    └────┬───┘   └──────────┘
         │        (Skip - Another
         │         device locked)
         ▼
    ┌─────────────────────────────────────────────────────────┐
    │ 3. FIND PRINTER                                         │
    │    ├─ By printerId (preferred)                          │
    │    └─ Or first online printer                           │
    └──────────┬──────────────────────────────────────────────┘
               │
        ┌──────┴──────┐
        │             │
        ▼             ▼
    ┌─────────┐  ┌──────────┐
    │ FOUND   │  │ NOT FOUND│
    └────┬────┘  └─ FAIL JOB┘
         │
         ▼
    ┌─────────────────────────────────────────────────────────┐
    │ 4. PARSE ESC/POS PAYLOAD                               │
    │    ├─ From Base64                                       │
    │    ├─ From Hex                                          │
    │    └─ From UTF8                                         │
    └──────────┬──────────────────────────────────────────────┘
               │
        ┌──────┴──────┐
        │             │
        ▼             ▼
    ┌─────────┐  ┌──────────┐
    │ VALID   │  │ INVALID  │
    └────┬────┘  └─ FAIL JOB┘
         │
         ▼
    ┌─────────────────────────────────────────────────────────┐
    │ 5. SEND TO PRINTER                                      │
    │    ├─ Network: TCP socket to IP:9100                    │
    │    └─ USB: Direct USB transfer                          │
    └──────────┬──────────────────────────────────────────────┘
               │
        ┌──────┴──────┐
        │             │
        ▼             ▼
    ┌──────────┐  ┌──────────┐
    │ SUCCESS  │  │ FAILED   │
    └────┬─────┘  └────┬─────┘
         │             │
         ▼             ▼
    ┌─────────────────┐ ┌──────────────────────┐
    │ COMPLETE JOB    │ │ FAIL JOB             │
    │                 │ │ ├─ Retry < 3         │
    │ PATCH /:id/     │ │ │  └─ Status: pending│
    │ complete        │ │ └─ Retry >= 3        │
    │                 │ │    └─ Status: failed │
    │                 │ │                      │
    │                 │ │ PATCH /:id/fail      │
    └─────────────────┘ └──────────────────────┘
         │                     │
         └─────────┬───────────┘
                   │
                   ▼
             ┌──────────────┐
             │ WAIT 3 SECS  │
             └──────┬───────┘
                    │
                    ▼
             ┌──────────────┐
             │ NEXT POLL    │
             └──────────────┘
```

## Job State Diagram

```
┌─────────┐
│ Pending │  ← Job waiting to be processed
└────┬────┘
     │ (Lock acquired)
     ▼
┌──────────────┐
│ Processing   │  ← Device is printing
└──────┬───────┘
       │
    ┌──┴──┐
    │     │
    ▼     ▼
 ┌────┐ ┌──────┐
 │OK  │ │ERROR │
 └─┬──┘ └───┬──┘
   │        │
   ▼        ▼
┌───────┐ ┌─────────────────┐
│Success│ │ Retry < 3?      │
└───────┘ └────┬────┐───────┘
               │YES │NO
               ▼    │
            ┌──────┐▼
            │Reset │┌─────┐
            │to    ││Failed│
            │Pending││     │
            └──────┘└─────┘
             (Auto-retry)
```

## Config & Environment

```
.env File
┌────────────────────────────────────┐
│ API_BASE_URL                       │
│ └─ http://localhost:3000/api       │
│                                    │
│ BRANCH_ID                          │
│ └─ default-branch                  │
│                                    │
│ DEVICE_ID                          │
│ └─ printer-device-001              │
│                                    │
│ POLL_INTERVAL                      │
│ └─ 3000 (milliseconds)             │
│                                    │
│ LOG_LEVEL                          │
│ └─ INFO (DEBUG/WARN/ERROR)         │
└────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────┐
│ config object in main.js           │
│                                    │
│ {                                  │
│   apiBaseUrl,                      │
│   branchId,                        │
│   deviceId,                        │
│   pollInterval,                    │
│   logLevel                         │
│ }                                  │
└────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────┐
│ Used by:                           │
│ ├─ API calls (axios)               │
│ ├─ Logging (console)               │
│ └─ Polling interval (setInterval)  │
└────────────────────────────────────┘
```

## API Call Sequence

```
Time: T0
┌─────────────────────────────────────────────────────┐
│ Client (Electron)           Server (Backend)        │
├─────────────────────────────────────────────────────┤
│                                                     │
│  GET /print-jobs/polling/pending          ──────→  │
│  Headers:                                           │
│  - X-Device-Id: printer-001                        │
│  - X-Branch-Id: branch-1                           │
│                                                     │
│  Query Params:                                      │
│  - branchId: branch-1                              │
│  - status: pending                                 │
│  - limit: 10                                       │
│                                            ←──────  │
│                            ┌─ Job 1                │
│  Response:                 ├─ Job 2                │
│  {                         └─ Job 3                │
│    success: true,                                  │
│    count: 3,                                       │
│    data: [...]                                     │
│  }                                                 │
│                                                     │
├─────────────────────────────────────────────────────┤
│  FOR Job 1:                                        │
│  PATCH /print-jobs/job-1/lock         ──────→      │
│  {                                                 │
│    deviceId: printer-001                          │
│  }                                                │
│                                         ←──────    │
│                            ✅ Locked              │
│                                                    │
├─────────────────────────────────────────────────────┤
│  [Send to Printer - Internal]                      │
│  Network:  TCP socket → 192.168.1.100:9100       │
│  USB:      Direct USB transfer                    │
│                                                    │
├─────────────────────────────────────────────────────┤
│  PATCH /print-jobs/job-1/complete     ──────→     │
│  {                                                 │
│    deviceId: printer-001                         │
│  }                                                │
│                                         ←──────    │
│                            ✅ Complete             │
│                            (success)              │
│                                                    │
├─────────────────────────────────────────────────────┤
│  [If Failed instead]                               │
│  PATCH /print-jobs/job-1/fail         ──────→     │
│  {                                                 │
│    errorMessage: "...",                           │
│    deviceId: printer-001                         │
│  }                                                │
│                                         ←──────    │
│                            ✅ Failed               │
│                            (retry: < 3)          │
│                                                    │
└─────────────────────────────────────────────────────┘
```

## Printer Connection Paths

```
┌──────────────────┐
│   Print Job      │
│   (ESC/POS)      │
└────────┬─────────┘
         │
    ┌────┴────┐
    │          │
    ▼          ▼
┌──────────┐ ┌─────────┐
│ Network  │ │   USB   │
│ Printer  │ │Printer  │
└────┬─────┘ └────┬────┘
     │            │
     │            ▼
     │       ┌──────────────────────┐
     │       │ usb.getDeviceList()  │
     │       │                      │
     │       │ Find by:             │
     │       │ - vendorId           │
     │       │ - productId          │
     │       │ - busNumber          │
     │       │ - deviceAddress      │
     │       └──────┬───────────────┘
     │              │
     │              ▼
     │       ┌──────────────────────┐
     │       │ device.open()        │
     │       │ iface = interfaces[0]│
     │       │ iface.claim()        │
     │       │ endpoint = find OUT  │
     │       └──────┬───────────────┘
     │              │
     ▼              ▼
┌──────────────────────────────────┐
│ Send Data                         │
│                                  │
│ Network: socket.write(buffer)    │
│ USB: endpoint.transfer(buffer)   │
└──────────┬───────────────────────┘
           │
       ┌───┴───┐
       │       │
       ▼       ▼
    ┌─────┐ ┌──────┐
    │ ✅  │ │ ❌   │
    │Done │ │Error │
    └─────┘ └──────┘
     │       │
     ▼       ▼
  Complete Fail
  & Retry
```

## Complete System Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                   ShopBot Printer System                        │
└─────────────────────────────────────────────────────────────────┘

User Interaction
│
▼
┌─────────────────────────────────────────────────────────────────┐
│ Create Order                                                    │
│ └─ Store assigns items to stations                             │
│ └─ Generate ESC/POS receipt                                    │
│ └─ Create PrintJob in database                                 │
└────────┬────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│ ShopBot Printer App (This Machine)                             │
│                                                                │
│ 1. Load Config (.env)                                         │
│    └─ apiBaseUrl, branchId, deviceId, pollInterval, logLevel  │
│                                                                │
│ 2. Start Services                                             │
│    ├─ Express server (4001)                                   │
│    ├─ USB discovery                                           │
│    └─ Polling loop (3 second interval)                        │
│                                                                │
│ 3. POLLING LOOP (Continuous)                                  │
│    ├─ Every 3 seconds                                         │
│    ├─ GET /print-jobs/polling/pending                         │
│    │                                                           │
│    └─ For each job:                                           │
│       ├─ PATCH /print-jobs/:id/lock (atomic)                  │
│       ├─ Send to printer (Network or USB)                     │
│       ├─ PATCH /print-jobs/:id/complete (success)             │
│       │  OR                                                    │
│       └─ PATCH /print-jobs/:id/fail (auto-retry)              │
└────────┬────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Physical Printer                                                │
│                                                                │
│ ├─ Network (TCP 9100)                                         │
│ │  └─ IP address → receives ESC/POS → prints                │
│ │                                                             │
│ └─ USB Direct                                                 │
│    └─ USB endpoint → receives ESC/POS → prints              │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Thermal Receipt Paper Out                                       │
└─────────────────────────────────────────────────────────────────┘
```

## Logging Structure

```
Log Entry Format:
┌──────────────────────────────────────────────────────┐
│ EMOJI [TIMESTAMP] [LEVEL] [CONTEXT] MESSAGE [DATA]  │
├──────────────────────────────────────────────────────┤
│ 📋    2024-02-14T...   INFO   Polling    Started     │
│ ⚠️    2024-02-14T...   WARN   JobProc    Timeout     │
│ ❌    2024-02-14T...   ERROR  Printer    Failed      │
│ 🔍    2024-02-14T...   DEBUG  PayParser  Parsing..   │
│ ✅    2024-02-14T...   INFO   JobProc    Complete    │
└──────────────────────────────────────────────────────┘

Flow:
┌─────────────────────────────────────────┐
│ logMessage(level, context, msg, data)   │
├─────────────────────────────────────────┤
│                                         │
│ Check: level >= config.logLevel         │
│                                         │
│ If yes:                                 │
│  - Format message                       │
│  - Add emoji                            │
│  - Add timestamp                        │
│  - Print to console                     │
│                                         │
│ If no:                                  │
│  - Suppress (skip)                      │
└─────────────────────────────────────────┘
```

---

## Key Takeaways

✅ **Atomic Locking** - Only one device per job (409 Conflict if locked)  
✅ **Auto-Retry** - Failed jobs retry automatically (up to 3 times)  
✅ **Dual Printing** - Network (TCP 9100) and USB support  
✅ **.env Config** - Easy setup via environment variables  
✅ **Structured Logging** - Multiple severity levels for debugging  
✅ **Status Endpoints** - HTTP API for monitoring and control  
✅ **Graceful Degradation** - Continues polling even if API fails  

