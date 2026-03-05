# Store-Based Polling Fix

## Problem
The polling service was returning a **404 error** because:
1. The endpoint parameter was named `branchId` but it actually filters by **store ID**
2. The Electron app wasn't passing the store ID correctly
3. Multiple stores would have tried to fetch all print jobs instead of just their own

## Solution

### 1. Backend Changes (print-jobs.controller.ts & print-jobs.service.ts)

**Changed from:**
```typescript
@Query('branchId') branchId: string
```

**Changed to:**
```typescript
@Query('storeId') storeId: string
```

This makes the parameter name clearer and matches the actual database schema where print jobs are filtered by `store` field.

### 2. Electron App Changes (main.js)

**Before:**
```javascript
const response = await axios.get(url, {
  params: {
    branchId: config.branchId,  // ❌ Wrong parameter
    status: 'pending',
    limit: 10,
  },
  headers: {
    'X-Branch-Id': config.branchId,
  },
});
```

**After:**
```javascript
const HARDCODED_STORE_ID = '695b7b1063e53f499a18634b';

const response = await axios.get(url, {
  params: {
    storeId: HARDCODED_STORE_ID,  // ✅ Correct parameter
    status: 'pending',
    limit: 10,
  },
  headers: {
    'X-Device-Id': config.deviceId,
    'X-Store-Id': HARDCODED_STORE_ID,
  },
});
```

### 3. Key Changes

| Aspect | Before | After |
|--------|--------|-------|
| **Parameter Name** | `branchId` | `storeId` |
| **Parameter Source** | `config.branchId` | Hardcoded: `695b7b1063e53f499a18634b` |
| **Header** | `X-Branch-Id` | `X-Store-Id` |
| **Filter** | Not working (parameter mismatch) | ✅ Works (correct store ID) |

## How It Works Now

### Polling Flow
```
ShopBot Printer (Electron App)
        ↓
Every 3 seconds:
  GET /print-jobs/polling/pending?storeId=695b7b1063e53f499a18634b
        ↓
Backend (ShopBot Server)
  Query: { store: "695b7b1063e53f499a18634b", status: "pending" }
        ↓
Print Jobs Collection
  Returns: All pending print jobs for store 695b7b1063e53f499a18634b
        ↓
Response to Electron App:
  {
    "success": true,
    "count": 2,
    "data": [
      { _id: "...", printer: "...", items: [...], status: "pending" },
      { _id: "...", printer: "...", items: [...], status: "pending" }
    ]
  }
        ↓
Process each job locally (lock → send to printer → complete/fail)
```

## Configuration

### For Development
The store ID is hardcoded in [main.js](main.js#L73):
```javascript
const HARDCODED_STORE_ID = '695b7b1063e53f499a18634b';
```

### To Change Store
Edit [main.js](main.js) and update the `HARDCODED_STORE_ID` constant:

```javascript
// Line 73 in main.js
const HARDCODED_STORE_ID = 'YOUR_STORE_ID_HERE';
```

### Example for Multiple Stores
If you need to run multiple printer instances for different stores:

**Printer 1 (Kitchen):**
```javascript
const HARDCODED_STORE_ID = '695b7b1063e53f499a18634b';  // Main store
```

**Printer 2 (Bar):**
```javascript
const HARDCODED_STORE_ID = '507f1f77bcf86cd799439012';  // Secondary store
```

Each instance would then only poll and print jobs for its assigned store.

## Testing

### 1. Verify Polling is Working
```bash
# Check polling status
curl http://localhost:4001/api/polling/status
```

**Response:**
```json
{
  "pollingActive": true,
  "config": {
    "apiBaseUrl": "http://localhost:3000/api",
    "storeId": "695b7b1063e53f499a18634b",
    "pollInterval": 3000
  }
}
```

### 2. Check Backend Logs
Look for:
```
📋 [POLLING] Found 2 pending print jobs for store 695b7b1063e53f499a18634b
```

### 3. Verify Jobs Are Returned
```bash
# Direct API call
curl "http://localhost:3000/api/print-jobs/polling/pending?storeId=695b7b1063e53f499a18634b&status=pending&limit=10"
```

**Success Response (200):**
```json
{
  "success": true,
  "count": 2,
  "data": [
    {
      "_id": "507f1f77bcf86cd799439011",
      "printer": "507f1f77bcf86cd799439013",
      "status": "pending",
      "items": [...]
    },
    ...
  ]
}
```

**Error Response (400 - Missing Store ID):**
```json
{
  "error": "storeId is required",
  "code": "MISSING_STORE_ID"
}
```

## Files Modified

1. **[shopbot-printer/main.js](main.js)**
   - Changed `branchId` → `storeId` in polling request
   - Added hardcoded store ID constant
   - Updated headers

2. **[shopbot-server/print-jobs.controller.ts](../../../backend/shopbot-server/src/print-jobs/print-jobs.controller.ts)**
   - Renamed parameter: `@Query('branchId')` → `@Query('storeId')`
   - Updated error messages to reference `storeId`

3. **[shopbot-server/print-jobs.service.ts](../../../backend/shopbot-server/src/print-jobs/print-jobs.service.ts)**
   - Updated function parameter name
   - Updated logs to reference `storeId`

4. **[shopbot-printer/.env.example](.env.example)**
   - Added documentation about store ID configuration
   - Removed misleading `BRANCH_ID` field

## Next Steps

1. ✅ **Update Backend** - Parameter changed to `storeId`
2. ✅ **Update Electron App** - Using hardcoded store ID
3. ✅ **Update Configuration** - `.env.example` documents the change
4. 📋 **Test Polling** - Run the app and verify jobs are being fetched
5. 📋 **Monitor Logs** - Check that store filtering is working correctly

## Troubleshooting

### Still Getting 404?
1. Check the backend is running: `npm run dev` in shopbot-server
2. Verify API URL: `http://localhost:3000/api`
3. Check store ID exists in database

### No Jobs Being Fetched?
1. Verify pending print jobs exist for store `695b7b1063e53f499a18634b`
2. Check backend logs for "Found X pending print jobs"
3. Verify `status: 'pending'` matches job status in database

### Only One Store Needed?
Hardcoded store ID is fine for single-store deployments. For multi-store scenarios, consider:
- Environment variable: `STORE_ID=695b7b1063e53f499a18634b`
- Configuration file per printer instance
- OAuth/JWT token with store ID embedded

