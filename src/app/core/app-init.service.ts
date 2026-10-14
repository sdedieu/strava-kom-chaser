import { Injectable, effect, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Auth, signInAnonymously, user } from '@angular/fire/auth';
import {
  collection,
  collectionData,
  collectionCount,
  Firestore,
  query,
  where,
} from '@angular/fire/firestore';
import { Observable, of, switchMap } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class AppInitService {
  private auth = inject(Auth);

  async init() {
    if (!this.auth.currentUser) await signInAnonymously(this.auth);
  }
}
