import { Component, signal, computed, inject, ChangeDetectionStrategy } from '@angular/core';
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
export class App {
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
