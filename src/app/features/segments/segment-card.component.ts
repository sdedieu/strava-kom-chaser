import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { ChasabilityVerdict, KomAnalysis } from '../../core/models/strava.models';
import {
  formatDistance,
  formatDuration,
  formatSpeedKmh,
  formatWatts,
} from '../../shared/format';

interface VerdictTheme {
  readonly label: string;
  readonly badgeClass: string;
  readonly accentClass: string;
}

const VERDICT_THEMES: Record<ChasabilityVerdict, VerdictTheme> = {
  easy: {
    label: 'Easy KOM',
    badgeClass: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
    accentClass: 'from-emerald-500 to-emerald-400',
  },
  realistic: {
    label: 'Realistic',
    badgeClass: 'bg-sky-100 text-sky-800 ring-sky-200',
    accentClass: 'from-sky-500 to-sky-400',
  },
  stretch: {
    label: 'Stretch goal',
    badgeClass: 'bg-amber-100 text-amber-800 ring-amber-200',
    accentClass: 'from-amber-500 to-amber-400',
  },
  unreachable: {
    label: 'Out of reach',
    badgeClass: 'bg-rose-100 text-rose-800 ring-rose-200',
    accentClass: 'from-rose-500 to-rose-400',
  },
};

@Component({
  selector: 'app-segment-card',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './segment-card.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
})
export class SegmentCardComponent {
  readonly analysis = input.required<KomAnalysis>();

  readonly theme = computed(() => VERDICT_THEMES[this.analysis().verdict]);

  /** Width (0-100) of the chasability gauge. */
  readonly gaugeWidthPct = computed(() => {
    const ratio = this.analysis().chasabilityRatio ?? 0;
    return Math.max(4, Math.min(100, Math.round(ratio * 100)));
  });

  readonly stravaUrl = computed(
    () => `https://www.strava.com/segments/${this.analysis().segment.id}`,
  );

  format = {
    duration: formatDuration,
    distance: formatDistance,
    speed: formatSpeedKmh,
    watts: formatWatts,
  };

  signedDeltaW(deltaW: number | null): string {
    if (deltaW == null) return '—';
    const rounded = Math.round(deltaW);
    if (rounded === 0) return '±0 W';
    return rounded > 0 ? `+${rounded} W` : `${rounded} W`;
  }
}
