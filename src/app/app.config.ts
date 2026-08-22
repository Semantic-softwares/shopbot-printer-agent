import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withHashLocation, withPreloading, PreloadAllModules } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';

import { routes } from './app.routes';
import { authInterceptor } from './shared/interceptors/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Preload lazy route chunks (dashboard, printers, etc.) in the background
    // while the user is still on the login screen, so the post-login
    // navigation to /dashboard doesn't have to wait on a fresh dynamic
    // import() — which otherwise leaves the login view visible for a moment
    // until the chunk finishes loading.
    provideRouter(routes, withHashLocation(), withPreloading(PreloadAllModules)),
    provideHttpClient(withInterceptors([authInterceptor])),
  ]
};
