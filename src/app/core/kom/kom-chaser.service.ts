import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, Signal, computed, inject, signal } from '@angular/core';
import { forkJoin } from 'rxjs';

import { RuntimeConfigService } from '../config/runtime-config.service';
import {
  ChasabilityVerdict,
  KomAnalysis,
  PowerCurve,
  PowerCurvePoint,
  StravaAthlete,
  StravaSegment,
} from '../models/strava.models';
import { StravaAuthService } from '../strava/strava-auth.service';
import { StravaService } from '../strava/strava.service';
import { estimateAveragePowerW } from './power-estimator';

export type KomChaserStatus =
  | 'idle'
  | 'unauthenticated'
  | 'loading'
  | 'ready'
  | 'error';

interface KomChaserState {
  readonly status: KomChaserStatus;
  readonly athlete: StravaAthlete | null;
  readonly powerCurve: PowerCurve | null;
  readonly segments: readonly StravaSegment[];
  readonly error: string | null;
}

const INITIAL_STATE: KomChaserState = {
  status: 'idle',
  athlete: null,
  powerCurve: null,
  segments: [],
  error: null,
};

/**
 * Orchestrates the KOM-chasing workflow:
 *  1. checks runtime config + auth state,
 *  2. loads athlete + power curve + Grenoble segments,
 *  3. exposes a derived list of {@link KomAnalysis} sorted by chasability.
 */
@Injectable({ providedIn: 'root' })
export class KomChaserService {
  private readonly strava = inject(StravaService);
  private readonly auth = inject(StravaAuthService);
  private readonly runtime = inject(RuntimeConfigService);
  private readonly platformId = inject(PLATFORM_ID);

  private readonly _state = signal<KomChaserState>(INITIAL_STATE);

  readonly state = this._state.asReadonly();
  readonly athlete: Signal<StravaAthlete | null> = computed(() => this._state().athlete);
  readonly powerCurve: Signal<PowerCurve | null> = computed(() => this._state().powerCurve);
  readonly status = computed(() => this._state().status);
  readonly error = computed(() => this._state().error);

  readonly analyses: Signal<readonly KomAnalysis[]> = computed(() => {
    const { athlete, powerCurve, segments } = this._state();
    if (!athlete || !powerCurve || segments.length === 0) return [];
    return segments
      .map((segment) => analyseSegment(segment, athlete, powerCurve))
      .sort(byChasabilityDesc);
  });

  load(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    if (this._state().status === 'loading') return;

    const usingMock = this.runtime.config().useMock;
    if (!usingMock && !this.auth.isAuthenticated()) {
      this._state.update((s) => ({
        ...s,
        status: 'unauthenticated',
        error: null,
      }));
      return;
    }

    this._state.update((s) => ({ ...s, status: 'loading', error: null }));

    forkJoin({
      athlete: this.strava.getAthlete(),
      segments: this.strava.exploreSegments(),
    }).subscribe({
      next: ({ athlete, segments }) => {
        this.strava.getPowerCurve(athlete).subscribe({
          next: (powerCurve) => {
            this._state.set({
              status: 'ready',
              athlete,
              powerCurve,
              segments,
              error: null,
            });
          },
          error: (err) => this.fail(err),
        });
      },
      error: (err) => this.fail(err),
    });
  }

  reset(): void {
    this._state.set(INITIAL_STATE);
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : 'Unknown error';
    this._state.update((s) => ({ ...s, status: 'error', error: message }));
  }
}

function analyseSegment(
  segment: StravaSegment,
  athlete: StravaAthlete,
  powerCurve: PowerCurve,
): KomAnalysis {
  const komTimeS = segment.kom.elapsedTimeS;
  const komSpeedMs = komTimeS > 0 ? segment.distanceM / komTimeS : 0;

  const requiredAveragePowerW = estimateAveragePowerW({
    distanceM: segment.distanceM,
    averageGradePct: segment.averageGradePct,
    durationS: komTimeS,
    riderMassKg: athlete.weightKg,
  });

  const athletePowerForDurationW = interpolatePowerForDuration(
    powerCurve.points,
    komTimeS,
  );

  const chasabilityRatio =
    athletePowerForDurationW != null && requiredAveragePowerW > 0
      ? athletePowerForDurationW / requiredAveragePowerW
      : null;

  const deltaW =
    athletePowerForDurationW != null && requiredAveragePowerW > 0
      ? requiredAveragePowerW - athletePowerForDurationW
      : null;

  return {
    segment,
    komTimeS,
    komSpeedMs,
    requiredAveragePowerW,
    athletePowerForDurationW,
    chasabilityRatio,
    deltaW,
    verdict: verdictFromRatio(chasabilityRatio),
  };
}

/**
 * Linear interpolation of the athlete's mean-maximal power curve.
 * Returns `null` when `durationS` falls outside the curve range
 * (we refuse to extrapolate, since both ends of the curve are unstable).
 */
export function interpolatePowerForDuration(
  points: readonly PowerCurvePoint[],
  durationS: number,
): number | null {
  if (points.length === 0 || durationS <= 0) return null;
  const sorted = [...points].sort((a, b) => a.durationS - b.durationS);

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (durationS <= first.durationS) return first.watts;
  if (durationS >= last.durationS) return last.watts;

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (durationS >= a.durationS && durationS <= b.durationS) {
      const ratio = (durationS - a.durationS) / (b.durationS - a.durationS);
      return a.watts + ratio * (b.watts - a.watts);
    }
  }
  return null;
}

function verdictFromRatio(ratio: number | null): ChasabilityVerdict {
  if (ratio == null) return 'unreachable';
  if (ratio >= 1.05) return 'easy';
  if (ratio >= 1.0) return 'realistic';
  if (ratio >= 0.92) return 'stretch';
  return 'unreachable';
}

function byChasabilityDesc(a: KomAnalysis, b: KomAnalysis): number {
  const ar = a.chasabilityRatio ?? -Infinity;
  const br = b.chasabilityRatio ?? -Infinity;
  return br - ar;
}
