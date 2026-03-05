import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, Validators, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { StoreService, Store } from '../../services/store.service';
import { SessionStorageService } from '../../services/session-storage.service';
import { switchMap, catchError, of, throwError, forkJoin } from 'rxjs';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './login.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent {
  private fb = inject(FormBuilder);
  private authService = inject(AuthService);
  private storeService = inject(StoreService);
  private sessionStorage = inject(SessionStorageService);
  private router = inject(Router);

  hide = signal<boolean>(true);
  loading = signal<boolean>(false);
  errorMessage = signal<string>('');

  loginForm = this.fb.group({
    storeNumber: ['', [Validators.required, Validators.minLength(4), Validators.maxLength(4), Validators.pattern(/^\d{4}$/)]],
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
    const { email, password, storeNumber } = this.loginForm.value;

    this.authService.login(email!, password!)
      .pipe(
        switchMap((user) => {
          const merchantId = user._id;

          return forkJoin({
            storeAccess: this.storeService.validateMerchantStoreAccess(storeNumber!, merchantId),
            merchantStores: this.storeService.getMerchantStores(merchantId),
          }).pipe(
            switchMap(({ storeAccess, merchantStores }) => {
              if (!storeAccess.success || !storeAccess.data) {
                this.authService.logout();
                return throwError(() => new Error('You do not have access to this store.'));
              }

              const store: Store = storeAccess.data;

              // Save store locally
              this.storeService.saveStoreLocally(store);

              // Notify Express backend about the store config
              this.updateExpressConfig(store._id);

              this.loading.set(false);
              this.router.navigate(['/dashboard']);
              return of(null);
            })
          );
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

  private updateExpressConfig(storeId: string): void {
    // Tell the Express backend to use this store ID for polling
    fetch('http://localhost:4001/api/config/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId }),
    }).catch(err => console.error('Failed to update Express config:', err));
  }
}
