import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { SessionStorageService } from '../services/session-storage.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const sessionStorage = inject(SessionStorageService);
  const token = sessionStorage.getAuthToken();

  if (token) {
    const authReq = req.clone({
      headers: req.headers.set('Authorization', `Bearer ${token}`),
    });
    return next(authReq);
  }

  return next(req);
};
