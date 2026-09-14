import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map, catchError, of } from 'rxjs';
import { environment } from '../../environments/environment';
import { Role } from './memberships.service';

// Same admin definition as shopbot-back-office's RolesService.applyRole():
// isAdministrative is a broader schema flag ("global role, not tied to a
// store" — POS Cashier counts too) — an actual admin is specifically named
// Admin/Super Admin. The printer app configures store-wide hardware, not
// day-to-day sales, so it's restricted to these two roles only.
const ADMIN_ROLE_NAMES = ['super admin', 'admin'];

@Injectable({ providedIn: 'root' })
export class RolesService {
  private http = inject(HttpClient);
  private apiUrl = environment.apiUrl;

  /** The merchant's role at a specific store. Null (never throws) when
   * unresolvable, so callers can just filter it out. */
  getRoleForStore(merchantId: string, storeId: string): Observable<Role | null> {
    return this.http
      .get<{ success: boolean; data: Role }>(`${this.apiUrl}/roles/merchant/${merchantId}/store/${storeId}`)
      .pipe(
        map((res) => res?.data ?? null),
        catchError(() => of(null)),
      );
  }

  isAdminRole(role: Role | null): boolean {
    return !!role && ADMIN_ROLE_NAMES.includes(role.name?.toLowerCase());
  }
}
