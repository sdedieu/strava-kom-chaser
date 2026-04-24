import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';

/**
 * Runtime configuration returned by the SSR Express server's `/api/config`.
 * Only safe-to-expose fields are included; the Strava `client_secret`
 * stays on the server.
 */
export interface RuntimeConfig {
  /** Strava OAuth client_id (empty string when not configured). */
  readonly clientId: string;
  /** OAuth redirect URI, must match the one declared in Strava settings. */
  readonly redirectUri: string;
  /**
   * `true` when the server has no Strava credentials configured. In that
   * mode the front-end falls back to bundled mock data.
   */
  readonly useMock: boolean;
}

const FALLBACK_CONFIG: RuntimeConfig = {
  clientId: '',
  redirectUri: 'http://localhost:4200/auth/callback',
  useMock: false,
};

/**
 * Fetches `/api/config` once on app startup and exposes it as a signal.
 * On the server (SSR) the config is initialised to mock mode so that the
 * pre-rendered shell never depends on Strava credentials.
 */
@Injectable({ providedIn: 'root' })
export class RuntimeConfigService {
  private readonly http = inject(HttpClient);
  private readonly platformId = inject(PLATFORM_ID);

  private readonly _config = signal<RuntimeConfig>(FALLBACK_CONFIG);
  readonly config = this._config.asReadonly();

  initialize(): Promise<void> | void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }
    return firstValueFrom(this.fetchConfig()).then((cfg) => this._config.set(cfg));
  }

  private fetchConfig(): Observable<RuntimeConfig> {
    return new Observable<RuntimeConfig>((subscriber) => {
      this.http.get<RuntimeConfig>('/api/config').subscribe({
        next: (cfg) => {
          subscriber.next({
            clientId: cfg.clientId ?? '',
            redirectUri: cfg.redirectUri ?? FALLBACK_CONFIG.redirectUri,
            useMock: cfg.useMock ?? !cfg.clientId,
          });
          subscriber.complete();
        },
        error: () => {
          // If /api/config is unreachable, default to mock mode so the
          // app stays usable.
          subscriber.next(FALLBACK_CONFIG);
          subscriber.complete();
        },
      });
    });
  }
}

/**
 * Loader used by `provideAppInitializer` so the rest of the app can read
 * the runtime config synchronously after bootstrap.
 */
export function loadRuntimeConfig(): Promise<void> | void {
  return inject(RuntimeConfigService).initialize();
}
