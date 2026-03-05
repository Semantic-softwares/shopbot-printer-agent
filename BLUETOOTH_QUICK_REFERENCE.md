# Bluetooth Printer Quick Reference

## Quick Start

### 1. Install Dependencies
```bash
cd /Users/alexonozor/workspace/frontend/shopbot-printer
npm install
```

### 2. Add a Bluetooth Printer

**Auto-Discovery Method:**
1. Click "🔗 Scan Bluetooth" button
2. Wait for scan to complete (~30 seconds)
3. Click on printer name from list
4. Enter friendly name (e.g., "Kitchen Printer")
5. Click "✓ Add Printer"

**Manual Method:**
1. Click "➕ Add Printer"
2. Select "🔗 Bluetooth Printer" tab
3. Enter MAC address: `00:1A:2B:3C:4D:5E`
4. Enter channel: `1` (or detected value)
5. Enter friendly name
6. Click "✓ Add Printer"

### 3. Test Printer
- Click "🧪 Test" button on printer card
- Shows connection status and errors

### 4. Removing Printer
- Click "🗑️ Remove" button on printer card

## Common MAC Address Format
```
00:1A:2B:3C:4D:5E
 ↑   ↑   ↑   ↑   ↑
 HEX digits (0-F)
 
Example: 50:05:EB:40:C3:A0
```

## RFCOMM Channels
- **Channel 1**: Most common (default)
- **Channel 1-5**: Standard range for most printers
- **Channel 10-30**: Advanced/alternative
- **Auto-detect**: Recommended (finds correct channel)

## Status Indicators

| Icon | Meaning |
|------|---------|
| 🔗 | Bluetooth connection type |
| 🟢 | Online/Connected |
| 🔴 | Offline/Disconnected |
| ⏳ | Scanning in progress |
| ✓ | Successfully configured |
| ❌ | Error/Failed |

## Printer List Information

Each Bluetooth printer displays:
```
Kitchen Printer                    [🔗 Bluetooth] [●]
MAC Address: 50:05:EB:40:C3:A0
RFCOMM Channel: 1
Status: ONLINE
Last Checked: 02/17/2026, 1:45 PM

[🧪 Test] [🗑️ Remove]
```

## Keyboard Shortcuts

| Action | How |
|--------|-----|
| Scan Bluetooth | Click button or press `B` |
| Add Printer | Click button or press `A` |
| Test Printer | Click test button or press `T` |
| Cancel | Press `Esc` or click Cancel button |

## Troubleshooting Quick Fixes

### "No Bluetooth printers found"
1. Check printer is powered on
2. Verify Bluetooth is enabled on your computer
3. Try manual entry with known MAC address
4. Ensure printer is in pairing mode

### Connection test fails
1. Verify MAC address format: `XX:XX:XX:XX:XX:XX`
2. Try different RFCOMM channel (1-5)
3. Move printer closer to computer
4. Restart printer and try again

### Printer goes offline
1. Check Bluetooth signal range (max 10m)
2. Remove obstacles between devices
3. Disable other Bluetooth devices
4. Check printer battery level

### Can't find printer after adding
1. Refresh printer list (🔄 Refresh button)
2. Check printer status indicator
3. Test connection first
4. Verify MAC address is correct

## API Endpoints for Developers

```
POST /api/printers/bluetooth/discover
  → { success, discovered, printers[] }

POST /api/printers/bluetooth/get-channel
  ← { macAddress }
  → { success, macAddress, channel, message }

POST /api/printers/bluetooth/test
  ← { macAddress, channel }
  → { success, message, macAddress, channel }

POST /api/printers/bluetooth/add
  ← { name, macAddress, channel }
  → { success, printerId, message }
```

## Configuration Example

**Configured Bluetooth Printer:**
```json
{
  "id": "printer-42",
  "name": "Kitchen Thermal",
  "type": "bluetooth",
  "macAddress": "50:05:EB:40:C3:A0",
  "channel": 1,
  "status": "online",
  "lastChecked": "2026-02-17T13:45:00Z"
}
```

## Print Job Flow

```
Order Complete
    ↓
Backend creates print job
    ↓
Backend sends ESC/POS data (Base64)
    ↓
Printer app polls for pending jobs
    ↓
Job found → Connect via Bluetooth
    ↓
Send data via RFCOMM channel
    ↓
Printer receives & prints
    ↓
Mark job complete
    ↓
Success! Receipt printed ✓
```

## Files Modified

| File | Purpose |
|------|---------|
| `main.js` | Express server with Bluetooth endpoints |
| `printers.component.ts` | Component logic for Bluetooth UI |
| `printers.component.html` | Bluetooth printer UI elements |
| `printer-api.service.ts` | API methods for Bluetooth |
| `package.json` | Added bluetooth-serial-port dependency |

## Environment Requirements

```bash
# Minimum versions
Node.js:    v16+
npm:        v8+
Electron:   v27+
Angular:    v21+

# Required OS packages (Linux only)
sudo apt-get install libbluetooth-dev bluez
```

## Performance Tips

1. **Keep printers close**: Within 10 meters for stable connection
2. **Minimize interference**: Away from WiFi routers/microwaves
3. **Use channel 1**: Most compatible with thermal printers
4. **Pre-pair**: Pair in system Bluetooth before app discovery
5. **Update firmware**: Keep printer firmware current

## Common Printer Models Supported

| Brand | Model | MAC Example |
|-------|-------|------------|
| Epson | TM-m30 | 50:05:EB:40:C3:A0 |
| Star | TSP650II | 00:1F:29:82:4C:11 |
| Zebra | MC3300 | 00:0A:95:9D:68:16 |
| Bixolon | SPP-L3000 | 00:1A:2B:3C:4D:5E |
| Brother | RJ-3050 | 00:18:93:6E:B5:40 |

## Debug Logging

Enable detailed logs:
```javascript
// In main.js, set log level
config.logLevel = 'DEBUG';
```

Monitor logs in terminal:
```bash
npm start 2>&1 | grep -i bluetooth
```

## Need Help?

1. **Check logs**: Look for Bluetooth-related messages in terminal
2. **Test endpoint**: Use Postman to test `/api/printers/bluetooth/discover`
3. **Verify hardware**: Ensure Bluetooth adapter is functioning
4. **Review docs**: See BLUETOOTH_PRINTER_SETUP.md for detailed guide

## Contact & Support

For issues or questions:
- Review BLUETOOTH_IMPLEMENTATION.md for technical details
- Check application logs for error messages
- Verify printer MAC address and channel settings
- Test manually before adding to configuration
