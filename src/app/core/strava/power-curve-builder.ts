import { PowerCurve, PowerCurvePoint, StravaAthlete } from '../models/strava.models';

/** Durations (seconds) we publish on every power curve. */
export const POWER_CURVE_DURATIONS_S: readonly number[] = [
  5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400,
];

/**
 * Coggan-style fraction of FTP that a typical trained cyclist can hold
 * for each duration. Used as a fallback when no real watts streams are
 * available.
 */
const FTP_FRACTIONS: Readonly<Record<number, number>> = {
  5: 3.6,
  15: 2.85,
  30: 2.3,
  60: 1.85,
  120: 1.5,
  300: 1.18,
  600: 1.05,
  1200: 1.0,
  1800: 0.97,
  3600: 0.93,
  5400: 0.88,
};

/**
 * Compute the maximum mean power held over a sliding window of `windowS`
 * seconds, given a watts stream sampled at 1 Hz.
 *
 * O(n) implementation using a rolling sum.
 */
export function meanMaxPower(watts: readonly number[], windowS: number): number | null {
  if (windowS <= 0 || watts.length === 0) return null;

  if (watts.length < windowS) {
    const sum = watts.reduce((acc, w) => acc + w, 0);
    return sum / watts.length;
  }

  let sum = 0;
  for (let i = 0; i < windowS; i++) sum += watts[i];
  let maxSum = sum;

  for (let i = windowS; i < watts.length; i++) {
    sum += watts[i] - watts[i - windowS];
    if (sum > maxSum) maxSum = sum;
  }
  return maxSum / windowS;
}

/**
 * Build a power curve by taking, for each target duration, the highest
 * mean-max power across the given list of activity watt streams.
 */
export function buildPowerCurveFromStreams(
  athleteId: number,
  streams: readonly (readonly number[])[],
  durations: readonly number[] = POWER_CURVE_DURATIONS_S,
): PowerCurve {
  const points: PowerCurvePoint[] = durations.map((durationS) => {
    let best = 0;
    for (const stream of streams) {
      const v = meanMaxPower(stream, durationS);
      if (v != null && v > best) best = v;
    }
    return { durationS, watts: Math.round(best) };
  });

  return {
    athleteId,
    updatedAt: new Date().toISOString(),
    source: 'streams',
    points,
  };
}

/**
 * Last-resort power curve when we cannot read real streams (e.g. no
 * activity has power data). Estimated from the athlete's FTP using
 * standard duration / FTP ratios.
 */
export function estimatePowerCurveFromFtp(athlete: StravaAthlete): PowerCurve {
  const ftp = athlete.ftpWatts || 0;
  const points: PowerCurvePoint[] = POWER_CURVE_DURATIONS_S.map((durationS) => ({
    durationS,
    watts: Math.round(ftp * (FTP_FRACTIONS[durationS] ?? 1)),
  }));
  return {
    athleteId: athlete.id,
    updatedAt: new Date().toISOString(),
    source: 'estimated',
    points,
  };
}
