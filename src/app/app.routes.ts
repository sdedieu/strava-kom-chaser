import { Routes } from '@angular/router';

import { AuthCallbackComponent } from './features/auth/auth-callback.component';
import { SegmentsPageComponent } from './features/segments/segments-page.component';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    component: SegmentsPageComponent,
    title: 'Strava KOM Chaser · Grenoble',
  },
  {
    path: 'auth/callback',
    component: AuthCallbackComponent,
    title: 'Connecting Strava…',
  },
  { path: '**', redirectTo: '' },
];
