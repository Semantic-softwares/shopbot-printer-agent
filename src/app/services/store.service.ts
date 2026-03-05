import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { SessionStorageService } from './session-storage.service';

export interface Store {
  _id: string;
  name: string;
  storeNumber: string;
  address?: string;
  phone?: string;
  email?: string;
  logo?: string;
  posSettings?: any;
  [key: string]: any;
}

@Injectable({ providedIn: 'root' })
export class StoreService {
  private http = inject(HttpClient);
  private sessionStorage = inject(SessionStorageService);
  private apiUrl = environment.apiUrl;

  validateMerchantStoreAccess(
    storeNumber: string,
    merchantId: string
  ): Observable<{ success: boolean; data: Store; message?: string }> {
    return this.http.get<{ success: boolean; data: Store; message?: string }>(
      `${this.apiUrl}/stores/validate-access/${storeNumber}/${merchantId}`
    );
  }

  getMerchantStores(merchantId: string): Observable<Store[]> {
    return this.http.get<Store[]>(
      `${this.apiUrl}/stores/${merchantId}/vendors`
    );
  }

  getStore(storeId: string): Observable<Store> {
    return this.http.get<Store>(`${this.apiUrl}/stores/${storeId}`);
  }

  // --- Local persistence ---
  saveStoreLocally(store: Store): void {
    this.sessionStorage.setStore(store);
  }

  getStoreLocally(): Store | null {
    return this.sessionStorage.getStore<Store>();
  }

  removeStoreLocally(): void {
    this.sessionStorage.removeStore();
  }
}
