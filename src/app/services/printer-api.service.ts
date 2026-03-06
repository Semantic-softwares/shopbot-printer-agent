import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root',
})
export class PrinterApiService {
  private baseUrl = 'http://localhost:4001/api';

  constructor(private http: HttpClient) {}

  getPrinters(): Observable<any[]> {
    return this.http.get<any[]>(`${this.baseUrl}/printers`);
  }

  testPrinter(ip: string, port: number): Observable<{ success: boolean; message: string }> {
    return this.http.post<{ success: boolean; message: string }>(`${this.baseUrl}/printers/test`, {
      ip,
      port,
    });
  }

  testUSBPrinter(vendorId: number, productId: number, busNumber: number, deviceAddress: number, printerId: string): Observable<{ success: boolean; message: string; jobId?: string }> {
    return this.http.post<{ success: boolean; message: string; jobId?: string }>(`${this.baseUrl}/printers/usb/test`, {
      vendorId,
      productId,
      busNumber,
      deviceAddress,
      printerId,
    });
  }

  printTestUSB(vendorId: number, productId: number, busNumber: number, deviceAddress: number, printerId: string): Observable<{ success: boolean; message: string; jobId?: string }> {
    return this.http.post<{ success: boolean; message: string; jobId?: string }>(`${this.baseUrl}/printers/usb/print-test`, {
      vendorId,
      productId,
      busNumber,
      deviceAddress,
      printerId,
    });
  }

  addPrinter(name: string, ip: string, port: number): Observable<{ success: boolean; printerId?: string }> {
    return this.http.post<{ success: boolean; printerId?: string }>(`${this.baseUrl}/printers/add`, {
      name,
      ip,
      port,
    });
  }

  removePrinter(printerId: string): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`${this.baseUrl}/printers/${printerId}`);
  }

  discoverPrinters(subnet: string): Observable<any[]> {
    return this.http.post<any[]>(`${this.baseUrl}/printers/discover`, { subnet });
  }

  discoverUSBPrinters(): Observable<any> {
    return this.http.post<any>(`${this.baseUrl}/printers/usb/discover`, {});
  }

  addUSBPrinter(printerData: any): Observable<{ success: boolean; printerId?: string }> {
    return this.http.post<{ success: boolean; printerId?: string }>(`${this.baseUrl}/printers/add`, {
      name: printerData.name,
      type: 'usb',
      vendorId: printerData.vendorId,
      productId: printerData.productId,
      busNumber: printerData.busNumber,
      deviceAddress: printerData.deviceAddress,
    });
  }

  sendPrintJob(printerId: string, data: string): Observable<{ success: boolean; jobId?: string }> {
    return this.http.post<{ success: boolean; jobId?: string }>(`${this.baseUrl}/print`, {
      printerId,
      data,
    });
  }

  retryPrintJob(jobId: string): Observable<{ success: boolean }> {
    return this.http.post<{ success: boolean }>(`${this.baseUrl}/print/retry`, { jobId });
  }

  getPrintLogs(limit: number = 100): Observable<any[]> {
    return this.http.get<any[]>(`${this.baseUrl}/logs?limit=${limit}`);
  }

  clearPrintLogs(): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`${this.baseUrl}/logs`);
  }

  getQueueStats(): Observable<any> {
    return this.http.get<any>(`${this.baseUrl}/queue/stats`);
  }

  getPollingStatus(): Observable<any> {
    return this.http.get<any>(`${this.baseUrl}/polling/status`);
  }

  restartPolling(): Observable<{ success: boolean; message: string }> {
    return this.http.post<{ success: boolean; message: string }>(`${this.baseUrl}/polling/restart`, {});
  }

  // Bluetooth printer methods
  discoverBluetoothPrinters(): Observable<{ success: boolean; discovered: number; printers: any[] }> {
    return this.http.post<{ success: boolean; discovered: number; printers: any[] }>(
      `${this.baseUrl}/printers/bluetooth/discover`,
      {}
    );
  }

  getBluetoothDeviceChannel(macAddress: string): Observable<{ success: boolean; macAddress: string; channel: number; message: string }> {
    return this.http.post<{ success: boolean; macAddress: string; channel: number; message: string }>(
      `${this.baseUrl}/printers/bluetooth/get-channel`,
      { macAddress }
    );
  }

  testBluetoothConnection(macAddress: string, channel: number = 1): Observable<{ success: boolean; macAddress?: string; channel?: number; message: string }> {
    return this.http.post<{ success: boolean; macAddress?: string; channel?: number; message: string }>(
      `${this.baseUrl}/printers/bluetooth/test`,
      { macAddress, channel }
    );
  }

  addBluetoothPrinter(name: string, macAddress: string, channel: number = 1): Observable<{ success: boolean; printerId?: string; message: string }> {
    return this.http.post<{ success: boolean; printerId?: string; message: string }>(
      `${this.baseUrl}/printers/bluetooth/add`,
      { name, macAddress, channel }
    );
  }
}
