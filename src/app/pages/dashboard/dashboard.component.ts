import { Component, OnInit, ChangeDetectionStrategy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { signal, computed } from '@angular/core';
import { PrinterApiService } from '../../services/printer-api.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard.component.html',
})
export class DashboardComponent implements OnInit {
  private printerApi = inject(PrinterApiService);

  private printers = signal<any[]>([]);
  private queueStats = signal({ total: 0, pending: 0, completed: 0, failed: 0 });
  readonly logs = signal<any[]>([]);

  readonly printerCount = computed(() => this.printers().length);
  readonly onlinePrinters = computed(
    () => this.printers().filter((p: any) => p.status === 'online').length
  );
  readonly pendingJobs = computed(() => this.queueStats().pending);
  readonly successRate = computed(() => {
    const stats = this.queueStats();
    const total = stats.completed + stats.failed;
    return total > 0 ? Math.round((stats.completed / total) * 100) : 0;
  });

  ngOnInit(): void {
    this.loadDashboardData();
    setInterval(() => this.loadDashboardData(), 5000);
  }

  private loadDashboardData(): void {
    this.printerApi.getPrinters().subscribe({
      next: (printers) => this.printers.set(printers),
      error: (err) => console.error('Failed to load printers:', err),
    });

    this.printerApi.getPrintLogs(50).subscribe({
      next: (logs) => this.logs.set(logs),
      error: (err) => console.error('Failed to load logs:', err),
    });

    this.printerApi.getQueueStats().subscribe({
      next: (stats) => this.queueStats.set(stats),
      error: (err) => console.error('Failed to load queue stats:', err),
    });
  }

  formatTime(timestamp: string): string {
    try {
      const date = new Date(timestamp);
      return date.toLocaleTimeString();
    } catch {
      return 'N/A';
    }
  }
}
