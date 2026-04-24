/**
 * Strava + KOM domain models.
 *
 * These shapes intentionally stay close to the Strava REST API
 * (https://developers.strava.com/docs/reference/) so that the mock layer
 * can be swapped for real HTTP calls without touching the UI.
 */

export interface StravaAthlete {
  readonly id: number;
  readonly firstname: string;
  readonly lastname: string;
  readonly profilePictureUrl: string;
  readonly city: string;
  readonly country: string;
  /** Athlete bodyweight in kilograms. Required for the physics model. */
  readonly weightKg: number;
  /** Functional Threshold Power, in watts. */
  readonly ftpWatts: number;
  readonly premium: boolean;
}

/** Single point of an athlete's mean-maximal power curve. */
export interface PowerCurvePoint {
  /** Effort duration in seconds. */
  readonly durationS: number;
  /** Best average power the athlete has held for that duration, in watts. */
  readonly watts: number;
}

/**
 * Mean-maximal power curve: the athlete's all-time best average power
 * sustained for each duration. Sorted by ascending duration.
 */
export interface PowerCurve {
  readonly athleteId: number;
  readonly updatedAt: string;
  readonly points: readonly PowerCurvePoint[];
  /**
   * `'streams'`  - rebuilt from real Strava activity streams,
   * `'estimated'` - derived from FTP using Coggan-style percentages,
   * `'mock'`      - bundled mock data.
   */
  readonly source: 'streams' | 'estimated' | 'mock';
}

export type ActivityType = 'Ride' | 'Run';

/**
 * A Strava segment, restricted to the fields we need to estimate
 * the power required to take its KOM.
 */
export interface StravaSegment {
  readonly id: number;
  readonly name: string;
  readonly activityType: ActivityType;
  readonly city: string;
  readonly country: string;
  readonly distanceM: number;
  /** Average grade, expressed as a percentage (e.g. 7.4 means 7.4 %). */
  readonly averageGradePct: number;
  readonly maximumGradePct: number;
  readonly elevationGainM: number;
  readonly elevationHighM: number;
  readonly elevationLowM: number;
  readonly startLatLng: readonly [number, number];
  readonly endLatLng: readonly [number, number];
  /** Strava climb category (0 = uncategorised, 5 = HC). */
  readonly climbCategory: 0 | 1 | 2 | 3 | 4 | 5;
  readonly effortCount: number;
  readonly athleteCount: number;
  readonly hazardous: boolean;
  readonly private: boolean;
  /** Current overall KOM (Cycling) for this segment. */
  readonly kom: SegmentKom;
}

export interface SegmentKom {
  readonly elapsedTimeS: number;
  readonly athleteName: string | null;
  readonly activityId: number | null;
  readonly achievedAt: string | null;
}

export type ChasabilityVerdict = 'easy' | 'realistic' | 'stretch' | 'unreachable';

/**
 * Result of comparing the athlete's power curve with the estimated
 * power required to set a new KOM on a segment.
 */
export interface KomAnalysis {
  readonly segment: StravaSegment;
  readonly komTimeS: number;
  /** Average speed of the current KOM, in metres per second. */
  readonly komSpeedMs: number;
  /** Power, in watts, the athlete would need to average to match the KOM. */
  readonly requiredAveragePowerW: number;
  /**
   * Athlete's best known average power for an effort of `komTimeS` seconds,
   * interpolated from the power curve. `null` when out of curve range.
   */
  readonly athletePowerForDurationW: number | null;
  /**
   * `athletePower / requiredPower`. > 1 means the athlete already has the
   * watts to take the KOM on paper.
   */
  readonly chasabilityRatio: number | null;
  /** Power gap. Negative when the athlete is already above the bar. */
  readonly deltaW: number | null;
  readonly verdict: ChasabilityVerdict;
}

/** Geographic bounding box used to query Strava's segment explorer. */
export interface BoundingBox {
  readonly southWest: readonly [number, number];
  readonly northEast: readonly [number, number];
}
