import { Component, OnInit, ChangeDetectionStrategy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { signal, computed } from '@angular/core';
import { PrinterApiService } from '../../services/printer-api.service';

@Component({
  selector: 'app-printers',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './printers.component.html',
})
export class PrintersComponent implements OnInit {
  private printerApi = inject(PrinterApiService);

  printers = signal<any[]>([]);
  discoveredPrinters = signal<any[]>([]);
  discoveredBluetoothPrinters = signal<any[]>([]);
  isScanning = signal(false);
  isBluetoothScanning = signal(false);
  showAddForm = signal(false);
  printerType = signal<'network' | 'bluetooth'>('network');
  
  // Network printer fields
  newPrinterName = signal('');
  newPrinterIp = signal('');
  newPrinterPort = signal('9100');
  
  // Bluetooth printer fields
  bluetoothPrinterName = signal('');
  bluetoothMacAddress = signal('');
  bluetoothChannel = signal('1');
  showBluetoothDetails = signal(false);
  selectedBluetoothDevice = signal<any>(null);
  bluetoothDeviceChannel = signal<number | null>(null);
  
  discoveredPrinterNames: { [key: string]: string } = {};

  isAddFormValid = computed(() => {
    if (this.printerType() === 'network') {
      return (
        this.newPrinterName().trim().length > 0 &&
        this.newPrinterIp().trim().length > 0 &&
        this.newPrinterPort().trim().length > 0
      );
    } else {
      return (
        this.bluetoothPrinterName().trim().length > 0 &&
        this.bluetoothMacAddress().trim().length > 0 &&
        this.bluetoothChannel().trim().length > 0
      );
    }
  });

  ngOnInit(): void {
    this.refreshPrinters();
  }

  refreshPrinters(): void {
    this.printerApi.getPrinters().subscribe({
      next: (printers) => {
        this.printers.set(printers);
      },
      error: (err) => {
        console.error('Failed to load printers:', err);
        alert('Failed to load printers. Make sure the Express server is running.');
      },
    });
  }

  toggleAddPrinterForm(): void {
    this.showAddForm.update((v) => !v);
    this.printerType.set('network');
    this.resetForms();
  }

  resetForms(): void {
    this.newPrinterName.set('');
    this.newPrinterIp.set('');
    this.newPrinterPort.set('9100');
    this.bluetoothPrinterName.set('');
    this.bluetoothMacAddress.set('');
    this.bluetoothChannel.set('1');
    this.selectedBluetoothDevice.set(null);
    this.bluetoothDeviceChannel.set(null);
    this.showBluetoothDetails.set(false);
  }

  setPrinterType(type: 'network' | 'bluetooth'): void {
    this.printerType.set(type);
  }

  // Network Printer Methods
  addPrinter(): void {
    if (!this.isAddFormValid()) return;

    this.printerApi.addPrinter(this.newPrinterName(), this.newPrinterIp(), parseInt(this.newPrinterPort())).subscribe({
      next: (result) => {
        if (result.success) {
          alert('Printer added successfully!');
          this.resetForms();
          this.showAddForm.set(false);
          this.refreshPrinters();
        }
      },
      error: (err) => {
        console.error('Failed to add printer:', err);
        alert('Failed to add printer. Check the IP and port.');
      },
    });
  }

  testPrinter(ip: string, port: number): void {
    this.printerApi.testPrinter(ip, port).subscribe({
      next: (result) => {
        if (result.success) {
          alert(`✅ ${result.message}`);
        } else {
          alert(`❌ ${result.message}`);
        }
      },
      error: (err) => {
        console.error('Test failed:', err);
        alert('❌ Printer test failed. Connection timeout.');
      },
    });
  }

  testUSBPrinter(printer: any): void {
    this.printerApi.testUSBPrinter(printer.vendorId, printer.productId, printer.busNumber, printer.deviceAddress, printer.id).subscribe({
      next: (result) => {
        if (result.success) {
          alert(`✅ ${result.message}`);
        } else {
          alert(`❌ ${result.message}`);
        }
      },
      error: (err) => {
        console.error('USB test failed:', err);
        alert('❌ USB printer test failed.');
      },
    });
  }

  removePrinter(printerId: string): void {
    if (confirm('Are you sure you want to remove this printer?')) {
      this.printerApi.removePrinter(printerId).subscribe({
        next: () => {
          alert('Printer removed successfully');
          this.refreshPrinters();
        },
        error: (err) => {
          console.error('Failed to remove printer:', err);
          alert('Failed to remove printer');
        },
      });
    }
  }

  formatTime(timestamp: string): string {
    try {
      const date = new Date(timestamp);
      return date.toLocaleString();
    } catch {
      return 'N/A';
    }
  }

  scanNetwork(): void {
    this.isScanning.set(true);
    this.discoveredPrinters.set([]);
    this.discoveredPrinterNames = {};

    // Get the local IP to determine the subnet
    const subnet = this.getLocalSubnet();

    this.printerApi.discoverPrinters(subnet).subscribe({
      next: (result: any) => {
        this.isScanning.set(false);
        const allPrinters = result.printers || result;
        if (Array.isArray(allPrinters) && allPrinters.length > 0) {
          this.discoveredPrinters.set(allPrinters);
          allPrinters.forEach((p: any) => {
            if (p.type === 'usb') {
              this.discoveredPrinterNames[p.id] = p.name || `USB Printer`;
            } else {
              this.discoveredPrinterNames[p.ip] = `Printer ${p.ip.split('.').pop()}`;
            }
          });
          const networkCount = result.networkPrinters?.length || 0;
          const usbCount = result.usbPrinters?.length || 0;
          alert(`✅ Found ${allPrinters.length} printer(s) - ${networkCount} network, ${usbCount} USB`);
        } else {
          alert('❌ No printers found. Make sure your printers are connected and powered on.');
        }
      },
      error: (err: any) => {
        this.isScanning.set(false);
        console.error('Scan failed:', err);
        alert('❌ Scan failed. Make sure the server is running.');
      },
    });
  }

  // Bluetooth Printer Methods
  scanBluetooth(): void {
    this.isBluetoothScanning.set(true);
    this.discoveredBluetoothPrinters.set([]);

    this.printerApi.discoverBluetoothPrinters().subscribe({
      next: (result) => {
        this.isBluetoothScanning.set(false);
        if (result.success && result.printers.length > 0) {
          this.discoveredBluetoothPrinters.set(result.printers);
          alert(`✅ Found ${result.discovered} Bluetooth printer(s)`);
        } else {
          alert('❌ No Bluetooth printers found. Make sure your printers are powered on and discoverable.');
        }
      },
      error: (err: any) => {
        this.isBluetoothScanning.set(false);
        console.error('Bluetooth scan failed:', err);
        alert('❌ Bluetooth scan failed. Make sure Bluetooth is enabled on your system.');
      },
    });
  }

  selectBluetoothDevice(device: any): void {
    this.selectedBluetoothDevice.set(device);
    this.bluetoothMacAddress.set(device.macAddress);
    this.getBluetoothChannel(device.macAddress);
  }

  getBluetoothChannel(macAddress: string): void {
    this.printerApi.getBluetoothDeviceChannel(macAddress).subscribe({
      next: (result) => {
        if (result.success) {
          this.bluetoothDeviceChannel.set(result.channel);
          this.bluetoothChannel.set(result.channel.toString());
        }
      },
      error: (err) => {
        console.error('Failed to get Bluetooth channel:', err);
        this.bluetoothDeviceChannel.set(1);
        this.bluetoothChannel.set('1');
      },
    });
  }

  testBluetoothConnection(): void {
    const macAddress = this.bluetoothMacAddress();
    const channel = parseInt(this.bluetoothChannel());

    this.printerApi.testBluetoothConnection(macAddress, channel).subscribe({
      next: (result) => {
        if (result.success) {
          alert(`✅ ${result.message}`);
        } else {
          alert(`❌ ${result.message}`);
        }
      },
      error: (err) => {
        console.error('Test failed:', err);
        alert('❌ Bluetooth connection test failed.');
      },
    });
  }

  addBluetoothPrinter(): void {
    if (!this.isAddFormValid()) return;

    const name = this.bluetoothPrinterName();
    const macAddress = this.bluetoothMacAddress();
    const channel = parseInt(this.bluetoothChannel());

    this.printerApi.addBluetoothPrinter(name, macAddress, channel).subscribe({
      next: (result) => {
        if (result.success) {
          alert(`✅ ${result.message}`);
          this.resetForms();
          this.showAddForm.set(false);
          this.refreshPrinters();
        }
      },
      error: (err) => {
        console.error('Failed to add Bluetooth printer:', err);
        alert('Failed to add Bluetooth printer.');
      },
    });
  }

  addDiscoveredBluetoothPrinter(device: any): void {
    this.bluetoothPrinterName.set(device.name);
    this.bluetoothMacAddress.set(device.macAddress);
    this.getBluetoothChannel(device.macAddress);
    this.showBluetoothDetails.set(true);
  }

  clearDiscoveredBluetooth(): void {
    this.discoveredBluetoothPrinters.set([]);
    this.showBluetoothDetails.set(false);
  }

  private getLocalSubnet(): string {
    // Try to get the actual local subnet from the window
    // Falls back to common defaults if not available
    try {
      const hostname = window.location.hostname;
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return '192.168.1';
      }
      // For other cases, extract subnet from the current IP if available
      return '192.168.1'; // Safe default
    } catch {
      return '192.168.1';
    }
  }

  addDiscoveredPrinter(idOrIp: string, port?: number): void {
    const printer = this.discoveredPrinters().find((p) => p.ip === idOrIp || p.id === idOrIp);
    
    if (!printer) {
      alert('Printer not found');
      return;
    }

    if (printer.type === 'usb') {
      // Handle USB printer
      const name = this.discoveredPrinterNames[printer.id] || printer.name;
      const printerData = {
        name,
        type: 'usb',
        vendorId: printer.vendorId,
        productId: printer.productId,
        busNumber: printer.busNumber,
        deviceAddress: printer.deviceAddress,
      };

      this.printerApi.addUSBPrinter(printerData).subscribe({
        next: (result: any) => {
          if (result.success) {
            alert(`✅ USB Printer ${name} added successfully!`);
            this.refreshPrinters();
            const updated = this.discoveredPrinters().filter((p) => p.id !== printer.id);
            this.discoveredPrinters.set(updated);
          }
        },
        error: (err: any) => {
          console.error('Failed to add USB printer:', err);
          alert('Failed to add USB printer');
        },
      });
    } else {
      // Handle Network printer
      const name = this.discoveredPrinterNames[printer.ip] || `Printer ${printer.ip.split('.').pop()}`;
      if (!name.trim()) {
        alert('Please enter a printer name');
        return;
      }

      this.printerApi.addPrinter(name, printer.ip, printer.port).subscribe({
        next: (result: any) => {
          if (result.success) {
            alert(`✅ Printer ${name} added successfully!`);
            this.refreshPrinters();
            const updated = this.discoveredPrinters().filter((p) => p.ip !== printer.ip);
            this.discoveredPrinters.set(updated);
          }
        },
        error: (err: any) => {
          console.error('Failed to add printer:', err);
          alert('Failed to add printer');
        },
      });
    }
  }

  clearDiscovered(): void {
    this.discoveredPrinters.set([]);
    this.discoveredPrinterNames = {};
  }

  /**
   * Convert decimal number to hexadecimal format (e.g., 418 -> "01A2")
   * @param value - Decimal number to convert
   * @param length - Pad to this length (default 4)
   * @returns Hexadecimal string in uppercase
   */
  toHex(value: number, length: number = 4): string {
    return value.toString(16).toUpperCase().padStart(length, '0');
  }
}
