import { Component, OnInit, ChangeDetectionStrategy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { signal } from '@angular/core';
import { PrinterApiService } from '../../../services/printer-api.service';

@Component({
  selector: 'app-list-printers',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './list-printers.component.html',
  styleUrl: './list-printers.component.scss',
})
export class ListPrintersComponent implements OnInit {
  private printerApi = inject(PrinterApiService);
  private router = inject(Router);

  printers = signal<any[]>([]);
  isLoading = signal(false);

  ngOnInit(): void {
    this.refreshPrinters();
  }

  refreshPrinters(): void {
    this.isLoading.set(true);
    this.printerApi.getPrinters().subscribe({
      next: (printers) => {
        this.printers.set(printers);
        this.isLoading.set(false);
      },
      error: (err) => {
        console.error('Failed to load printers:', err);
        alert('Failed to load printers. Make sure the Express server is running.');
        this.isLoading.set(false);
      },
    });
  }

  goToAddPrinter(): void {
    this.router.navigate(['/printers', 'add-printer']);
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

  testPrinter(printer: any): void {
    if (printer.type === 'network') {
      this.printerApi.testPrinter(printer.ip, printer.port).subscribe({
        next: (result) => {
          alert(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
        },
        error: (err) => {
          console.error('Test failed:', err);
          alert('❌ Printer test failed.');
        },
      });
    } else if (printer.type === 'usb') {
      this.printerApi
        .testUSBPrinter(printer.vendorId, printer.productId, printer.busNumber, printer.deviceAddress, printer.id)
        .subscribe({
          next: (result) => {
            alert(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
          },
          error: (err) => {
            console.error('USB test failed:', err);
            alert('❌ USB printer test failed.');
          },
        });
    } else if (printer.type === 'bluetooth') {
      this.printerApi.testBluetoothConnection(printer.macAddress, printer.channel).subscribe({
        next: (result) => {
          alert(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
        },
        error: (err) => {
          console.error('Bluetooth test failed:', err);
          alert('❌ Bluetooth connection test failed.');
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

  getPrinterIcon(type: string): string {
    switch (type) {
      case 'network':
        return '🖨️';
      case 'usb':
        return '💾';
      case 'bluetooth':
        return '📡';
      default:
        return '🔧';
    }
  }

  getPrinterTypeName(type: string): string {
    switch (type) {
      case 'network':
        return 'Network Printer';
      case 'usb':
        return 'USB Printer';
      case 'bluetooth':
        return 'Bluetooth Printer';
      default:
        return 'Unknown';
    }
  }

  getPrinterDetails(printer: any): string {
    switch (printer.type) {
      case 'network':
        return `${printer.ip}:${printer.port}`;
      case 'usb':
        return `${printer.vendorId}:${printer.productId}`;
      case 'bluetooth':
        return `${printer.macAddress} (Ch: ${printer.channel})`;
      default:
        return 'N/A';
    }
  }
}
