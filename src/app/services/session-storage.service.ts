import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class SessionStorageService {
  private readonly CURRENT_USER_KEY = 'currentUser';
  private readonly AUTH_TOKEN_KEY = 'auth_token';
  private readonly STORE_KEY = 'store';

  // --- User ---
  setCurrentUser(user: any): void {
    localStorage.setItem(this.CURRENT_USER_KEY, JSON.stringify(user));
  }

  getCurrentUser<T = any>(): T | null {
    const data = localStorage.getItem(this.CURRENT_USER_KEY);
    if (!data || data === 'undefined' || data === 'null') return null;
    try { return JSON.parse(data); } catch { return null; }
  }

  removeCurrentUser(): void {
    localStorage.removeItem(this.CURRENT_USER_KEY);
  }

  // --- Auth Token ---
  setAuthToken(token: string): void {
    localStorage.setItem(this.AUTH_TOKEN_KEY, token);
  }

  getAuthToken(): string | null {
    return localStorage.getItem(this.AUTH_TOKEN_KEY);
  }

  removeAuthToken(): void {
    localStorage.removeItem(this.AUTH_TOKEN_KEY);
  }

  // --- Store ---
  setStore(store: any): void {
    localStorage.setItem(this.STORE_KEY, JSON.stringify(store));
  }

  getStore<T = any>(): T | null {
    const data = localStorage.getItem(this.STORE_KEY);
    if (!data || data === 'undefined' || data === 'null') return null;
    try { return JSON.parse(data); } catch { return null; }
  }

  removeStore(): void {
    localStorage.removeItem(this.STORE_KEY);
  }

  // --- Generic ---
  setItem(key: string, value: any): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.error('Error saving to localStorage:', error);
    }
  }

  getItem<T>(key: string): T | null {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : null;
    } catch (error) {
      console.error('Error reading from localStorage:', error);
      return null;
    }
  }

  removeItem(key: string): void {
    localStorage.removeItem(key);
  }

  clearAll(): void {
    // Preserve dark mode preference
    const darkMode = localStorage.getItem('darkMode');
    localStorage.clear();
    if (darkMode) {
      localStorage.setItem('darkMode', darkMode);
    }
  }
}
