import { Routes } from '@angular/router';

export const SHELL_ROUTES: Routes = [
  {
    path: '',
    loadChildren: () =>
      import('./pages/dashboard/dashboard.routes').then(
        (m) => m.DASHBOARD_ROUTES
      ),
  },
  {
    path: 'printers',
    loadChildren: () =>
      import('./pages/printers/printers.routes').then(
        (m) => m.PRINTERS_ROUTES
      ),
  },
  {
    path: 'logs',
    loadChildren: () =>
      import('./pages/logs/logs.routes').then((m) => m.LOGS_ROUTES),
  },
  {
    path: 'settings',
    loadChildren: () =>
      import('./pages/settings/settings.routes').then(
        (m) => m.SETTINGS_ROUTES
      ),
  },
];
