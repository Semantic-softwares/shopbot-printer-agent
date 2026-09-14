import { Routes } from '@angular/router';
import { authGuard } from './shared/guards/auth.guard';
import { storeSelectedGuard } from './shared/guards/store-selected.guard';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'dashboard',
    pathMatch: 'full',
  },
  {
    path: 'login',
    loadChildren: () =>
      import('./login/login.routes').then((m) => m.LOGIN_ROUTES),
  },
  {
    path: 'select-store',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./select-store/select-store.component').then((m) => m.SelectStoreComponent),
  },
  {
    path: 'dashboard',
    canActivate: [authGuard, storeSelectedGuard],
    loadComponent: () =>
      import('./shell/shell.component').then((m) => m.ShellComponent),
    loadChildren: () =>
      import('./shell/shell.routes').then((m) => m.SHELL_ROUTES),
  },
];
