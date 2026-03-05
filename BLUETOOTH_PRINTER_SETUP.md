# Bluetooth Printer Setup Guide

## Overview
This guide explains how to add and configure Bluetooth thermal printers in the ShopBot Printer application.

## Features

### 1. **Bluetooth Discovery**
- Scan for available Bluetooth printers on your system
- Automatically filters for thermal printer names
- Displays device name and MAC address for easy identification

### 2. **Automatic Channel Detection**
- Automatically detects the RFCOMM channel for each Bluetooth printer
- Falls back to channel 1 if not detected
- Displays channel information for manual troubleshooting

### 3. **Connection Testing**
- Test Bluetooth connectivity before adding printer to configuration
- Validates MAC address and RFCOMM channel
- Shows connection status and errors

### 4. **Manual Configuration**
- Option to manually enter MAC address if auto-discovery fails
- Customizable RFCOMM channel if auto-detection doesn't work
- Copy/paste friendly field formatting

## How to Add a Bluetooth Printer

### Method 1: Auto-Discovery (Recommended)

1. **Click "🔗 Scan Bluetooth" Button**
   - Application searches for available Bluetooth devices
   - Displays matching thermal printers with names and MAC addresses

2. **Select a Discovered Printer**
   - Click on the printer name in the discovered list
   - MAC address and channel will auto-populate
   - Shows detected RFCOMM channel

3. **Test Connection (Optional)**
   - Click "🧪 Test Connection" to verify connectivity
   - Confirms printer is reachable and responsive

4. **Add Printer**
   - Enter a friendly name for your printer
   - Click "✓ Add Printer" to save configuration
   - Printer appears in your printer list

### Method 2: Manual Entry

1. **Click "➕ Add Printer" Button**

2. **Select "🔗 Bluetooth Printer"**
   - Shows manual entry form

3. **Enter Printer Details:**
   - **Printer Name**: Friendly name for your printer (e.g., "Kitchen Printer 1")
   - **MAC Address**: Device MAC address (format: `00:1A:2B:3C:4D:5E`)
   - **RFCOMM Channel**: Channel number (usually 1, can be 1-30)

4. **Test Connection**
   - Click "🧪 Test Connection" to verify
   - Ensures MAC address and channel are correct

5. **Add Printer**
   - Click "✓ Add Printer" to save

## Printer Display

Each Bluetooth printer in your list shows:

```
Printer Name: [Kitchen Printer]
Status Badge: 🔗 Bluetooth | Online/Offline
MAC Address: 00:1A:2B:3C:4D:5E
RFCOMM Channel: 1
Status: ONLINE
Last Checked: [Timestamp]
```

## Troubleshooting

### Printer Not Found During Scan
- Ensure printer is powered on and in pairing mode
- Check that Bluetooth is enabled on your computer
- Verify printer name contains "printer", "XP-", "thermal", "receipt", "pos", "58", or "80"
- Try manual entry with known MAC address

### Connection Test Fails
1. **Verify MAC Address**
   - Check if address format is correct: `00:1A:2B:3C:4D:5E`
   - Ensure no extra spaces or hyphens

2. **Try Different RFCOMM Channel**
   - If channel detection failed, try channels 1-5
   - Most thermal printers use channel 1

3. **Pair Device First**
   - Pair printer through system Bluetooth settings first
   - Then use auto-discovery in ShopBot Printer

4. **Check Printer Status**
   - Ensure printer is not busy printing
   - Restart printer if connection persistently fails

### Printer Disappears or Goes Offline
- Bluetooth connection range issue (max ~10 meters)
- Printer battery low or powered off
- System has other Bluetooth devices interfering
- Try moving printer closer or repositioning antenna

## Technical Details

### MAC Address Format
- Standard Bluetooth MAC addresses: `XX:XX:XX:XX:XX:XX`
- Each pair represents hexadecimal values
- Example: `00:1A:2B:3C:4D:5E`

### RFCOMM Channels
- Range: 1-30 (most printers use 1-5)
- Channel determines which serial port emulation is used
- Auto-detection finds the correct channel automatically

### Supported Printer Types
Discovery automatically filters for:
- Names containing "printer" (case-insensitive)
- Thermal receipt printer models (XP-, 58mm, 80mm)
- POS system printers
- Generic printer keyword detection

## Connection Lifecycle

1. **Discovery** → Scan for devices
2. **Pairing** → (May be required by system)
3. **Connection** → Test connection
4. **Configuration** → Add to printer list
5. **Usage** → Receive print jobs via polling

## API Endpoints (Backend Reference)

### For Backend Integration

When a Bluetooth printer is configured in the frontend:

1. **Poll for print jobs**: `/api/print-jobs/polling/pending`
   - Returns jobs including `receipt.data` (Base64 encoded ESC/POS)

2. **Mark jobs complete**: `/print-jobs/{jobId}/complete`
   - Called after successful Bluetooth transmission

3. **Report job failures**: `/print-jobs/{jobId}/fail`
   - Called if connection or transmission fails

## Performance Notes

- Bluetooth scanning takes ~30 seconds
- RFCOMM channel detection adds ~5 seconds per device
- Connection test timeout: 5 seconds
- Print job retry interval: 2 seconds (up to 3 attempts)
- Connection range: Up to 10 meters (33 feet)

## File References

- **Frontend Component**: `/src/app/pages/printers/printers.component.ts`
- **API Service**: `/src/app/services/printer-api.service.ts`
- **Backend Server**: `main.js` (Express server)
- **Bluetooth Discovery Functions**:
  - `discoverBluetoothPrinters()` - Scan for devices
  - `getBluetoothDeviceChannel()` - Find RFCOMM channel
  - `testBluetoothConnection()` - Verify connectivity
  - `attemptBluetoothPrint()` - Send print jobs

## Security Notes

- MAC addresses are stored locally in application state
- Connections use standard Bluetooth serial port profile
- No authentication tokens sent over Bluetooth
- Consider pairing printer with your system first for best results
