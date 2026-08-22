import { Routes } from '@angular/router';

export const LOGS_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./logs.component').then((m) => m.LogsComponent),
  },
];
