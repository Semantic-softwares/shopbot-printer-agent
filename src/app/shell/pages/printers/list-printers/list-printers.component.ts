import { Component, OnInit, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { PrinterApiService } from '../../../../services/printer-api.service';
import { LoadingSpinnerComponent } from '../../../../shared/components/loading-spinner/loading-spinner.component';
import { PrinterCardComponent } from '../printer-card/printer-card.component';

@Component({
  selector: 'app-list-printers',
  standalone: true,
  imports: [CommonModule, LoadingSpinnerComponent, PrinterCardComponent],
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
    this.router.navigate(['/dashboard/printers', 'add-printer']);
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
    this.printerApi.testAnyPrinter(printer).subscribe({
      next: (result) => {
        alert(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
      },
      error: (err) => {
        console.error('Test failed:', err);
        alert('❌ Printer test failed.');
      },
    });
  }
}
