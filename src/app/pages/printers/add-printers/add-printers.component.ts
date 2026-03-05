import { Component, ChangeDetectionStrategy, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { PrinterApiService } from '../../../services/printer-api.service';

@Component({
  selector: 'app-add-printers',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './add-printers.component.html',
  styleUrl: './add-printers.component.scss',
})
export class AddPrintersComponent {
  private printerApi = inject(PrinterApiService);
  private router = inject(Router);

  printerType = signal<'network' | 'usb' | 'bluetooth'>('network');

  // Network Printer
  networkName = signal('');
  networkIp = signal('');
  networkPort = signal('9100');

  // USB Printer
  discoveredUSBPrinters = signal<any[]>([]);
  isUSBScanning = signal(false);
  selectedUSBPrinter = signal<any>(null);
  usbPrinterName = signal('');

  // Bluetooth Printer
  discoveredBluetoothPrinters = signal<any[]>([]);
  isBluetoothScanning = signal(false);
  selectedBluetoothDevice = signal<any>(null);
  bluetoothName = signal('');
  bluetoothChannel = signal('1');

  isNetworkFormValid = computed(() => {
    return (
      this.networkName().trim().length > 0 &&
      this.networkIp().trim().length > 0 &&
      this.networkPort().trim().length > 0
    );
  });

  isUSBFormValid = computed(() => {
    return this.selectedUSBPrinter() && this.usbPrinterName().trim().length > 0;
  });

  isBluetoothFormValid = computed(() => {
    return (
      this.selectedBluetoothDevice() &&
      this.bluetoothName().trim().length > 0 &&
      this.bluetoothChannel().trim().length > 0
    );
  });

  goBack(): void {
    this.router.navigate(['/printers']);
  }

  setPrinterType(type: 'network' | 'usb' | 'bluetooth'): void {
    this.printerType.set(type);
  }

  // Network Printer Methods
  addNetworkPrinter(): void {
    if (!this.isNetworkFormValid()) return;

    this.printerApi.addPrinter(this.networkName(), this.networkIp(), parseInt(this.networkPort())).subscribe({
      next: (result) => {
        if (result.success) {
          alert('✅ Network printer added successfully!');
          this.goBack();
        }
      },
      error: (err) => {
        console.error('Failed to add printer:', err);
        alert('❌ Failed to add network printer. Check the IP and port.');
      },
    });
  }

  // USB Printer Methods
  scanUSBPrinters(): void {
    this.isUSBScanning.set(true);
    this.discoveredUSBPrinters.set([]);

    this.printerApi.discoverPrinters('192.168.1').subscribe({
      next: (result: any) => {
        this.isUSBScanning.set(false);
        const usbPrinters = result.usbPrinters || [];
        if (usbPrinters.length > 0) {
          this.discoveredUSBPrinters.set(usbPrinters);
          alert(`✅ Found ${usbPrinters.length} USB printer(s)`);
        } else {
          alert('❌ No USB printers found. Make sure your printer is connected.');
        }
      },
      error: (err: any) => {
        this.isUSBScanning.set(false);
        console.error('USB scan failed:', err);
        alert('❌ USB scan failed. Make sure the server is running.');
      },
    });
  }

  selectUSBPrinter(printer: any): void {
    this.selectedUSBPrinter.set(printer);
    this.usbPrinterName.set(printer.name || `USB Printer ${printer.productId}`);
  }

  addUSBPrinter(): void {
    if (!this.isUSBFormValid()) return;

    const selected = this.selectedUSBPrinter();
    const printerData = {
      name: this.usbPrinterName(),
      type: 'usb',
      vendorId: selected.vendorId,
      productId: selected.productId,
      busNumber: selected.busNumber,
      deviceAddress: selected.deviceAddress,
    };

    this.printerApi.addUSBPrinter(printerData).subscribe({
      next: (result: any) => {
        if (result.success) {
          alert('✅ USB printer added successfully!');
          this.goBack();
        }
      },
      error: (err: any) => {
        console.error('Failed to add USB printer:', err);
        alert('❌ Failed to add USB printer');
      },
    });
  }

  clearUSBSelection(): void {
    this.selectedUSBPrinter.set(null);
    this.usbPrinterName.set('');
    this.discoveredUSBPrinters.set([]);
  }

  // Bluetooth Printer Methods
  scanBluetoothPrinters(): void {
    this.isBluetoothScanning.set(true);
    this.discoveredBluetoothPrinters.set([]);

    this.printerApi.discoverBluetoothPrinters().subscribe({
      next: (result) => {
        this.isBluetoothScanning.set(false);
        if (result.success && result.printers.length > 0) {
          this.discoveredBluetoothPrinters.set(result.printers);
          alert(`✅ Found ${result.printers.length} Bluetooth device(s)`);
        } else {
          alert('❌ No Bluetooth devices found. Make sure devices are powered on and discoverable.');
        }
      },
      error: (err: any) => {
        this.isBluetoothScanning.set(false);
        console.error('Bluetooth scan failed:', err);
        alert('❌ Bluetooth scan failed. Make sure Bluetooth is enabled.');
      },
    });
  }

  selectBluetoothDevice(device: any): void {
    this.selectedBluetoothDevice.set(device);
    this.bluetoothName.set(device.name || `Bluetooth Device ${device.macAddress}`);
  }

  addBluetoothPrinter(): void {
    if (!this.isBluetoothFormValid()) return;

    const selected = this.selectedBluetoothDevice();
    this.printerApi.addBluetoothPrinter(this.bluetoothName(), selected.macAddress, parseInt(this.bluetoothChannel())).subscribe({
      next: (result) => {
        if (result.success) {
          alert('✅ Bluetooth printer added successfully!');
          this.goBack();
        }
      },
      error: (err) => {
        console.error('Failed to add Bluetooth printer:', err);
        alert('❌ Failed to add Bluetooth printer');
      },
    });
  }

  clearBluetoothSelection(): void {
    this.selectedBluetoothDevice.set(null);
    this.bluetoothName.set('');
    this.bluetoothChannel.set('1');
    this.discoveredBluetoothPrinters.set([]);
  }
}
