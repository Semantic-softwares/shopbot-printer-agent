import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { StoreService, Store } from '../services/store.service';
import { LoadingSpinnerComponent } from '../shared/components/loading-spinner/loading-spinner.component';

/**
 * Shown right after login when the merchant administers more than one
 * store — the equivalent of the back-office's store switcher gate. An
 * admin of exactly one store never lands here: login.component.ts selects
 * it automatically and goes straight to /dashboard.
 */
@Component({
  selector: 'app-select-store',
  standalone: true,
  imports: [LoadingSpinnerComponent],
  templateUrl: './select-store.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelectStoreComponent {
  private authService = inject(AuthService);
  private storeService = inject(StoreService);
  private router = inject(Router);

  protected readonly stores = this.storeService.stores;
  protected readonly selecting = signal<string | null>(null);
  protected readonly errorMessage = signal<string>('');

  protected async selectStore(store: Store): Promise<void> {
    if (this.selecting()) return;

    this.selecting.set(store._id);
    this.errorMessage.set('');
    this.storeService.saveStoreLocally(store);
    await this.storeService.activateStore(store._id);
    this.selecting.set(null);
    this.router.navigate(['/dashboard']);
  }

  protected logout(): void {
    this.authService.logout();
    this.storeService.removeStoreLocally();
    this.storeService.removeStoresLocally();
    this.router.navigate(['/login']);
  }
}
