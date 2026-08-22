import { Component, ChangeDetectionStrategy, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { PrinterApiService } from '../../../../services/printer-api.service';
import { LoadingSpinnerComponent } from '../../../../shared/components/loading-spinner/loading-spinner.component';
import { CopyFieldComponent } from '../../../../shared/components/copy-field/copy-field.component';
import {
  getPrinterIcon,
  getPrinterTypeName,
  formatPrinterTime,
  formatUsbHex,
} from '../../../../shared/utils/printer-display.util';

@Component({
  selector: 'app-printer-details',
  standalone: true,
  imports: [CommonModule, LoadingSpinnerComponent, CopyFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './printer-details.component.html',
})
export class PrinterDetailsComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private printerApi = inject(PrinterApiService);

  isLoading = signal(true);
  printer = signal<any>(null);

  icon = computed(() => getPrinterIcon(this.printer()?.type));
  typeName = computed(() => getPrinterTypeName(this.printer()?.type));
  isNetwork = computed(() => this.printer()?.type === 'network');
  isUSB = computed(() => this.printer()?.type === 'usb');
  isBluetooth = computed(() => this.printer()?.type === 'bluetooth');

  formatHex = formatUsbHex;
  formatTime = formatPrinterTime;

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    this.printerApi.getPrinters().subscribe({
      next: (printers) => {
        this.printer.set(printers.find((p) => String(p.id) === id) ?? null);
        this.isLoading.set(false);
      },
      error: (err) => {
        console.error('Failed to load printer:', err);
        this.isLoading.set(false);
      },
    });
  }

  goBack(): void {
    this.router.navigate(['/dashboard/printers']);
  }

  testPrinter(): void {
    const printer = this.printer();
    if (!printer) return;

    this.printerApi.testAnyPrinter(printer).subscribe({
      next: (result) => alert(result.success ? `✅ ${result.message}` : `❌ ${result.message}`),
      error: (err) => {
        console.error('Test failed:', err);
        alert('❌ Printer test failed.');
      },
    });
  }

  removePrinter(): void {
    const printer = this.printer();
    if (!printer || !confirm('Are you sure you want to remove this printer?')) return;

    this.printerApi.removePrinter(printer.id).subscribe({
      next: () => {
        alert('Printer removed successfully');
        this.goBack();
      },
      error: (err) => {
        console.error('Failed to remove printer:', err);
        alert('Failed to remove printer');
      },
    });
  }
}
