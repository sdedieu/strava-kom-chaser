import { isPlatformBrowser } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, PLATFORM_ID, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { StravaAuthService } from '../../core/strava/strava-auth.service';

type CallbackState = 'pending' | 'error';

@Component({
  selector: 'app-auth-callback',
  standalone: true,
  imports: [],
  template: `
    <main
      class="min-h-screen flex items-center justify-center bg-slate-50 p-6"
      data-test="auth-callback"
    >
      <div class="max-w-md w-full rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 p-8 text-center">
        @if (state() === 'pending') {
          <div
            class="mx-auto h-10 w-10 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin mb-4"
            aria-hidden="true"
          ></div>
          <h1 class="text-lg font-semibold text-slate-900">Finishing Strava login…</h1>
          <p class="text-sm text-slate-500 mt-2">Exchanging authorisation code.</p>
        } @else {
          <h1 class="text-lg font-semibold text-rose-700">Strava login failed</h1>
          <p class="text-sm text-slate-600 mt-2" data-test="auth-error">{{ error() }}</p>
          <button
            type="button"
            (click)="retry()"
            class="mt-4 inline-flex items-center px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800"
            data-test="auth-retry"
          >
            Back to home
          </button>
        }
      </div>
    </main>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthCallbackComponent implements OnInit {
  private readonly auth = inject(StravaAuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly platformId = inject(PLATFORM_ID);

  readonly state = signal<CallbackState>('pending');
  readonly error = signal<string>('');

  ngOnInit(): void {
    if (!isPlatformBrowser(this.platformId)) return;

    const params = this.route.snapshot.queryParamMap;
    const code = params.get('code');
    const stateParam = params.get('state');
    const errorParam = params.get('error');

    if (errorParam) {
      this.fail(`Strava returned: ${errorParam}`);
      return;
    }
    if (!code) {
      this.fail('Missing authorisation code in callback URL.');
      return;
    }
    if (!this.auth.validateState(stateParam)) {
      this.fail('OAuth state mismatch. Please try connecting again.');
      return;
    }

    this.auth.exchangeCode(code).subscribe({
      next: () => this.router.navigateByUrl('/'),
      error: (err: unknown) => {
        const message = err instanceof Error ? err.message : 'Token exchange failed.';
        this.fail(message);
      },
    });
  }

  retry(): void {
    this.router.navigateByUrl('/');
  }

  private fail(message: string): void {
    this.error.set(message);
    this.state.set('error');
  }
}
