import { Injectable, Signal, computed, effect, inject } from '@angular/core';
import { Functions, httpsCallable } from '@angular/fire/functions';
import { firstValueFrom, from, Observable, of } from 'rxjs';
import { Opportunity } from '../models';
import {
  collection,
  collectionData,
  doc,
  docData,
  Firestore,
} from '@angular/fire/firestore';
import { Auth, user } from '@angular/fire/auth';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import { environment } from '../../environments/environment.development';
import segmentsMock from '../test/mocks/segments.mock.json';
import athleteSegmentsMock from '../test/mocks/athlete.segments.mock.json';
import athleteEffortsMock from '../test/mocks/athlete.efforts.mock.json';
import athleteMock from '../test/mocks/athlete.mock.json';
import athleteProfileMock from '../test/mocks/athlete.profile.mock.json';
import {
  ActivityPowerCurve,
  Athlete,
  AthleteSegment,
  Effort,
  Segment,
  SegmentTimePrediction,
  SegmentTimePredictionOptions,
  Token,
  PowerCurvePoint,
} from '../models/models';

const segmentsMap = new Map((segmentsMock as Segment[]).map((s) => [s.id, s]));

export const DURATIONS = [
  1, 5, 10, 15, 30, 45, 60, 90, 120, 180, 300, 600, 900, 1200, 1800, 3600, 5400,
  7200,
] as const;

@Injectable({ providedIn: 'root' })
export class StravaService {
  private functions = inject(Functions);
  private firestore = inject(Firestore);
  private auth = inject(Auth);

  private user$ = user(this.auth);
  private user = toSignal(this.user$, { initialValue: null });

  private stravaAthleteRef = (id: string) => doc(this.firestore, `users/${id}`);

  private stravaTokenRef = (id: string) =>
    doc(this.firestore, `users/${id}/stravaTokens/${id}`);

  private athleteProfileRef = (id: string) =>
    doc(this.firestore, `users/${id}/performance/profile`);

  private athleteEffortsRef = (id: string) =>
    collection(this.firestore, `users/${id}/segmentEfforts`);

  readonly stravaTokenResource = rxResource({
    params: () => this.user(),
    stream: ({ params }) => {
      return false
        ? of({
            refresh_token: '84ecdef5cf0a465452577c910b7b1956276d50fa',
            access_token: 'aafc7105670811c8ca38624c944f85321cdebcbc',
            connectionId: '82175c94-cc13-4b7d-83c9-72e8a7e173a6',
            expires_at: 1789307380,
          })
        : params?.uid
          ? (docData(this.stravaTokenRef(params!.uid)) as Observable<Token>)
          : of(null);
    },
    defaultValue: null,
  });

  readonly stravaToken = this.stravaTokenResource.value;

  readonly stravaAthleteResource = rxResource({
    params: () => this.user(),
    stream: ({ params }) =>
      true
        ? of({ athlete: athleteMock })
        : params?.uid
          ? (docData(this.stravaAthleteRef(params!.uid)) as Observable<{
              athlete: Athlete;
            }>)
          : of(null),
  });

  readonly stravaAthlete = this.stravaAthleteResource.value;

  readonly athelete = computed(() => {
    return this.stravaAthlete()?.athlete;
  });

  readonly athleteProfileResource = rxResource({
    params: () => this.user(),
    stream: ({ params }) =>
      true
        ? of(athleteProfileMock as any)
        : params?.uid
          ? (docData(this.athleteProfileRef(params!.uid), {
              idField: 'id',
            }) as Observable<Athlete>)
          : of(null),
    defaultValue: null,
  });

  readonly athleteProfile = this.athleteProfileResource.value;

  readonly segmentsResource = rxResource({
    stream: () =>
      true
        ? of(segmentsMock as Segment[])
        : collectionData(collection(this.firestore, 'segments'), {
            idField: 'id',
          }),
    defaultValue: [],
  });

  readonly segments = this.segmentsResource.value;

  readonly athleteSegmentsResource = rxResource({
    params: () => this.user(),
    stream: ({ params }) =>
      true
        ? of(athleteSegmentsMock)
        : params?.uid
          ? (collectionData(
              collection(this.firestore, `users/${params?.uid}/segments`),
              { idField: 'id' },
            ) as Observable<AthleteSegment[]>)
          : of([]),
    defaultValue: [],
  });

  readonly athleteSegments = this.athleteSegmentsResource.value;

