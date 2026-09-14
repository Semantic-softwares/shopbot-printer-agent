import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, Validators, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { forkJoin, of, switchMap, catchError, throwError, map } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { StoreService, Store } from '../services/store.service';
import { MembershipsService } from '../services/memberships.service';
import { RolesService } from '../services/roles.service';
import { LoadingSpinnerComponent } from '../shared/components/loading-spinner/loading-spinner.component';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, LoadingSpinnerComponent],
  templateUrl: './login.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent {
  private fb = inject(FormBuilder);
  private authService = inject(AuthService);
  private storeService = inject(StoreService);
  private membershipsService = inject(MembershipsService);
  private rolesService = inject(RolesService);
  private router = inject(Router);

  hide = signal<boolean>(true);
  loading = signal<boolean>(false);
  errorMessage = signal<string>('');

  loginForm = this.fb.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', Validators.required],
  });

  togglePasswordVisibility(event: MouseEvent): void {
    this.hide.update(v => !v);
    event.stopPropagation();
  }

  onSubmit(): void {
    if (!this.loginForm.valid) return;

    this.loading.set(true);
    this.errorMessage.set('');
    const { email, password } = this.loginForm.value;

    this.authService.login(email!, password!)
      .pipe(
        // Step 1: every store this merchant has active membership at — no
        // store code needed, since one account can belong to many stores.
        switchMap((user) => {
          const merchantId = user._id;

          return this.membershipsService.getMine().pipe(
            switchMap((memberships) => {
              const stores = memberships
                .map((m) => m.store)
                .filter((store): store is Store => typeof store === 'object' && store !== null);

              if (stores.length === 0) {
                return throwError(() => new Error('You do not have access to any store.'));
              }

              // Step 2: ShopBot Printer configures store-wide hardware, not
              // day-to-day sales — keep only the stores where this merchant
              // is an administrator.
              return forkJoin(
                stores.map((store) =>
                  this.rolesService.getRoleForStore(merchantId, store._id).pipe(
                    map((role) => ({ store, isAdmin: this.rolesService.isAdminRole(role) }))
                  )
                )
              ).pipe(
                map((results) => results.filter((r) => r.isAdmin).map((r) => r.store))
              );
            })
          );
        }),
        switchMap((adminStores) => {
          if (adminStores.length === 0) {
            this.authService.logout();
            return throwError(() => new Error(
              'You need administrator access to at least one store to use ShopBot Printer. Contact your store owner.'
            ));
          }

          this.storeService.saveStoresLocally(adminStores);

          if (adminStores.length === 1) {
            // Only one store — nothing to pick, connect straight to it.
            const store = adminStores[0];
            this.storeService.saveStoreLocally(store);
            return this.storeService.activateStore(store._id).then(() => {
              this.loading.set(false);
              this.router.navigate(['/dashboard']);
            });
          }

          // Multiple stores — let them choose which one this device prints for.
          this.loading.set(false);
          this.router.navigate(['/select-store']);
          return of(null);
        }),
        catchError((error) => {
          const msg = error?.error?.message || error?.message || 'Login failed. Please try again.';
          this.errorMessage.set(msg);
          this.loading.set(false);
          return of(null);
        })
      )
      .subscribe();
  }
}
