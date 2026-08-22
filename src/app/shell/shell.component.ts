import { Component, signal, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { StoreService } from '../services/store.service';

export interface NavLink {
  path: string;
  label: string;
  icon: string;
  exact?: boolean;
}

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShellComponent {
  private authService = inject(AuthService);
  private storeService = inject(StoreService);
  private router = inject(Router);

  sidebarOpen = signal(true);
  darkMode = signal(localStorage.getItem('darkMode') === 'true');

  storeName = computed(() => this.storeService.currentStore()?.name ?? 'ShopBot Printer');

  readonly navLinks: NavLink[] = [
    { path: '/dashboard', label: 'Dashboard', icon: '📊', exact: true },
    { path: '/dashboard/printers', label: 'Printers', icon: '🖨️' },
    { path: '/dashboard/logs', label: 'Print Logs', icon: '📋' },
    { path: '/dashboard/settings', label: 'Settings', icon: '⚙️' },
  ];

  toggleSidebar(): void {
    this.sidebarOpen.update((v) => !v);
  }

  toggleDarkMode(): void {
    this.darkMode.update((v) => !v);
    document.documentElement.classList.toggle('dark', this.darkMode());
    localStorage.setItem('darkMode', String(this.darkMode()));
  }

  logout(): void {
    this.authService.logout();
    this.storeService.removeStoreLocally();

    // Tell Express to clear store config and stop polling
    fetch('http://localhost:4001/api/config/store', { method: 'DELETE' }).catch((err) =>
      console.error('Failed to clear Express config:', err)
    );

    this.router.navigate(['/login']);
  }
}
