import { Component, OnInit, ChangeDetectionStrategy, inject, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { signal, computed } from '@angular/core';
import { PrinterApiService } from '../../services/printer-api.service';
import { interval, Subscription } from 'rxjs';

@Component({
  selector: 'app-logs',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './logs.component.html',
})
export class LogsComponent implements OnInit, OnDestroy {
  private printerApi = inject(PrinterApiService);

  logs = signal<any[]>([]);
  pollingStatus = signal<any>(null);
  queueStats = signal<any>(null);
  lastUpdated = signal<string>('—');

  private refreshSubscription: Subscription | null = null;

  ngOnInit(): void {
    this.loadAllData();
    // Auto-refresh every 3 seconds
    this.refreshSubscription = interval(3000).subscribe(() => {
      this.loadAllData();
    });
  }

  ngOnDestroy(): void {
    this.refreshSubscription?.unsubscribe();
  }

  private loadAllData(): void {
    this.refreshLogs();
    this.loadPollingStatus();
    this.loadQueueStats();
  }

  refreshLogs(): void {
    this.printerApi.getPrintLogs(100).subscribe({
      next: (logs) => {
        // Map backend response to component properties
        const mappedLogs = logs.map((log: any) => ({
          jobId: log._id || log.id || 'N/A',
          printerId: log.printer || log.printerId || 'N/A',
          printerName: log.printerName || log.printer?.name || 'Unknown',
          status: log.status || 'pending',
          jobType: log.type || log.jobType || 'print_job',
          timestamp: log.createdAt || log.timestamp || new Date().toISOString(),
          error: log.error || log.lastError || null,
          retryCount: log.retryCount || 0,
          maxRetries: log.maxRetries || 3,
          attempts: log.attempts || 0,
          maxAttempts: log.maxAttempts || 3,
        }));
        this.logs.set(mappedLogs);
        this.lastUpdated.set(new Date().toLocaleTimeString());
      },
      error: (err) => {
        console.error('Failed to load logs:', err);
      },
    });
  }

  private loadPollingStatus(): void {
    this.printerApi.getPollingStatus().subscribe({
      next: (status) => {
        this.pollingStatus.set(status);
      },
      error: (err) => {
        console.error('Failed to load polling status:', err);
      },
    });
  }

  private loadQueueStats(): void {
    this.printerApi.getQueueStats().subscribe({
      next: (stats) => {
        this.queueStats.set(stats);
      },
      error: (err) => {
        console.error('Failed to load queue stats:', err);
      },
    });
  }

  clearAllLogs(): void {
    if (confirm('Are you sure you want to clear all logs? This cannot be undone.')) {
      this.printerApi.clearPrintLogs().subscribe({
        next: () => {
          alert('All logs cleared');
          this.loadAllData();
        },
        error: (err) => {
          console.error('Failed to clear logs:', err);
          alert('Failed to clear logs');
        },
      });
    }
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
