import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, signal } from '@angular/core';

import { RuntimeConfigService } from '../../core/config/runtime-config.service';
import { KomChaserService } from '../../core/kom/kom-chaser.service';
import { ChasabilityVerdict, KomAnalysis } from '../../core/models/strava.models';
import { StravaAuthService } from '../../core/strava/strava-auth.service';
import { ConnectCtaComponent } from '../auth/connect-cta.component';
import { ProfileSummaryComponent } from '../profile/profile-summary.component';
import { SegmentCardComponent } from './segment-card.component';

type VerdictFilter = 'all' | ChasabilityVerdict;

interface FilterOption {
  readonly id: VerdictFilter;
  readonly label: string;
}

const FILTER_OPTIONS: readonly FilterOption[] = [
  { id: 'all', label: 'All segments' },
  { id: 'easy', label: 'Easy' },
  { id: 'realistic', label: 'Realistic' },
  { id: 'stretch', label: 'Stretch' },
  { id: 'unreachable', label: 'Out of reach' },
];

@Component({
  selector: 'app-segments-page',
  standalone: true,
  imports: [ConnectCtaComponent, ProfileSummaryComponent, SegmentCardComponent],
  templateUrl: './segments-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-h-screen bg-slate-50' },
})
export class SegmentsPageComponent implements OnInit {
  private readonly chaser = inject(KomChaserService);
  private readonly auth = inject(StravaAuthService);
  private readonly runtime = inject(RuntimeConfigService);

  readonly status = this.chaser.status;
  readonly error = this.chaser.error;
  readonly athlete = this.chaser.athlete;
  readonly powerCurve = this.chaser.powerCurve;
  readonly isAuthenticated = this.auth.isAuthenticated;

  readonly dataSource = computed<'mock' | 'strava'>(() =>
    this.runtime.config().useMock ? 'mock' : 'strava',
  );

  readonly filter = signal<VerdictFilter>('all');
  readonly filterOptions = FILTER_OPTIONS;

  readonly counts = computed(() => {
    const counts: Record<VerdictFilter, number> = {
      all: 0,
      easy: 0,
      realistic: 0,
      stretch: 0,
      unreachable: 0,
    };
    for (const a of this.chaser.analyses()) {
      counts.all++;
      counts[a.verdict]++;
    }
    return counts;
  });

  readonly chasableCount = computed(
    () => this.counts().easy + this.counts().realistic,
  );

  readonly visibleAnalyses = computed<readonly KomAnalysis[]>(() => {
    const f = this.filter();
    const all = this.chaser.analyses();
    return f === 'all' ? all : all.filter((a) => a.verdict === f);
  });

  constructor() {
    // Reload as soon as the user finishes the OAuth flow.
    effect(() => {
      if (this.auth.isAuthenticated() && this.chaser.status() === 'unauthenticated') {
        this.chaser.load();
      }
    });

    // In live mode, kick the user straight to Strava's login/consent page
    // the first time they land on the app. `startLogin()` is idempotent and
    // itself a no-op during SSR / when already authenticated.
    effect(() => {
      if (
        !this.runtime.config().useMock &&
        this.chaser.status() === 'unauthenticated' &&
        !this.auth.isAuthenticated()
      ) {
        this.auth.startLogin();
      }
    });
  }

  ngOnInit(): void {
    this.chaser.load();
  }

  setFilter(id: VerdictFilter): void {
    this.filter.set(id);
  }

  retry(): void {
    this.chaser.load();
  }

  logout(): void {
    this.auth.logout();
    this.chaser.reset();
    this.chaser.load();
  }
}
