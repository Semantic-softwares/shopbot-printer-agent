import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormBuilder, Validators, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { StoreService, Store } from '../services/store.service';
import { SessionStorageService } from '../services/session-storage.service';
import { switchMap, catchError, of, throwError, forkJoin } from 'rxjs';
import { LoadingSpinnerComponent } from '../shared/components/loading-spinner/loading-spinner.component';
import { environment } from '../../environments/environment';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, LoadingSpinnerComponent],
  templateUrl: './login.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent {
  private fb = inject(FormBuilder);
  private http = inject(HttpClient);
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

  private async updateExpressConfig(storeId: string): Promise<void> {
    let deviceToken: string | undefined;
    try {
      // deviceId lives only in the Electron main process — read it from the local
      // Express server, then use it (plus this session's own staff JWT, attached
      // automatically by the HTTP interceptor) to mint a device-scoped socket
      // token for the printer agent's push connection.
      const { deviceId } = await firstValueFrom(
        this.http.get<{ deviceId: string }>('http://localhost:4001/api/config/device-id')
      );
      const { token } = await firstValueFrom(
        this.http.post<{ token: string }>(`${environment.apiUrl}/print-jobs/device-token`, {
          storeId,
          deviceId,
        })
      );
      deviceToken = token;
    } catch (err) {
      console.error('Failed to mint device token — push delivery will stay disconnected until next login:', err);
    }

    // Tell the Express backend which store (and device token) to use
    fetch('http://localhost:4001/api/config/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId, deviceToken }),
    }).catch(err => console.error('Failed to update Express config:', err));
  }
}
