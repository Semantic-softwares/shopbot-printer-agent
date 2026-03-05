import { Injectable } from '@angular/core';

declare global {
  interface Window {
    electronAPI: any;
  }
}

@Injectable({
  providedIn: 'root',
})
export class ElectronService {
  get isElectron(): boolean {
    return !!(window && window.electronAPI);
  }

  getPrinters() {
    if (this.isElectron) {
      return window.electronAPI.getPrinters();
    }
    return Promise.resolve([]);
  }

  testPrinter(ip: string, port: number) {
    if (this.isElectron) {
      return window.electronAPI.testPrinter(ip, port);
    }
    return Promise.reject('Electron not available');
  }

  addPrinter(name: string, ip: string, port: number) {
    if (this.isElectron) {
      return window.electronAPI.addPrinter(name, ip, port);
    }
    return Promise.reject('Electron not available');
  }

  sendPrintJob(printerId: string, data: string) {
    if (this.isElectron) {
      return window.electronAPI.sendPrintJob(printerId, data);
    }
    return Promise.reject('Electron not available');
  }

  getPrintLogs(limit?: number) {
    if (this.isElectron) {
      return window.electronAPI.getPrintLogs(limit);
    }
    return Promise.resolve([]);
  }

  clearLogs() {
    if (this.isElectron) {
      return window.electronAPI.clearLogs();
    }
    return Promise.reject('Electron not available');
  }

  onPrinterStatusChanged(callback: (data: any) => void) {
    if (this.isElectron) {
      window.electronAPI.onPrinterStatusChanged(callback);
    }
  }

  onPrintJobCompleted(callback: (data: any) => void) {
    if (this.isElectron) {
      window.electronAPI.onPrintJobCompleted(callback);
    }
  }

  onPrintJobFailed(callback: (data: any) => void) {
    if (this.isElectron) {
      window.electronAPI.onPrintJobFailed(callback);
    }
  }
}
