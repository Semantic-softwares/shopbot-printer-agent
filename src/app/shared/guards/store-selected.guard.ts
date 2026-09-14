import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { StoreService } from '../../services/store.service';

/**
 * Guards /dashboard against the gap between login and store selection: an
 * admin of more than one store lands on /select-store first, and if they
 * reload before picking one, `stores` is restored from local storage but
 * `currentStore` stays null. Without this, the shell would render with no
 * store context instead of sending them back to finish picking.
 */
export const storeSelectedGuard: CanActivateFn = () => {
  const router = inject(Router);
  const storeService = inject(StoreService);

  if (storeService.currentStore()) {
    return true;
  }

  const stores = storeService.stores();

  if (stores.length === 1) {
    // Recoverable without a prompt — just the one option. Re-activating is
    // harmless (idempotent) and self-heals a stale Express-side config.
    const store = stores[0];
    storeService.saveStoreLocally(store);
    storeService.activateStore(store._id);
    return true;
  }

  if (stores.length > 1) {
    router.navigate(['/select-store']);
    return false;
  }

  // No stores at all — not this guard's job to explain why; send back to login.
  router.navigate(['/login']);
  return false;
};
