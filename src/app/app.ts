import { Component, inject, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './services/auth.service';
import { StoreService } from './services/store.service';
import { environment } from '../environments/environment';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit {
  private http = inject(HttpClient);
  private authService = inject(AuthService);
  private storeService = inject(StoreService);

  constructor() {
    if (localStorage.getItem('darkMode') === 'true') {
      document.documentElement.classList.add('dark');
    }
  }

  ngOnInit(): void {
    // On app startup, if user is already logged in, re-sync storeId (and mint a
    // fresh device token) to Express. This handles the case where the Electron
    // app restarts — Angular localStorage still has the session, but Express
    // needs to be told the storeId/token again (its own state is in-memory only).
    if (this.authService.isLoggedIn()) {
      const store = this.storeService.getStoreLocally();
      if (store?._id) {
        console.log('🔄 [STARTUP] Re-syncing store ID to Express:', store._id);
        this.reSyncExpressConfig(store._id);
      }
    }
  }

  private async reSyncExpressConfig(storeId: string): Promise<void> {
    let deviceToken: string | undefined;
    try {
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
      console.error('Failed to mint device token on startup re-sync:', err);
    }

    fetch('http://localhost:4001/api/config/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId, deviceToken }),
    }).catch(err => console.error('Failed to re-sync store config:', err));
  }
}
