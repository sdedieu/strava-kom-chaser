import { Injectable, Signal, computed, effect, inject } from '@angular/core';
import { Functions, httpsCallable } from '@angular/fire/functions';
import { firstValueFrom, from, Observable, of, switchMap, tap } from 'rxjs';
import { Opportunity } from '../models';
import {
  collection,
  collectionData,
  doc,
  docData,
  Firestore,
} from '@angular/fire/firestore';
import { Auth, user } from '@angular/fire/auth';
import { toSignal } from '@angular/core/rxjs-interop';
import { environment } from '../../environments/environment.development';

export interface StravaToken {
  token_type: string;
  expires_at: number;
  refresh_token: string;
  access_token: string;
  athlete: any;
}

@Injectable({ providedIn: 'root' })
export class StravaService {
  private functions = inject(Functions);
  private firestore = inject(Firestore);
  private auth = inject(Auth);

  private user$ = user(this.auth);

  private user = toSignal(this.user$, { initialValue: null });

  private stravaTokenRef = (id: string) =>
    doc(this.firestore, `users/${id}/stravaTokens/${id}`);

  private activitiesRef = (id: string) =>
    collection(this.firestore, `users/${id}/activities`);

  private athleteProfileRef = (id: string) =>
    doc(this.firestore, `users/${id}/performance/profile`);

  readonly stravaToken: Signal<StravaToken | null | undefined> = toSignal(
    this.user$.pipe(
      switchMap((user) =>
        user?.uid
          ? (docData(this.stravaTokenRef(user?.uid)) as Observable<StravaToken>)
          : of(null),
      ),
    ),
    { initialValue: null },
  );

  readonly athelete = computed(() => this.stravaToken()?.athlete);

  readonly activities = toSignal(
    this.user$.pipe(
      switchMap((user) =>
        user?.uid
          ? (collectionData(this.activitiesRef(user?.uid), {
              idField: 'id',
            }) as Observable<unknown[]>)
          : of([]),
      ),
    ),
    { initialValue: [] },
  );

  readonly athleteProfile = toSignal(
    this.user$.pipe(
      switchMap((user) =>
        user?.uid
          ? (docData(this.athleteProfileRef(user?.uid), {
              idField: 'id',
            }) as Observable<any>)
          : of(null),
      ),
    ),
  );

  readonly segments = toSignal(
    collectionData(collection(this.firestore, 'segments'), { idField: 'id' }),
    {
      initialValue: [],
    },
  );

  readonly athleteSegments = toSignal(
    this.user$.pipe(
      switchMap((user) =>
        user?.uid
          ? (collectionData(
              collection(this.firestore, `users/${user?.uid}/segments`),
              { idField: 'id' },
            ) as Observable<any[]>)
          : of([]),
      ),
    ),
    { initialValue: [] },
  );

  readonly athleteSegmentsWithName = computed(() =>
    this.athleteSegments().map((s) => {
      const segment = this.segments().find((seg) => seg.id === s.id);
      return {
        ...s,
        name: segment?.name || 'Unknown Segment',
        stravaLink: `https://www.strava.com/segments/${s.id}`,
      };
    }),
  );

  sortedAthleteSegments = computed(() =>
    this.athleteSegmentsWithName().sort(
      (a, b) => a.score.estimatedTimeDiff - b.score.estimatedTimeDiff,
    ),
  );

  refreshToken() {
    const token = this.stravaToken();
    return token?.expires_at && token.expires_at * 1000 < Date.now()
      ? firstValueFrom(this.tokens(this.user()!.uid))
      : of(null);
  }

  normalizeExistingSegmentsXoms() {
    const token = this.stravaToken();
    if (!token) return of(null);
    const fn = httpsCallable<void, any>(
      this.functions,
      'normalizeExistingSegmentsXoms',
    );
    return from(fn().then((r) => r.data));
  }

  startOAuth() {
    const fn = httpsCallable<{ env: 'prod' | 'dev' }, { url: string }>(
      this.functions,
      'stravaOAuthUrl',
    );
    return from(
      fn({ env: environment.production ? 'prod' : 'dev' }).then(
        (r) => r.data.url,
      ),
    );
  }

  authCallback(code: string) {
    const fn = httpsCallable<{ code: string }, StravaToken>(
      this.functions,
      'stravaOAuthCallback',
    );
    return from(fn({ code }));
  }

  tokens(userId: string) {
    const fn = httpsCallable<{ id: string }, StravaToken>(
      this.functions,
      'tokens',
    );
    return from(fn({ id: userId }));
  }

  status() {
    const fn = httpsCallable<void, { connected: boolean; athlete?: any }>(
      this.functions,
      'stravaStatus',
    );
    return from(fn().then((r) => r.data));
  }

  sync() {
    const fn = httpsCallable<void, any>(this.functions, 'syncStravaData');
    return from(fn().then((r) => r.data));
  }

  discover(bounds: [number, number, number, number]) {
    const fn = httpsCallable<{ bounds: number[] }, Opportunity[]>(
      this.functions,
      'discoverKOMOpportunities',
    );
    return from(fn({ bounds }).then((r) => r.data));
  }
}
