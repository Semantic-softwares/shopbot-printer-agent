import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'login',
    pathMatch: 'full',
  },
  {
    path: 'login',
    loadComponent: () =>
      import('./pages/login/login.component').then(
        (m) => m.LoginComponent
      ),
  },
  {
    path: 'dashboard',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/dashboard/dashboard.component').then(
        (m) => m.DashboardComponent
      ),
  },
  {
    path: 'printers',
    canActivate: [authGuard],
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./pages/printers/list-printers/list-printers.component').then(
            (m) => m.ListPrintersComponent
          ),
      },
      {
        path: 'add-printer',
        loadComponent: () =>
          import('./pages/printers/add-printers/add-printers.component').then(
            (m) => m.AddPrintersComponent
          ),
      },
    ],
  },
  {
    path: 'logs',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/logs/logs.component').then(
        (m) => m.LogsComponent
      ),
  },
  {
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/settings/settings.component').then(
        (m) => m.SettingsComponent
      ),
  },
];