  readonly athleteSegmentsWithSegment = computed(() =>
    this.athleteSegments().map((as) => ({
      ...(this.segments().find((s) => s.id === as.id) as Segment),
      ...(as as AthleteSegment),
    })),
  );

  sortedAthleteSegments = computed(() =>
    this.athleteSegments()
      .map((as) => ({ ...as, ...segmentsMap.get(as.id) }) as AthleteSegment)
      .filter((s) => this.filterSegment(s))
      .sort(
        (a, b) =>
          b.xoms.kom! -
            this.bestAthleteEfforts().get(parseInt(b.id))!.elapsed_time -
            (a.xoms.kom! -
              this.bestAthleteEfforts().get(parseInt(a.id))!.elapsed_time) ||
          a.score.estimatedTimeDiff - b.score.estimatedTimeDiff,
      ),
  );

  readonly athleteEffortsResource = rxResource({
    params: () => this.user(),
    stream: ({ params }) =>
      true
        ? of(athleteEffortsMock as Effort[])
        : params?.uid
          ? (collectionData(
              collection(this.firestore, `users/${params?.uid}/segmentEfforts`),
              { idField: 'id' },
            ) as Observable<Effort[]>)
          : of([]),
    defaultValue: [],
  });

  readonly athleteEfforts = this.athleteEffortsResource.value;

  readonly bestAthleteEfforts = computed(() =>
    this.athleteEffortsResource.value()?.reduce((acc, curr) => {
      return acc.set(
        curr.segmentId,
        !acc.has(curr.segmentId) ||
          curr.elapsed_time < acc.get(curr.segmentId)!.elapsed_time
          ? curr
          : acc.get(curr.segmentId)!,
      );
    }, new Map<number, Effort>()),
  );

  readonly segmentsWithScore = computed(() =>
    this.segmentsResource
      .value()
      ?.filter(
        (s) =>
          s.xoms.kom / 60 < 15 &&
          s.activity_type === 'Ride' &&
          s.xoms.kom < DURATIONS[DURATIONS.length - 1],
      )
      ?.map((s) => {
        const prediction = this.predictSegmentTime(
          s as any,
          this.athelete() as any,
          this.athleteProfile().powerCurve,
        );
        return {
          ...s,
          score: {
            ...prediction,
            estimatedPowerNeeded: prediction.estimatedPowerW,
            estimatedTimeDiff: prediction.timeSeconds - s.xoms.kom,
          },
        } as any;
      })
      .sort(
        (a: any, b: any) =>
          a.score.confidence.score - b.score.confidence.score ||
          a.score.estimatedTimeDiff - b.score.estimatedTimeDiff,
      ),
  );

  refreshToken() {
    return firstValueFrom(this.tokens(this.user()!.uid));
  }

  normalizeExistingSegments() {
    const token = this.stravaToken();
    if (!token) return of(null);
    const fn = httpsCallable<void, any>(
      this.functions,
      'normalizeExistingSegments',
    );
    return from(fn().then((r) => r.data));
  }

  normalizeExistingActivities() {
    const token = this.stravaToken();
    if (!token) return of(null);
    const fn = httpsCallable<void, any>(
      this.functions,
      'normalizeExistingActivities',
    );
    return from(fn().then((r) => r.data));
  }

  startOAuth() {
    const fn = httpsCallable<{ env: 'prod' | 'dev' }, { url: string }>(
      this.functions,
      'stravaOAuthUrl',
    );
    return from(
      fn({ env: environment.production ? 'prod' : 'dev' }).then(
        (r) => r.data.url,
      ),
    );
  }

  authCallback(code: string) {
    const fn = httpsCallable<{ code: string }, Token>(
      this.functions,
      'stravaOAuthCallback',
    );
    return from(fn({ code }));
  }

  tokens(userId: string) {
    const fn = httpsCallable<{ id: string }, Token>(this.functions, 'tokens');
    return from(fn({ id: userId }));
  }

  status() {
    const fn = httpsCallable<void, { connected: boolean; athlete?: Athlete }>(
      this.functions,
      'stravaStatus',
    );
    return from(fn().then((r) => r.data));
  }

  sync() {
    const fn = httpsCallable<void, any>(this.functions, 'syncStravaData');
    return from(fn().then((r) => r.data));
  }

  discoverSegments() {
    const fn = httpsCallable<{ bounds: number[]; activity_type: string }, any>(
      this.functions,
      'discoverSegments',
    );
    return from(
      fn({ bounds: [44.8, 5.53, 45.6, 6.22], activity_type: 'riding' }).then(
        (r) => r.data,
      ),
    );
  }

