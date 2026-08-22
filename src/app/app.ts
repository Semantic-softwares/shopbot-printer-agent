import { Component, inject, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AuthService } from './services/auth.service';
import { StoreService } from './services/store.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit {
  private authService = inject(AuthService);
  private storeService = inject(StoreService);

  constructor() {
    if (localStorage.getItem('darkMode') === 'true') {
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
}
