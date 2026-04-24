import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  Observable,
  catchError,
  defer,
  delay,
  forkJoin,
  from,
  map,
  mergeMap,
  of,
  switchMap,
  toArray,
} from 'rxjs';

import { GRENOBLE_BOUNDS, STRAVA_API_BASE_URL } from '../config/grenoble.config';
import { RuntimeConfigService } from '../config/runtime-config.service';
import {
  BoundingBox,
  PowerCurve,
  StravaAthlete,
  StravaSegment,
} from '../models/strava.models';
import { MOCK_ATHLETE, MOCK_POWER_CURVE, MOCK_SEGMENTS } from './mock-data';
import {
  POWER_CURVE_DURATIONS_S,
  buildPowerCurveFromStreams,
  estimatePowerCurveFromFtp,
} from './power-curve-builder';

const SIMULATED_NETWORK_DELAY_MS = 350;
/** Number of recent activities scanned to rebuild the power curve. */
const POWER_CURVE_ACTIVITY_LIMIT = 30;
/** Cap on activities for which we actually pull the watts stream. */
const POWER_CURVE_STREAM_LIMIT = 12;

/**
 * Strava's `/segments/explore` returns at most 10 segments per call, with
 * no pagination. We work around it by tiling the bbox into an
 * `EXPLORE_GRID_SIZE × EXPLORE_GRID_SIZE` grid, calling explore on each
 * tile and deduplicating the results by segment id.
 *
 * 4 → 16 tiles, up to 160 candidate segments. Strava's read rate limit is
 * 100 req / 15 min, so 16 explore calls + ≲60 detail calls fits easily.
 */
const EXPLORE_GRID_SIZE = 4;
/**
 * Hard cap on the number of unique segments we fetch full details for.
 * Keeps us comfortably under Strava's rate limit even on large grids.
 */
const SEGMENT_DETAIL_LIMIT = 60;
/**
 * Concurrency for the `/segments/{id}` detail fan-out. Strava lets us
 * do small bursts; 5 in flight is a safe default that still keeps the
 * UI snappy.
 */
const SEGMENT_DETAIL_CONCURRENCY = 5;

interface RawSummaryActivity {
  readonly id: number;
  readonly type?: string;
  readonly sport_type?: string;
  readonly device_watts?: boolean;
  readonly average_watts?: number;
  readonly start_date?: string;
}

interface RawWattsStream {
  readonly watts?: { readonly data?: readonly number[] };
}

interface RawAthlete {
  readonly id: number;
  readonly firstname: string;
  readonly lastname: string;
  readonly profile?: string;
  readonly profile_medium?: string;
  readonly city?: string;
  readonly country?: string;
  readonly weight?: number;
  readonly ftp?: number;
  readonly premium?: boolean;
  readonly summit?: boolean;
}

interface RawExploreSegment {
  readonly id: number;
  readonly name: string;
  readonly climb_category: number;
  readonly avg_grade: number;
  readonly distance: number;
  readonly elev_difference: number;
  readonly start_latlng: readonly [number, number];
  readonly end_latlng: readonly [number, number];
}

interface RawSegment {
  readonly id: number;
  readonly name: string;
  readonly activity_type: 'Ride' | 'Run';
  readonly distance: number;
  readonly average_grade: number;
  readonly maximum_grade: number;
  readonly elevation_high: number;
  readonly elevation_low: number;
  readonly total_elevation_gain: number;
  readonly start_latlng: readonly [number, number];
  readonly end_latlng: readonly [number, number];
  readonly climb_category: number;
  readonly city?: string;
  readonly country?: string;
  readonly private?: boolean;
  readonly hazardous?: boolean;
  readonly effort_count?: number;
  readonly athlete_count?: number;
  readonly xoms?: { readonly kom?: string };
}

/**
 * Strava REST client. When the runtime config has no credentials
 * (`useMock=true`), the service serves bundled fixtures so the UI is
 * fully functional without an OAuth token.
 *
 * As soon as credentials are dropped into `.env`, every method below
 * issues real HTTP requests against `https://www.strava.com/api/v3`.
 */
@Injectable({ providedIn: 'root' })
export class StravaService {
  private readonly http = inject(HttpClient);
  private readonly runtime = inject(RuntimeConfigService);

  private get useMock(): boolean {
    return this.runtime.config().useMock;
  }

  // ---------------------------------------------------------------------------
  // Athlete
  // ---------------------------------------------------------------------------