  filterSegment(s: AthleteSegment): boolean {
    {
      return (
        this.isWithin50Km(s.start_latlng, [45.119375, 5.6919]) &&
        s.average_grade > -2 &&
        (s.xoms?.kom ?? 0) / 60 < 2 &&
        s.average_grade / s.maximum_grade > 0.2 &&
        (s.distance / (s.xoms?.kom ?? 0)) * 3.6 < 45
      );
    }
  }

  isWithin50Km([lat1, lon1]: [number, number], [lat2, lon2]: [number, number]) {
    const R = 6371; // Earth radius in km

    const toRad = (deg: number) => (deg * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

    const distance = 2 * R * Math.asin(Math.sqrt(a));

    return distance < 100;
  }

  /**
   * Estimates segment time using the athlete's stored power-duration curve.
   *
   * On descents, applied power progressively decreases between configurable
   * speed thresholds to approximate reduced pedalling and coasting.
   *
   * @param segment Segment geometry and grade.
   * @param athlete Athlete physiology data.
   * @param powerCurve Best observed power by duration.
   * @param options Prediction tuning options.
   * @return Estimated segment time and heuristic confidence.
   */
  predictSegmentTime(
    segment: Pick<
      Segment,
      'id' | 'distance' | 'average_grade' | 'elevation_low' | 'elevation_high'
    >,
    athlete: Pick<Athlete, 'weight' | 'ftp'>,
    powerCurve: ActivityPowerCurve,
    options: SegmentTimePredictionOptions = {},
  ): SegmentTimePrediction {
    const distanceM = requirePositiveFinite(
      segment.distance,
      'segment.distance',
    );

    // Strava grades are percentages: 5.7 means 5.7%.
    const gradeRatio =
      requireFinite(segment.average_grade, 'segment.average_grade') / 100;
    const isDescent = gradeRatio < 0;
    const isStrongDescent = gradeRatio < -2;

    if (!powerCurve || Object.keys(powerCurve).length === 0) {
      throw new Error('A powerCurve is required to predict segment time.');
    }

    const powerCurvePoints = normalizePowerCurve(powerCurve);

    const fallbackRiderWeightKg = requirePositiveFinite(
      options.fallbackRiderWeightKg ?? 70,
      'options.fallbackRiderWeightKg',
    );
    const hasMeasuredWeight =
      Number.isFinite(athlete.weight) && athlete.weight > 0;
    const riderWeightKg = hasMeasuredWeight
      ? athlete.weight
      : fallbackRiderWeightKg;

    const bikeAndEquipmentWeightKg = requirePositiveFinite(
      options.bikeAndEquipmentWeightKg ?? 10,
      'options.bikeAndEquipmentWeightKg',
    );
    const cda = requirePositiveFinite(options.cda ?? 0.32, 'options.cda');
    const crr = requirePositiveFinite(options.crr ?? 0.004, 'options.crr');

    const averageElevationM =
      Number.isFinite(segment.elevation_low) &&
      Number.isFinite(segment.elevation_high)
        ? (segment.elevation_low + segment.elevation_high) / 2
        : 0;
    const estimatedAirDensityKgM3 =
      1.225 * Math.exp(-Math.max(0, averageElevationM) / 8500);
    const rho = requirePositiveFinite(
      options.airDensityKgM3 ?? estimatedAirDensityKgM3,
      'options.airDensityKgM3',
    );

    const drivetrainEfficiency = requireInRange(
      options.drivetrainEfficiency ?? 0.975,
      0.5,
      1,
      'options.drivetrainEfficiency',
    );
    const realizationFactor = requireInRange(
      options.powerCurveRealizationFactor ??
        options.histogramRealizationFactor ??
        1,
      0.5,
      1,
      'options.powerCurveRealizationFactor',
    );

    const descentPowerTaperStartKmh = requirePositiveFinite(
      options.descentPowerTaperStartKmh ?? 45,
      'options.descentPowerTaperStartKmh',
    );
    const descentCoastingKmh = requirePositiveFinite(
      options.descentCoastingKmh ?? 65,
      'options.descentCoastingKmh',
    );

    if (descentCoastingKmh <= descentPowerTaperStartKmh) {
      throw new Error(
        'options.descentCoastingKmh must exceed ' +
          'options.descentPowerTaperStartKmh.',
      );
    }

    const totalMassKg = riderWeightKg + bikeAndEquipmentWeightKg;
    const theta = Math.atan(gradeRatio);
    const gravity = 9.80665;
    const constantForceN =
      totalMassKg * gravity * (Math.sin(theta) + crr * Math.cos(theta));
    const aeroCoefficient = 0.5 * rho * cda;

    const availablePowerAt = (durationSeconds: number): number => {
      const capacityW =
        bestAveragePowerForDuration(powerCurvePoints, durationSeconds) *
        realizationFactor;

      if (!isDescent) {
        return capacityW;
      }

      const speedKmh = (distanceM / durationSeconds) * 3.6;

      // Behavioural approximation, not a physiological limit or speed cap.
      const pedallingFactor = clamp(
        (descentCoastingKmh - speedKmh) /
          (descentCoastingKmh - descentPowerTaperStartKmh),
        0,
        1,
      );

      return capacityW * pedallingFactor;
    };

    const requiredRiderPowerAt = (durationSeconds: number): number => {
      const speedMps = distanceM / durationSeconds;
      const wheelPowerW =
        constantForceN * speedMps + aeroCoefficient * speedMps ** 3;

      // Gravity may supply all the power needed at this speed.
      return Math.max(0, wheelPowerW / drivetrainEfficiency);
    };

    const balanceAt = (durationSeconds: number): number =>
      requiredRiderPowerAt(durationSeconds) - availablePowerAt(durationSeconds);

    let lowerSeconds = Math.max(1, distanceM / 60);
    let upperSeconds = Math.max(60, distanceM / 2);

    // Expand the upper bound until the estimated effort is feasible.
    while (balanceAt(upperSeconds) > 0 && upperSeconds < 24 * 60 * 60) {
      upperSeconds *= 2;
    }

    if (balanceAt(upperSeconds) > 0) {
      throw new Error('Could not find a physically feasible segment time.');
    }

    for (let iteration = 0; iteration < 80; iteration++) {
      const middleSeconds = (lowerSeconds + upperSeconds) / 2;

      if (balanceAt(middleSeconds) > 0) {
        lowerSeconds = middleSeconds;
      } else {
        upperSeconds = middleSeconds;
      }
    }

    const timeSeconds = (lowerSeconds + upperSeconds) / 2;
    const speedMps = distanceM / timeSeconds;

    // Report the power needed at the predicted speed.
    const estimatedPowerW = requiredRiderPowerAt(timeSeconds);

    const shortestCurveSeconds = powerCurvePoints[0].durationSeconds;
    const longestCurveSeconds =
      powerCurvePoints[powerCurvePoints.length - 1].durationSeconds;

    const confidenceReasons = [
      'Power between benchmark durations is interpolated from the stored curve.',
      'Wind, corners, road surface, braking, and the detailed ' +
        'elevation profile are unavailable.',
    ];
    let confidenceScore = 80;

    if (isStrongDescent && estimatedPowerW > 200) {
      confidenceScore -= 60;
      confidenceReasons.push(
        `Descending power is assumed to decrease between ` +
          `${descentPowerTaperStartKmh} and ${descentCoastingKmh} km/h, ` +
          'with coasting above that range. These thresholds are heuristic.',
      );
      confidenceReasons.push(
        'Descending time is sensitive to cornering, braking, rider position, ' +
          'and entry speed, which this steady-speed model does not represent.',
      );
    }

    if (!hasMeasuredWeight) {
      confidenceScore -= 25;
      confidenceReasons.push(
        `Athlete weight is unavailable; ${riderWeightKg} kg was assumed.`,
      );
    }

    if (!isDescent && speedMps * 3.6 > 48) {
      confidenceScore -= 40;
      confidenceReasons.push('Speed above 48 km/h is very unlikely.');
    }

    if (!(Number.isFinite(athlete.ftp) && (athlete.ftp ?? 0) > 0)) {
      confidenceScore -= 5;
      confidenceReasons.push('FTP is unavailable.');
    }

    if (powerCurvePoints.length < DURATIONS.length) {
      confidenceScore -= 10;
      confidenceReasons.push(
        'The stored power curve is missing some benchmark durations.',
      );
    }

    if (timeSeconds < shortestCurveSeconds) {
      confidenceScore -= 10;
      confidenceReasons.push(
        'The predicted effort is shorter than the shortest power-curve point.',
      );
    }

    if (timeSeconds > longestCurveSeconds) {
      confidenceScore -= 20;
      confidenceReasons.push(
        'The predicted effort is longer than the longest power-curve point.',
      );
    }

    confidenceScore = clamp(Math.round(confidenceScore), 0, 100);

    // console.log(
    //   `Predicted segment ${segment.id} time: ${timeSeconds.toFixed(
    //     1,
    //   )} s, speed: ${speedMps.toFixed(2)} m/s, power: ${estimatedPowerW.toFixed(
    //     0,
    //   )} W, confidence: ${confidenceScore}%`,
    // );

    return {
      timeSeconds: round(timeSeconds, 1),
      timeMinutes: round(timeSeconds / 60, 2),
      speedMps: round(speedMps, 2),
      speedKmh: round(speedMps * 3.6, 2),
      estimatedPowerW: Math.round(estimatedPowerW),
      riderWeightKg,
      confidence: {
        score: confidenceScore,
        label:
          confidenceScore >= 75
            ? 'high'
            : confidenceScore >= 50
              ? 'medium'
              : 'low',
        reasons: confidenceReasons,
      },
    };
  }
}

/**
 * Requires a finite number.
 *
 * @param {number} value Value to validate.
 * @param {string} name Name to use in the thrown validation error.
 * @return {number} The validated value.
 */
export function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }

  return value;
}

