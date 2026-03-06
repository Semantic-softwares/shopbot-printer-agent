import { Component, signal, computed, inject, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { AuthService } from './services/auth.service';
import { StoreService } from './services/store.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit {
  private authService = inject(AuthService);
  private storeService = inject(StoreService);
  private router = inject(Router);

  protected readonly title = signal('shopbot-printer');
  sidebarOpen = signal(true);
  darkMode = signal(false);

  isLoggedIn = this.authService.isLoggedIn;

  storeName = computed(() => {
    const store = this.storeService.getStoreLocally();
    return store?.name ?? 'ShopBot Printer';
  });

  constructor() {
    const saved = localStorage.getItem('darkMode');
    if (saved === 'true') {
      this.darkMode.set(true);
      document.documentElement.classList.add('dark');
    }
  }

  ngOnInit(): void {
    // On app startup, if user is already logged in, re-sync storeId to Express.
    // This handles the case where the Electron app restarts — Angular localStorage
    // still has the session, but Express needs to be told the storeId again.
    if (this.authService.isLoggedIn()) {
      const store = this.storeService.getStoreLocally();
      if (store?._id) {
        console.log('🔄 [STARTUP] Re-syncing store ID to Express:', store._id);
        fetch('http://localhost:4001/api/config/store', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storeId: store._id }),
        }).catch(err => console.error('Failed to re-sync store config:', err));
      }
    }
  }

  toggleSidebar(): void {
    this.sidebarOpen.update(v => !v);
  }

  toggleDarkMode(): void {
    this.darkMode.update(v => !v);
    if (this.darkMode()) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('darkMode', 'true');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('darkMode', 'false');
    }
  }

  logout(): void {
    this.authService.logout();
    this.storeService.removeStoreLocally();

    // Tell Express to clear store config and stop polling
    fetch('http://localhost:4001/api/config/store', { method: 'DELETE' })
      .catch(err => console.error('Failed to clear Express config:', err));

    this.router.navigate(['/login']);
  }
}