  getAthlete(): Observable<StravaAthlete> {
    if (this.useMock) {
      return of(MOCK_ATHLETE).pipe(delay(SIMULATED_NETWORK_DELAY_MS));
    }
    return this.http
      .get<RawAthlete>(`${STRAVA_API_BASE_URL}/athlete`)
      .pipe(map(toAthlete));
  }

  // ---------------------------------------------------------------------------
  // Power curve (re-built from recent activity streams)
  // ---------------------------------------------------------------------------

  getPowerCurve(athlete: StravaAthlete): Observable<PowerCurve> {
    if (this.useMock) {
      return of(MOCK_POWER_CURVE).pipe(delay(SIMULATED_NETWORK_DELAY_MS));
    }

    const params = new HttpParams()
      .set('per_page', String(POWER_CURVE_ACTIVITY_LIMIT))
      .set('page', '1');

    return this.http
      .get<RawSummaryActivity[]>(`${STRAVA_API_BASE_URL}/athlete/activities`, { params })
      .pipe(
        switchMap((activities) => {
          const candidates = activities
            .filter((a) => isPoweredRide(a))
            .slice(0, POWER_CURVE_STREAM_LIMIT);

          if (candidates.length === 0) {
            return of(estimatePowerCurveFromFtp(athlete));
          }

          return forkJoin(
            candidates.map((a) =>
              this.fetchWattsStream(a.id).pipe(
                catchError(() => of<readonly number[]>([])),
              ),
            ),
          ).pipe(
            map((streams) => {
              const nonEmpty = streams.filter((s) => s.length > 0);
              if (nonEmpty.length === 0) {
                return estimatePowerCurveFromFtp(athlete);
              }
              return buildPowerCurveFromStreams(
                athlete.id,
                nonEmpty,
                POWER_CURVE_DURATIONS_S,
              );
            }),
          );
        }),
        catchError(() => of(estimatePowerCurveFromFtp(athlete))),
      );
  }

  private fetchWattsStream(activityId: number): Observable<readonly number[]> {
    const params = new HttpParams()
      .set('keys', 'watts')
      .set('key_by_type', 'true');
    return this.http
      .get<RawWattsStream>(`${STRAVA_API_BASE_URL}/activities/${activityId}/streams`, {
        params,
      })
      .pipe(map((res) => res.watts?.data ?? []));
  }

  // ---------------------------------------------------------------------------
  // Segments
  // ---------------------------------------------------------------------------

  /**
   * Explore cycling segments inside the bounding box.
   *
   * `/segments/explore` is capped at 10 segments per call by Strava, so
   * we tile the bbox into a `EXPLORE_GRID_SIZE × EXPLORE_GRID_SIZE` grid,
   * fan out explore calls in parallel, deduplicate by segment id, then
   * fetch `/segments/{id}` for each unique result to get the KOM time +
   * full metadata.
   */
  exploreSegments(
    bounds: BoundingBox = GRENOBLE_BOUNDS,
  ): Observable<readonly StravaSegment[]> {
    if (this.useMock) {
      return of(MOCK_SEGMENTS).pipe(delay(SIMULATED_NETWORK_DELAY_MS));
    }

    const tiles = tileBounds(bounds, EXPLORE_GRID_SIZE);
    const exploreCalls = tiles.map((tile) =>
      this.exploreTile(tile).pipe(catchError(() => of<readonly RawExploreSegment[]>([]))),
    );

    return forkJoin(exploreCalls).pipe(
      switchMap((batches) => {
        const unique = dedupeSegments(batches.flat()).slice(0, SEGMENT_DETAIL_LIMIT);
        if (unique.length === 0) return of<readonly StravaSegment[]>([]);

        return from(unique).pipe(
          mergeMap(
            (s) => this.getSegment(s.id).pipe(catchError(() => of(null))),
            SEGMENT_DETAIL_CONCURRENCY,
          ),
          toArray(),
          map((segments) => segments.filter((s): s is StravaSegment => !!s)),
        );
      }),
    );
  }

  private exploreTile(bounds: BoundingBox): Observable<readonly RawExploreSegment[]> {
    const [swLat, swLng] = bounds.southWest;
    const [neLat, neLng] = bounds.northEast;
    const params = new HttpParams()
      .set('bounds', `${swLat},${swLng},${neLat},${neLng}`)
      .set('activity_type', 'riding');

    return defer(() =>
      this.http.get<{ readonly segments: readonly RawExploreSegment[] }>(
        `${STRAVA_API_BASE_URL}/segments/explore`,
        { params },
      ),
    ).pipe(map((res) => res.segments ?? []));
  }

