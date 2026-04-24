import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { PowerCurve, StravaAthlete } from '../../core/models/strava.models';
import { formatDuration, formatWatts } from '../../shared/format';

interface CurveBar {
  readonly label: string;
  readonly watts: number;
  readonly heightPct: number;
}

const SOURCE_LABELS: Record<PowerCurve['source'], string> = {
  streams: 'From your activity streams',
  estimated: 'Estimated from FTP',
  mock: 'Sample data',
};

@Component({
  selector: 'app-profile-summary',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './profile-summary.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
})
export class ProfileSummaryComponent {
  readonly athlete = input.required<StravaAthlete>();
  readonly powerCurve = input.required<PowerCurve>();

  readonly wattsPerKg = computed(() => this.athlete().ftpWatts / this.athlete().weightKg);
  readonly sourceLabel = computed(() => SOURCE_LABELS[this.powerCurve().source]);
  readonly location = computed(() =>
    [this.athlete().city, this.athlete().country].filter(part => !!part?.trim()).join(', '),
  );

  readonly curveBars = computed<readonly CurveBar[]>(() => {
    const points = [...this.powerCurve().points].sort((a, b) => a.durationS - b.durationS);
    const peak = points.reduce((max, p) => (p.watts > max ? p.watts : max), 0) || 1;
    return points.map(p => ({
      label: shortDuration(p.durationS),
      watts: p.watts,
      heightPct: Math.max(8, Math.round((p.watts / peak) * 100)),
    }));
  });

  format = {
    duration: formatDuration,
    watts: formatWatts,
  };
}

function shortDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  return `${(seconds / 3600).toFixed(seconds % 3600 === 0 ? 0 : 1)}h`;
}
