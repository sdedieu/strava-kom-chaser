import { Injectable, inject } from '@angular/core';
import { Auth, signInAnonymously } from '@angular/fire/auth';

import { StravaService } from './strava.service';

@Injectable({ providedIn: 'root' })
export class AppInitService {
  private auth = inject(Auth);

  async init() {
    if (!this.auth.currentUser) await signInAnonymously(this.auth);
  }
}
