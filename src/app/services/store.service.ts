import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom } from 'rxjs';
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

  /** Reactive signal mirroring the locally persisted store — components should
   * read this instead of calling getStoreLocally() so they update live on
   * login/logout instead of only on the next full app restart. */
  private _currentStore = signal<Store | null>(this.sessionStorage.getStore<Store>());
  readonly currentStore = this._currentStore.asReadonly();

  /** Every store this merchant has active administrator access to — the
   * store switcher's data source. Populated at login, restored on reload. */
  private _stores = signal<Store[]>(this.sessionStorage.getStores<Store>() ?? []);
  readonly stores = this._stores.asReadonly();

  getStore(storeId: string): Observable<Store> {
    return this.http.get<Store>(`${this.apiUrl}/stores/${storeId}`);
  }

  // --- Local persistence ---
  saveStoreLocally(store: Store): void {
    this.sessionStorage.setStore(store);
    this._currentStore.set(store);
  }

  getStoreLocally(): Store | null {
    return this.sessionStorage.getStore<Store>();
  }

  removeStoreLocally(): void {
    this.sessionStorage.removeStore();
    this._currentStore.set(null);
  }

  saveStoresLocally(stores: Store[]): void {
    this.sessionStorage.setStores(stores);
    this._stores.set(stores);
  }

  removeStoresLocally(): void {
    this.sessionStorage.removeStores();
    this._stores.set([]);
  }

  /**
   * Tells the local Electron/Express agent which store (and device-scoped
   * push token) to operate as. Called on login and whenever the operator
   * switches stores — the agent persists this to disk independently of the
   * Angular app (see electron/persistence.js), so printers keep working
   * across app restarts without re-selecting a store every time.
   */
  async activateStore(storeId: string): Promise<void> {
    let deviceToken: string | undefined;
    try {
      // deviceId lives only in the Electron main process — read it from the local
      // Express server, then use it (plus this session's own staff JWT, attached
      // automatically by the HTTP interceptor) to mint a device-scoped socket
      // token for the printer agent's push connection.
      const { deviceId } = await firstValueFrom(
        this.http.get<{ deviceId: string }>(`${environment.expressUrl}/config/device-id`)
      );
      const { token } = await firstValueFrom(
        this.http.post<{ token: string }>(`${this.apiUrl}/print-jobs/device-token`, {
          storeId,
          deviceId,
        })
      );
      deviceToken = token;
    } catch (err) {
      console.error('Failed to mint device token — push delivery will stay disconnected until next login:', err);
    }

    // Tell the Express backend which store (and device token) to use
    fetch(`${environment.expressUrl}/config/store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId, deviceToken }),
    }).catch(err => console.error('Failed to update Express config:', err));
  }
}
