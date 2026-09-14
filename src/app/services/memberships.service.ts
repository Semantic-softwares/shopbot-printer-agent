import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { Store } from './store.service';

export interface Role {
  _id: string;
  name: string;
  [key: string]: any;
}

/** Mirrors backend src/schemas/membership.schema.ts — one row per
 * (merchant, store) pair. `role` is an unpopulated id here; resolve it via
 * RolesService.getRoleForStore() when the actual role details are needed. */
export interface Membership {
  _id: string;
  merchant: string;
  store: Store | string;
  role?: Role | string;
  status: 'ACTIVE' | 'INVITED' | 'SUSPENDED';
  [key: string]: any;
}

@Injectable({ providedIn: 'root' })
export class MembershipsService {
  private http = inject(HttpClient);
  private apiUrl = environment.apiUrl;

  /** Every store the current logged-in merchant has active access to. */
  getMine(): Observable<Membership[]> {
    return this.http.get<Membership[]>(`${this.apiUrl}/memberships/mine`);
  }
}