/**
 * Requires a positive finite number.
 *
 * @param {number} value Value to validate.
 * @param {string} name Name to use in the thrown validation error.
 * @return {number} The validated value.
 */
export function requirePositiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }

  return value;
}

/**
 * Requires a finite number within an inclusive range.
 *
 * @param {number} value Value to validate.
 * @param {number} minimum Inclusive minimum allowed value.
 * @param {number} maximum Inclusive maximum allowed value.
 * @param {string} name Name to use in the thrown validation error.
 * @return {number} The validated value.
 */
export function requireInRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }

  return value;
}

/**
 * Clamps a number to an inclusive range.
 *
 * @param {number} value Value to clamp.
 * @param {number} minimum Inclusive minimum allowed value.
 * @param {number} maximum Inclusive maximum allowed value.
 * @return {number} The clamped value.
 */
export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Rounds a number to a fixed number of decimal places.
 *
 * @param {number} value Value to round.
 * @param {number} decimalPlaces Number of decimal places.
 * @return {number} The rounded value.
 */
export function round(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}

/**
 * Estimates best average power at any requested duration from curve points.
 *
 * @param {PowerCurvePoint[]} points Normalized power-curve points.
 * @param {number} durationSeconds Target effort duration in seconds.
 * @return {number} Estimated best average power for the requested duration.
 */
