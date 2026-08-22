import { Routes } from '@angular/router';

export const PRINTERS_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./list-printers/list-printers.component').then(
        (m) => m.ListPrintersComponent
      ),
  },
  {
    path: 'add-printer',
    loadComponent: () =>
      import('./add-printers/add-printers.component').then(
        (m) => m.AddPrintersComponent
      ),
  },
  {
    path: ':id',
    loadComponent: () =>
      import('./printer-details/printer-details.component').then(
        (m) => m.PrinterDetailsComponent
      ),
  },
];
