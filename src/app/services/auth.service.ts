import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject } from 'rxjs';
import { map } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { SessionStorageService } from './session-storage.service';

export interface AuthUser {
  _id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  [key: string]: any;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private sessionStorage = inject(SessionStorageService);
  private apiUrl = environment.apiUrl;

  private currentUserSubject = new BehaviorSubject<AuthUser | null>(
    this.sessionStorage.getCurrentUser<AuthUser>()
  );

  currentUser$ = this.currentUserSubject.asObservable();

  /** Reactive signal — true when user is authenticated */
  private _isLoggedIn = signal<boolean>(
    !!this.sessionStorage.getCurrentUser() && !!this.sessionStorage.getAuthToken()
  );
  readonly isLoggedIn = this._isLoggedIn.asReadonly();

  get currentUserValue(): AuthUser | null {
    return this.currentUserSubject.value;
  }

  login(email: string, password: string): Observable<AuthUser> {
    return this.http
      .post<{ access_token: string; user: AuthUser }>(
        `${this.apiUrl}/auth/login?user=merchant`,
        { email, password }
      )
      .pipe(
        map((response) => {
          this.sessionStorage.setCurrentUser(response.user);
          this.sessionStorage.setAuthToken(response.access_token);
          this.currentUserSubject.next(response.user);
          this._isLoggedIn.set(true);
          return response.user;
        })
      );
  }

  logout(): void {
    this.sessionStorage.removeCurrentUser();
    this.sessionStorage.removeAuthToken();
    this.sessionStorage.removeStore();
    this.currentUserSubject.next(null);
    this._isLoggedIn.set(false);
  }
}
