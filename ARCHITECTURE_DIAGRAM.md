# USB Printer Integration - Architecture Diagram

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    SHOPBOT BACK-OFFICE (Angular)                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ PrintJobService (print-job.service.ts)                          │   │
│  │ ─────────────────────────────────────────────────────────────── │   │
│  │                                                                  │   │
│  │  ✓ printOrderReceipt()                                          │   │
│  │    ├─ Check Bluetooth: isConnected()?                           │   │
│  │    ├─ If YES → Send via BluetoothPrinterService                │   │
│  │    ├─ If NO  → Create backend print job                         │   │
│  │    └─ Always → sendToNetworkPrinter() [fallback]                │   │
│  │                                                                  │   │
│  │  ✓ sendToNetworkPrinter()                                       │   │
│  │    └─ Call NetworkPrinterService.sendToPrinter()                │   │
│  │                                                                  │   │
│  │  ✓ handleAutoPrint()                                            │   │
│  │    ├─ Check order status (Complete + Paid)                      │   │
│  │    ├─ Check store settings (printAfterFinish=true)              │   │
│  │    ├─ Check Bluetooth printer connected                         │   │
│  │    └─ If ALL pass → Print via Bluetooth + Network               │   │
│  │                                                                  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                            │                                             │
│                            ├─────────────────┐                           │
│                            │                 │                           │
│  ┌────────────────────────▼──────┐  ┌───────▼─────────────────────┐    │
│  │ BluetoothPrinterService        │  │ NetworkPrinterService       │    │
│  │ ─────────────────────────────  │  │ ─────────────────────────── │    │
│  │                                │  │                             │    │
│  │ ✓ isConnected()               │  │ ✓ sendToPrinter()           │    │
│  │ ✓ sendToPrinter()             │  │ ✓ getPrinters()             │    │
│  │ ✓ getBatteryLevel()            │  │ ✓ testPrinter()             │    │
│  │ ✓ getDeviceName()              │  │ ✓ addPrinter()              │    │
│  │                                │  │ ✓ removePrinter()           │    │
│  │ (Direct device communication)  │  │ ✓ discoverUSBPrinters() ✨  │    │
│  │                                │  │ ✓ getPrintLogs()            │    │
│  │ 📱 Bluetooth Device            │  │ ✓ getQueueStats()           │    │
│  └────────────────────────────────┘  └─────────┬───────────────────┘    │
│                   │                             │                       │
│                   │ HTTP: POST /api/print      │ HTTP: POST /api/...    │
└───────────────────┼─────────────────────────────┼───────────────────────┘
                    │                             │
                    │                             │
           ┌────────▼─────────┐        ┌──────────▼────────────────────┐
           │                  │        │                               │
           │  Paired          │        │  SHOPBOT-PRINTER (Electron)   │
           │  Bluetooth        │        │                               │
           │  Printer          │        │  Express API (localhost:4000) │
           │  (Local Device)   │        │                               │
           │                  │        │  ┌────────────────────────┐   │
           │  📱              │        │  │ POST /api/print        │   │
           └──────────────────┘        │  │ POST /api/printers/*   │   │
                                       │  │ POST /api/printers/    │   │
                                       │  │   usb/discover ✨      │   │
                                       │  └──────────┬─────────────┘   │
                                       │             │                 │
                                       │  ┌──────────▼──────────┐      │
                                       │  │ main.js Functions    │      │
                                       │  ├──────────────────── │      │
                                       │  │                      │      │
                                       │  │ attemptPrint()       │      │
                                       │  │  ├─ type==='usb'?    │      │
                                       │  │  │  └─ ✨ attemptUSB  │      │
                                       │  │  └─ type==='network' │      │
                                       │  │     └─ TCP Port 9100 │      │
                                       │  │                      │      │
                                       │  │ discoverUSB         │      │
                                       │  │ Printers() ✨       │      │
                                       │  │ ├─ Scan USB devices  │      │
                                       │  │ ├─ Filter vendors    │      │
                                       │  │ ├─ Return printers   │      │
                                       │  │ └─ Add to store      │      │
                                       │  │                      │      │
                                       │  │ attemptUSBPrint() ✨ │      │
                                       │  │ ├─ Find USB device   │      │
                                       │  │ ├─ Open escpos       │      │
                                       │  │ ├─ Write data        │      │
                                       │  │ ├─ Close             │      │
                                       │  │ └─ Retry (3x)        │      │
                                       │  │                      │      │
                                       │  │ attemptNetworkPrint()│      │
                                       │  │ ├─ TCP Socket        │      │
                                       │  │ ├─ Port 9100         │      │
                                       │  │ ├─ Write data        │      │
                                       │  │ └─ Retry (3x)        │      │
                                       │  │                      │      │
                                       │  └──────────────────────┘      │
                                       │                               │
                                       └────────────────┬──────────────┘
                                                        │
                        ┌───────────────────────────────┼───────────────────────────┐
                        │                               │                           │
               ┌────────▼─────────┐        ┌────────────▼─────────┐      ┌─────────▼──────┐
               │                  │        │                      │      │                │
               │  USB Printers    │        │  Network Printers    │      │  Bluetooth     │
               │  (ESC/POS)       │        │  (ESC/POS)           │      │  Printers      │
               │                  │        │                      │      │  (via App)     │
               │  🔌 Epson TM-20  │        │  📡 TCP Port 9100    │      │                │
               │  🔌 Zjiang 8350  │        │  📡 Subnet Scanning  │      │  📱 Device     │
               │  🔌 Aopvui       │        │  📡 Auto-Status      │      │                │
               │                  │        │                      │      │                │
               │ Direct USB Conn  │        │ Ethernet/USB Network │      │ BLE/SPP        │
               └──────────────────┘        └──────────────────────┘      └────────────────┘
```

## USB Printer Detection Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ User Action: Click "Discover USB Printers" in UI                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ shopbot-back-office: NetworkPrinterService.discoverUSBPrinters()│
│                                                                  │
│  const result$ = http.post(                                     │
│    'http://localhost:4000/api/printers/usb/discover',           │
│    {}                                                           │
│  );                                                              │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP POST
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ shopbot-printer: POST /api/printers/usb/discover                │
│                                                                  │
│  expressApp.post('/api/printers/usb/discover', (req, res) => {  │
│    const usbPrinters = discoverUSBPrinters();                   │
│    res.json({                                                   │
│      success: true,                                             │
│      discovered: usbPrinters.length,                            │
│      printers: usbPrinters                                      │
│    });                                                          │
│  });                                                            │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ main.js: discoverUSBPrinters()                                  │
│                                                                  │
│  1. const usb = require('usb');                                 │
│  2. const usbDevices = usb.getDeviceList();                     │
│  3. Filter by vendor IDs:                                       │
│     ├─ 0x04B8 (Epson)                                           │
│     ├─ 0x0471 (Philips)                                         │
│     ├─ 0x067B (Prolific)                                        │
│     ├─ 0x1A86 (Zjiang)                                          │
│     └─ 0x0519 (Aopvui)                                          │
│                                                                  │
│  4. For each matching device, create:                           │
│     {                                                           │
│       id: 'usb-{busNumber}-{deviceAddress}',                   │
│       name: 'USB Printer {productId}',                          │
│       type: 'usb',                                              │
│       vendorId: ...,                                            │
│       productId: ...,                                           │
│       busNumber: ...,                                           │
│       deviceAddress: ...,                                       │
│       status: 'online',                                         │
│       lastChecked: ...                                          │
│     }                                                           │
│                                                                  │
│  5. return array of USB printers                                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ shopbot-printer: Add to printerStore                            │
│                                                                  │
│  usbPrinters.forEach((usbPrinter) => {                          │
│    if (!printerStore.printers.find(p => p.id === usbPrinter)) { │
│      printerStore.printers.push(usbPrinter);  // ✅ Added       │
│    }                                                            │
│  });                                                            │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP Response
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ shopbot-back-office: Handle Response                            │
│                                                                  │
│  result$.subscribe({                                            │
│    next: (response) => {                                        │
│      console.log(`Found ${response.discovered} USB printers`);  │
│      // Refresh printer list UI                                 │
│      this.loadPrinters();                                       │
│    },                                                           │
│    error: (err) => {                                            │
│      // Handle discovery error                                  │
│    }                                                            │
│  });                                                            │
└─────────────────────────────────────────────────────────────────┘
```

## USB Print Job Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ Order Complete → Ready to Print                                 │
│ Status: Complete, Payment: Paid                                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ shopbot-back-office: PrintJobService.printOrderReceipt()       │
│                                                                  │
│  const isPrinterConnected =                                     │
│    bluetoothPrinterService.isConnected();                       │
│                                                                  │
│  if (isPrinterConnected) {                                      │
│    // Send via Bluetooth                                        │
│    const receipt = generateOrderReceipt(order);                 │
│    bluetoothPrinterService.sendToPrinter(receipt);              │
│    // AND fallback to network                                   │
│    sendToNetworkPrinter(receipt, order);                        │
│  } else {                                                       │
│    // No Bluetooth, send to network/backend                     │
│    createPrintJobsForOrder(order);                              │
│  }                                                              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
              ┌────────────┴───────────┐
              │                        │
              ▼                        ▼
    ┌──────────────────┐   ┌──────────────────────────┐
    │ Bluetooth Printer│   │ Network Printer (USB)    │
    │ (if connected)   │   │ POST /api/print          │
    └──────────────────┘   └────────────┬─────────────┘
                                        │
                                        ▼
                        ┌──────────────────────────────────────┐
                        │ shopbot-printer: POST /api/print    │
                        │                                      │
                        │  expressApp.post('/api/print', ...) │
                        │  ├─ Create PrintJob object          │
                        │  ├─ Add to printerStore.queue[]     │
                        │  └─ Process next job                │
                        └────────────────┬───────────────────┘
                                        │
                                        ▼
                        ┌──────────────────────────────────────┐
                        │ main.js: Process Print Queue        │
                        │                                      │
                        │  // Periodic queue processor        │
                        │  setInterval(() => {                │
                        │    const job = queue.shift();       │
                        │    const printer =                  │
                        │      findPrinter(job.printerId);   │
                        │    attemptPrint(job, printer);      │
                        │  }, 500);                           │
                        └────────────────┬───────────────────┘
                                        │
                                        ▼
                        ┌──────────────────────────────────────┐
                        │ attemptPrint(job, printer)           │
                        │                                      │
                        │  if (printer.type === 'usb') {       │
                        │    ✨ attemptUSBPrint(job, printer); │
                        │  } else {                            │
                        │    attemptNetworkPrint(job, printer);│
                        │  }                                   │
                        └────────────────┬───────────────────┘
                                        │
                ┌───────────────────────┴───────────────────────┐
                │                                               │
                ▼                                               ▼
    ┌──────────────────────────────┐            ┌──────────────────────────┐
    │ attemptUSBPrint()            │            │ attemptNetworkPrint()     │
    │                              │            │                          │
    │  1. Find USB device:         │            │  1. Create TCP socket    │
    │     usb.getDeviceList()      │            │  2. Set timeout: 5000ms  │
    │     .find(dev =>             │            │  3. Connect to IP:port   │
    │       dev.busNumber ===      │            │  4. Write data           │
    │       printer.busNumber &&   │            │  5. End socket           │
    │       dev.deviceAddress ===  │            │  6. On success: mark ok  │
    │       printer.deviceAddress) │            │  7. On timeout/error:    │
    │                              │            │     retry 3 times        │
    │  2. Create escpos instance:  │            │  8. Log to database      │
    │     new escpos.USB(device)   │            │                          │
    │                              │            │                          │
    │  3. Open device:             │            └──────────────────────────┘
    │     usbDevice.open(())       │
    │                              │
    │  4. Decode & write:          │
    │     Buffer.from(data, 'base64')          ┌──────────────────────────┐
    │     usbDevice.write(data)    │            │ Both print functions:   │
    │                              │            │ ✅ Log to printerStore │
    │  5. Close:                   │            │ ✅ Mark job success    │
    │     usbDevice.close()        │            │ ✅ Retry on failure    │
    │                              │            │ ✅ Max 3 attempts      │
    │  6. On error:                │            │ ✅ 1 sec delay between │
    │     retry 3 times            │            └──────────────────────────┘
    │     with 1 sec delay         │
    └──────────────────────────────┘
                │                               │
                └───────────────┬───────────────┘
                                │
                                ▼
                ┌──────────────────────────────────┐
                │ Success ✅                       │
                │                                  │
                │  printerStore.printLogs.push({  │
                │    ...job,                       │
                │    action: 'completed',          │
                │    printer: printer.name,        │
                │    timestamp: now                │
                │  });                             │
                │                                  │
                │  Receipt printed successfully!  │
                └──────────────────────────────────┘
```

## Printer Type Detection & Routing

```
                     Print Job Arrives
                            │
                            ▼
                    ┌─────────────────┐
                    │  attemptPrint() │
                    │   (dispatcher)   │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ Check printer   │
                    │ .type property  │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         ┌────▼────┐   ┌────▼────┐   ┌───▼────┐
         │  'usb'  │   │'network' │   │'other' │
         └────┬────┘   └────┬────┘   └───┬────┘
              │             │            │
              ▼             ▼            ▼
      ┌──────────────┐  ┌──────────────┐  │
      │ attemptUSB   │  │ attemptNetwork│  Error
      │ Print()      │  │ Print()       │  
      │              │  │              │  
      │ Uses:        │  │ Uses:        │  
      │ • escpos lib │  │ • TCP socket │  
      │ • usb lib    │  │ • Port 9100  │  
      │ • Device ID  │  │ • IP:port    │  
      └──────────────┘  └──────────────┘  
```

## Dependencies & Libraries

```
┌─────────────────────────────────────────────────┐
│ shopbot-printer/package.json                    │
├─────────────────────────────────────────────────┤
│                                                 │
│ "escpos": "^2.5.2"                              │
│ └─ ESC/POS printer command library              │
│    ├─ Supports USB devices                      │
│    ├─ Supports Network printers                 │
│    ├─ Handles: text, image, cuts, etc.          │
│    └─ Uses thermal printer protocol             │
│                                                 │
│ "usb": "^2.17.0"                                │
│ └─ USB device detection & communication         │
│    ├─ Lists connected USB devices               │
│    ├─ Gets device descriptors                   │
│    ├─ Identifies vendor/product IDs             │
│    └─ Provides USB I/O functionality            │
│                                                 │
│ "express": "^4.18.2"                            │
│ └─ HTTP server framework                        │
│    ├─ API endpoints                             │
│    ├─ Request/response handling                 │
│    └─ CORS support                              │
│                                                 │
│ "cors": "^2.8.5"                                │
│ └─ Cross-Origin Resource Sharing                │
│    ├─ Allows back-office requests               │
│    └─ Security headers                          │
│                                                 │
└─────────────────────────────────────────────────┘
```

## Supported Printer Vendors

```
┌────────────────────────────────────────────────────────────┐
│ USB Printer Vendor Detection                               │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  0x04B8 (Epson)              0x0471 (Philips)             │
│  └─ TM-T20                   └─ POS Printers              │
│  └─ TM-T88                                                │
│  └─ TM-L90                                                │
│                                                             │
│  0x067B (Prolific)           0x1A86 (Zjiang)              │
│  └─ USB Serial               └─ ZJ-8350                  │
│  └─ Generic drivers          └─ ZJ-58                    │
│                                                             │
│  0x0519 (Aopvui)                                           │
│  └─ Budget thermal printers                               │
│  └─ Generic ESC/POS                                       │
│                                                             │
│ To add new vendor:                                         │
│  1. Identify vendor ID (0xXXXX)                            │
│  2. Add to printerVendorIds array                          │
│  3. Test USB discovery                                    │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

---

**Key Takeaway**: USB printers are detected by scanning USB devices, filtering by vendor ID, and storing device identifiers (busNumber + deviceAddress). Print jobs are routed based on printer type (usb vs network) and sent using the appropriate protocol (escpos USB or TCP socket).