  private getSegment(id: number): Observable<StravaSegment> {
    return this.http
      .get<RawSegment>(`${STRAVA_API_BASE_URL}/segments/${id}`)
      .pipe(map(toSegment));
  }
}

// -----------------------------------------------------------------------------
// Bounding-box helpers
// -----------------------------------------------------------------------------

/**
 * Splits `bounds` into a `gridSize × gridSize` array of equal-area tiles.
 * Tiles are returned row-major (south → north, west → east) but order
 * doesn't matter since results are deduplicated downstream.
 */
function tileBounds(bounds: BoundingBox, gridSize: number): readonly BoundingBox[] {
  if (gridSize <= 1) return [bounds];

  const [swLat, swLng] = bounds.southWest;
  const [neLat, neLng] = bounds.northEast;
  const latStep = (neLat - swLat) / gridSize;
  const lngStep = (neLng - swLng) / gridSize;

  const tiles: BoundingBox[] = [];
  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      tiles.push({
        southWest: [swLat + i * latStep, swLng + j * lngStep],
        northEast: [swLat + (i + 1) * latStep, swLng + (j + 1) * lngStep],
      });
    }
  }
  return tiles;
}

function dedupeSegments(
  segments: readonly RawExploreSegment[],
): readonly RawExploreSegment[] {
  const seen = new Map<number, RawExploreSegment>();
  for (const s of segments) {
    if (!seen.has(s.id)) seen.set(s.id, s);
  }
  return Array.from(seen.values());
}

// -----------------------------------------------------------------------------
// Mappers
// -----------------------------------------------------------------------------

function toAthlete(raw: RawAthlete): StravaAthlete {
  return {
    id: raw.id,
    firstname: raw.firstname,
    lastname: raw.lastname,
    profilePictureUrl: raw.profile ?? raw.profile_medium ?? '',
    city: raw.city ?? '',
    country: raw.country ?? '',
    weightKg: raw.weight ?? 75,
    ftpWatts: raw.ftp ?? 250,
    premium: raw.premium ?? raw.summit ?? false,
  };
}

function toSegment(raw: RawSegment): StravaSegment {
  return {
    id: raw.id,
    name: raw.name,
    activityType: raw.activity_type,
    city: raw.city ?? '',
    country: raw.country ?? '',
    distanceM: raw.distance,
    averageGradePct: raw.average_grade,
    maximumGradePct: raw.maximum_grade,
    elevationGainM: raw.total_elevation_gain,
    elevationHighM: raw.elevation_high,
    elevationLowM: raw.elevation_low,
    startLatLng: raw.start_latlng,
    endLatLng: raw.end_latlng,
    climbCategory: clampClimbCategory(raw.climb_category),
    effortCount: raw.effort_count ?? 0,
    athleteCount: raw.athlete_count ?? 0,
    hazardous: raw.hazardous ?? false,
    private: raw.private ?? false,
    kom: {
      elapsedTimeS: parseKomTime(raw.xoms?.kom),
      athleteName: null,
      activityId: null,
      achievedAt: null,
    },
  };
}

function clampClimbCategory(c: number): StravaSegment['climbCategory'] {
  const n = Math.max(0, Math.min(5, Math.round(c)));
  return n as StravaSegment['climbCategory'];
}

/**
 * Strava returns the KOM as a string like `"5:42"`, `"1:02:11"`, or sometimes
 * a localised label. Returns 0 when the value is missing or unparseable
 * (the segment will then fall to the bottom of the chasability ranking).
 */
function parseKomTime(raw: string | undefined): number {
  if (!raw) return 0;
  const trimmed = raw.trim();
  const parts = trimmed.split(':').map((p) => Number(p));
  if (parts.some((p) => Number.isNaN(p))) return 0;
  let seconds = 0;
  for (const part of parts) {
    seconds = seconds * 60 + part;
  }
  return seconds;
}

function isPoweredRide(activity: RawSummaryActivity): boolean {
  const isRide = activity.type === 'Ride' || activity.sport_type === 'Ride';
  if (!isRide) return false;
  return activity.device_watts === true || (activity.average_watts ?? 0) > 0;
}
