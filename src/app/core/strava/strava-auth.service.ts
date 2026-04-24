import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { Observable, finalize, from, map, of, shareReplay, tap } from 'rxjs';

import {
  STRAVA_AUTHORIZE_URL,
  STRAVA_OAUTH_SCOPES,
} from '../config/grenoble.config';
import { RuntimeConfigService } from '../config/runtime-config.service';

const STORAGE_KEY = 'strava-kom-chaser.auth';
const STATE_STORAGE_KEY = 'strava-kom-chaser.oauth-state';
/** Refresh the token if fewer than 5 minutes are left on it. */
const REFRESH_LEEWAY_S = 5 * 60;

export interface StravaTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Unix timestamp (seconds) at which the access token expires. */
  readonly expiresAt: number;
  readonly scope: string;
  readonly athleteId: number | null;
}

interface StravaTokenExchangeResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: number;
  readonly scope?: string;
  readonly athlete?: { readonly id: number };
}

/**
 * Manages the Strava OAuth lifecycle: building the authorise URL,
 * exchanging the one-shot code via the SSR proxy, persisting tokens in
 * `localStorage`, and refreshing them on demand.
 */
@Injectable({ providedIn: 'root' })
export class StravaAuthService {
  private readonly http = inject(HttpClient);
  private readonly runtime = inject(RuntimeConfigService);
  private readonly platformId = inject(PLATFORM_ID);

  private readonly _tokens = signal<StravaTokenSet | null>(this.readStoredTokens());

  readonly tokens = this._tokens.asReadonly();
  readonly isAuthenticated = computed(() => this._tokens() != null);

  /** In-flight refresh, shared across concurrent callers. */
  private inFlightRefresh: Observable<StravaTokenSet> | null = null;

  /** Build the Strava authorise URL and redirect the browser there. */
  startLogin(): void {
    if (!isPlatformBrowser(this.platformId)) return;

    const cfg = this.runtime.config();
    if (!cfg.clientId) {
      throw new Error(
        'Strava client_id is not configured. Add credentials to your .env file.',
      );
    }

    const state = generateState();
    sessionStorage.setItem(STATE_STORAGE_KEY, state);

    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: 'code',
      approval_prompt: 'auto',
      scope: STRAVA_OAUTH_SCOPES.join(','),
      state,
    });

    window.location.assign(`${STRAVA_AUTHORIZE_URL}?${params.toString()}`);
  }

  /**
   * Validate the `state` returned by Strava against what we stored before
   * redirecting. Returns `true` only if both are present and equal.
   */
  validateState(returnedState: string | null): boolean {
    if (!isPlatformBrowser(this.platformId)) return false;
    const expected = sessionStorage.getItem(STATE_STORAGE_KEY);
    sessionStorage.removeItem(STATE_STORAGE_KEY);
    return !!expected && expected === returnedState;
  }

  /** Exchange the OAuth `code` for a token set via the SSR proxy. */
  exchangeCode(code: string): Observable<StravaTokenSet> {
    return this.http
      .post<StravaTokenExchangeResponse>('/api/auth/strava/exchange', { code })
      .pipe(
        map((res) => this.toTokenSet(res)),
        tap((tokens) => this.persist(tokens)),
      );
  }

  logout(): void {
    this._tokens.set(null);
    if (isPlatformBrowser(this.platformId)) {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  /**
   * Returns a valid access token, refreshing it transparently when needed.
   * Resolves to `null` when the user is not authenticated.
   */
  getValidAccessToken(): Observable<string | null> {
    const current = this._tokens();
    if (!current) return of(null);

    if (!this.isExpiringSoon(current)) {
      return of(current.accessToken);
    }
    return this.refresh().pipe(map((t) => t.accessToken));
  }

  private refresh(): Observable<StravaTokenSet> {
    if (this.inFlightRefresh) return this.inFlightRefresh;

    const current = this._tokens();
    if (!current) {
      return from(Promise.reject(new Error('Not authenticated')));
    }

    this.inFlightRefresh = this.http
      .post<StravaTokenExchangeResponse>('/api/auth/strava/refresh', {
        refresh_token: current.refreshToken,
      })
      .pipe(
        map((res) => this.toTokenSet(res, current.athleteId)),
        tap((tokens) => this.persist(tokens)),
        finalize(() => {
          this.inFlightRefresh = null;
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    return this.inFlightRefresh;
  }

  private isExpiringSoon(t: StravaTokenSet): boolean {
    const nowS = Math.floor(Date.now() / 1000);
    return t.expiresAt - nowS <= REFRESH_LEEWAY_S;
  }

  private toTokenSet(
    res: StravaTokenExchangeResponse,
    fallbackAthleteId: number | null = null,
  ): StravaTokenSet {
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token,
      expiresAt: res.expires_at,
      scope: res.scope ?? '',
      athleteId: res.athlete?.id ?? fallbackAthleteId,
    };
  }

  private persist(tokens: StravaTokenSet): void {
    this._tokens.set(tokens);
    if (isPlatformBrowser(this.platformId)) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
      } catch {
        /* localStorage full / disabled — ignore */
      }
    }
  }

  private readStoredTokens(): StravaTokenSet | null {
    if (!isPlatformBrowser(this.platformId)) return null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<StravaTokenSet>;
      if (
        typeof parsed.accessToken !== 'string' ||
        typeof parsed.refreshToken !== 'string' ||
        typeof parsed.expiresAt !== 'number'
      ) {
        return null;
      }
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: parsed.expiresAt,
        scope: parsed.scope ?? '',
        athleteId: parsed.athleteId ?? null,
      };
    } catch {
      return null;
    }
  }
}

function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
