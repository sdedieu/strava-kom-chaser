import { Routes } from '@angular/router';
import { authenticationRedirectGuard } from './auth/auth-redirect.guard';

export const routes: Routes = [
  { path: '', redirectTo: 'home', pathMatch: 'full' },
  {
    path: 'home',
    loadComponent: async () =>
      (await import('./home/home.component')).HomeComponent,
  },
  {
    path: 'oauth-redirect',
    loadComponent: async () =>
      (await import('./auth/auth-redirect.component')).AuthRedirectComponent,
    canActivate: [authenticationRedirectGuard()],
  },
];