function bestAveragePowerForDuration(
  points: readonly PowerCurvePoint[],
  durationSeconds: number,
): number {
  const duration = requirePositiveFinite(durationSeconds, 'durationSeconds');
  const first = points[0];
  const last = points[points.length - 1];

  if (duration <= first.durationSeconds) {
    return first.powerW;
  }

  if (points.length === 1) {
    return first.powerW * (duration / first.durationSeconds) ** -0.07;
  }

  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const next = points[index];

    if (duration <= next.durationSeconds) {
      const ratio =
        (Math.log(duration) - Math.log(previous.durationSeconds)) /
        (Math.log(next.durationSeconds) - Math.log(previous.durationSeconds));

      return previous.powerW + (next.powerW - previous.powerW) * ratio;
    }
  }

  const previous = points[points.length - 2];
  const rawSlope =
    (Math.log(last.powerW) - Math.log(previous.powerW)) /
    (Math.log(last.durationSeconds) - Math.log(previous.durationSeconds));
  const slope = clamp(rawSlope, -0.2, -0.03);

  return last.powerW * (duration / last.durationSeconds) ** slope;
}

/**
 * Reads known benchmark durations from a stored power curve.
 *
 * @param {ActivityPowerCurve} powerCurve Best observed power by duration.
 * @return {PowerCurvePoint[]} Normalized points sorted by duration.
 */
function normalizePowerCurve(
  powerCurve: ActivityPowerCurve,
): PowerCurvePoint[] {
  let bestShorterDurationPowerW = Number.POSITIVE_INFINITY;
  const points: PowerCurvePoint[] = [];

  for (const durationSeconds of DURATIONS) {
    const powerW = powerCurve[durationSeconds];

    if (typeof powerW !== 'number' || !Number.isFinite(powerW) || powerW <= 0) {
      continue;
    }

    bestShorterDurationPowerW = Math.min(bestShorterDurationPowerW, powerW);

    points.push({
      durationSeconds,
      powerW: bestShorterDurationPowerW,
    });
  }

  if (points.length === 0) {
    throw new Error(
      'powerCurve must contain at least one positive finite power value.',
    );
  }

  return points;
}
