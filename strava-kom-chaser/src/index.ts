import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import {
  onDocumentCreated,
  onDocumentWritten,
} from 'firebase-functions/v2/firestore';
import crypto from 'node:crypto';

initializeApp();
const db = getFirestore();
const CLIENT_ID = defineSecret('STRAVA_CLIENT_ID');
const CLIENT_SECRET = defineSecret('STRAVA_CLIENT_SECRET');
const API = 'https://www.strava.com/api/v3';
const OAUTH = 'https://www.strava.com/oauth';
const REGION = 'europe-west1';

const DURATIONS = [
  1, 5, 10, 15, 30, 45, 60, 90, 120, 180, 300, 600, 900, 1200, 1800, 3600, 5400,
  7200,
] as const;

type Athlete = {
  id: number;
  username: string;
  firstname: string;
  lastname: string;
  city: string;
  state: string;
  country: string;
  sex: string;
  premium: boolean;
  created_at: string;
  updated_at: string;
  badge_type_id: number;
  profile_medium: string;
  profile: string;
  athlete_type: number;
  date_preference: string;
  measurement_preference: string;
  ftp: number | null;
  weight: number;
};

type Token = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete: unknown;
};

type RequestWithAuth = {
  auth?: {
    uid?: string;
  };
};

type AthleteProfile = {
  athlete: Athlete;
  zones: {
    [key: string]: { zones: { max: number; min: number; time: number }[] };
  };
};

type Effort = {
  id: number;
  elapsed_time: number;
  average_watts?: number;
  segment: {
    id: number;
    name: string;
    distance: number;
    average_grade: number;
    total_elevation_gain: number;
  };
  resource_state: number;
  name: string;
  moving_time: number;
  start_date: string;
  start_date_local: string;
  distance: number;
  start_index: number;
  end_index: number;
  average_cadence: number;
  device_watts: boolean;
  kom_rank: number;
  pr_rank: number;
  hidden: boolean;
};

type Activity = {
  id: number;
  sport_type?: string;
  type?: string;
  segment_efforts?: Effort[];
};

type ActivityStreamKey = 'time' | 'heartrate' | 'watts' | 'distance';

type ActivityStream = {
  [key in ActivityStreamKey]: {
    data: number[];
    series_type: string;
    original_size: number;
    resolution: string;
  };
};

type PowerCurveDuration = (typeof DURATIONS)[number];

type ActivityPowerCurve = Partial<Record<PowerCurveDuration, number>>;

type RawSegmentXoms = {
  kom?: string;
  qom?: string;
  overall?: string;
};

type SegmentXoms = {
  kom?: number;
  qom?: number;
  overall?: number;
};

type Segment = {
  id: number;
  xoms: SegmentXoms;
  resource_state: number;
  name: string;
  activity_type: string;
  distance: number;
  average_grade: number;
  maximum_grade: number;
  elevation_high: number;
  elevation_low: number;
  start_latlng: [number, number];
  end_latlng: [number, number];
  climb_category: number;
  city: string;
  state: string;
  country: string;
  private: boolean;
  hazardous: boolean;
  created_at: string;
  updated_at: string;
  total_elevation_gain: number;
  map: {
    id: string;
    polyline: string;
    resource_state: number;
  };
  effort_count: number;
  athlete_count: number;
  star_count: number;
};

type StravaSegment = Omit<Segment, 'xoms'> & {
  xoms: RawSegmentXoms;
};

export type SegmentTimePrediction = {
  timeSeconds: number;
  timeMinutes: number;
  speedMps: number;
  speedKmh: number;
  estimatedPowerW: number;
  riderWeightKg: number;
  confidence: {
    score: number;
    label: 'low' | 'medium' | 'high';
    reasons: string[];
  };
};

export type SegmentTimePredictionOptions = {
  /** Used only when Strava reports weight as 0/null. */
  fallbackRiderWeightKg?: number;
  bikeAndEquipmentWeightKg?: number;
  cda?: number;
  crr?: number;
  airDensityKgM3?: number;
  drivetrainEfficiency?: number;
  /** Discounts best recorded power when conditions may not be repeatable. */
  powerCurveRealizationFactor?: number;
  /** @deprecated Use powerCurveRealizationFactor instead. */
  histogramRealizationFactor?: number;
};

/**
 * Makes an authenticated request to the Strava API.
 *
 * @param {string} path API path.
 * @param {string} token Strava access token.
 * @return {Promise<T>} Parsed API response.
 */
async function api<T>(path: string, token: string): Promise<T> {
  const r = await fetch(API + path, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!r.ok) {
    throw new Error(`Strava ${r.status}: ${await r.text()}`);
  }

  return r.json() as Promise<T>;
}

/**
 * Gets the authenticated user's Firebase UID.
 *
 * @param {RequestWithAuth} req Callable function request.
 * @return {string} Firebase user ID.
 */
function uid(req: RequestWithAuth) {
  if (!req.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }

  return req.auth.uid;
}

/**
 * Gets the stored Strava tokens for a user and refreshes them if necessary.
 *
 * @param {string} id User ID.
 * @return {Promise<Token>} Strava token data.
 */
async function tokens(id: string): Promise<Token> {
  const s = await db.doc(`users/${id}/stravaTokens/${id}`).get();

  if (!s.exists) {
    throw new HttpsError('failed-precondition', 'Connect Strava first.');
  }

  const t = s.data() as Token;

  if (t.expires_at > Date.now() / 1000 + 120) {
    return t;
  }

  const r = await fetch(`${OAUTH}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID.value(),
      client_secret: CLIENT_SECRET.value(),
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
    }),
  });

  if (!r.ok) {
    throw new HttpsError('internal', 'Could not refresh Strava token.');
  }

  const n = (await r.json()) as Token;

  await db.doc(`users/${id}/stravaTokens/${id}`).set(
    {
      ...t,
      ...n,
    },
    { merge: true },
  );

  return {
    ...t,
    ...n,
  };
}

/**
 * Generates a signed OAuth state value.
 *
 * @param {string} uid User ID.
 * @return {string} Signed OAuth state.
 */
function state(uid: string) {
  const payload = Buffer.from(
    JSON.stringify({
      uid,
      exp: Date.now() + 600000,
    }),
  ).toString('base64url');

  const sig = crypto
    .createHmac('sha256', CLIENT_SECRET.value())
    .update(payload)
    .digest('base64url');

  return `${payload}.${sig}`;
}

export const stravaOAuthUrl = onCall(
  {
    secrets: [CLIENT_SECRET, CLIENT_ID],
    region: REGION,
  },
  async (req) => {
    const id = uid(req);
    const env = req.data.env as 'prod' | 'dev';

    const callback =
      env === 'prod'
        ? 'https://strava-kom-chaser.web.app/oauth-redirect'
        : 'http://localhost:4200/oauth-redirect';

    const q = new URLSearchParams({
      client_id: CLIENT_ID.value(),
      redirect_uri: callback,
      response_type: 'code',
      approval_prompt: 'force',
      scope: 'read_all,activity:read_all,profile:read_all',
      state: state(id),
    });

    return {
      url: `${OAUTH}/authorize?${q}`,
    };
  },
);

export const normalizeExistingSegmentsXoms = onCall(
  {
    cors: true,
    secrets: [CLIENT_SECRET, CLIENT_ID],
    region: REGION,
  },
  async () => {
    const segments = await db.collection('segments').get();

    for (const segment of segments.docs) {
      const data = segment.data() as Segment;
      data.xoms = normalizeXoms(data.xoms);
      await db.doc(segment.ref.path).set(data, { merge: true });
    }
  },
);

export const stravaOAuthCallback = onCall(
  {
    cors: true,
    secrets: [CLIENT_SECRET, CLIENT_ID],
    region: REGION,
  },
  async (req) => {
    try {
      const id = uid(req);

      const code = String(req.data.code || '');

      const r = await fetch(`${OAUTH}/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID.value(),
          client_secret: CLIENT_SECRET.value(),
          code,
          grant_type: 'authorization_code',
        }),
      });

      if (!r.ok) {
        throw new Error(await r.text());
      }

      const t = (await r.json()) as Token;

      await db.doc(`users/${id}/stravaTokens/${id}`).set({
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: t.expires_at,
        athlete: t.athlete,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return;
    } catch (e) {
      console.error(e);
      throw new Error('Strava authorization failed.');
    }
  },
);

const syncAthleteStats = async (userId: string, t: Token) => {
  const athlete = await api<Athlete>('/athlete', t.access_token);

  return db.doc(`users/${userId}`).set(
    {
      athlete,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
};

export const syncActivities = onDocumentWritten(
  {
    document: 'users/{userId}/stravaTokens/{userId}',
    region: REGION,
  },
  async (event) => {
    const id = event.params.userId;
    const t = await tokens(id);

    await syncAthleteStats(id, t);

    const activities: Activity[] = [];

    const pageLength = 50;

    for (let page = 1; page <= 2; page++) {
      const batch = await api<Activity[]>(
        `/athlete/activities?page=${page}&per_page=${pageLength}`,
        t.access_token,
      );

      activities.push(
        ...batch.filter((a) => (a.sport_type || a.type) === 'Ride'),
      );

      if (batch.length < pageLength) {
        break;
      }
    }

    console.log(`Found ${activities.length} new activities for user ${id}.`);

    const efforts: Effort[] = [];

    for (const activity of activities) {
      const activityRef = await db
        .doc(`users/${id}/activities/${activity.id}`)
        .get();

      if (activityRef.exists) {
        continue;
      }

      const activityWithEffors = await api<Activity>(
        `/activities/${activity.id}?include_all_efforts=true`,
        t.access_token,
      );

      await db.doc(`users/${id}/activities/${activity.id}`).set({
        ...activityWithEffors,
        updatedAt: FieldValue.serverTimestamp(),
      });

      for (const effort of activityWithEffors.segment_efforts || []) {
        if (effort.segment?.id) {
          const segmentRef = await db
            .doc(`segments/${effort.segment?.id}`)
            .get();

          if (!segmentRef.exists) {
            const segment = await api<StravaSegment>(
              `/segments/${effort.segment.id}`,
              t.access_token,
            );
            await db.doc(`segments/${effort.segment?.id}`).set({
              resource_state: segment.resource_state,
              name: segment.name,
              activity_type: segment.activity_type,
              distance: segment.distance,
              average_grade: segment.average_grade,
              maximum_grade: segment.maximum_grade,
              elevation_high: segment.elevation_high,
              elevation_low: segment.elevation_low,
              start_latlng: segment.start_latlng,
              end_latlng: segment.end_latlng,
              climb_category: segment.climb_category,
              city: segment.city,
              state: segment.state,
              country: segment.country,
              private: segment.private,
              hazardous: segment.hazardous,
              created_at: segment.created_at,
              updated_at: segment.updated_at,
              total_elevation_gain: segment.total_elevation_gain,
              map: {
                id: segment.map.id,
                polyline: segment.map.polyline,
                resource_state: segment.map.resource_state,
              },
              xoms: normalizeXoms(segment.xoms),
              effort_count: segment.effort_count,
              athlete_count: segment.athlete_count,
              star_count: segment.star_count,
            });
          }

          const segmentEffortRef = await db
            .doc(`users/${id}/segmentEfforts/${effort.id}`)
            .get();

          if (!segmentEffortRef.exists) {
            efforts.push(effort);
            await db.doc(`users/${id}/segmentEfforts/${effort.id}`).set({
              resource_state: effort.resource_state,
              name: effort.name,
              elapsed_time: effort.elapsed_time,
              moving_time: effort.moving_time,
              start_date: effort.start_date,
              start_date_local: effort.start_date_local,
              distance: effort.distance,
              start_index: effort.start_index,
              end_index: effort.end_index,
              average_cadence: effort.average_cadence,
              device_watts: effort.device_watts,
              average_watts: effort.average_watts,
              kom_rank: effort.kom_rank,
              pr_rank: effort.pr_rank,
              hidden: effort.hidden,
              segmentId: effort.segment?.id,
            });
          }
        }
      }
    }

    return {
      activities: activities.length,
      segmentEfforts: efforts.length,
    };
  },
);

/**
 * Normalizes Strava kom/qom/overall strings to seconds.
 *
 * The database stores seconds for easier calculations.
 *
 * @param {RawSegmentXoms | SegmentXoms} xoms Strava or stored XOM values.
 * @return {SegmentXoms} Normalized xoms with seconds.
 */
function normalizeXoms(xoms: RawSegmentXoms | SegmentXoms): SegmentXoms {
  if (!xoms) return xoms;
  return {
    kom: normalizeXomValue(xoms.kom),
    qom: normalizeXomValue(xoms.qom),
    overall: normalizeXomValue(xoms.overall),
  };
}

/**
 * Converts one XOM value to seconds.
 *
 * @param {string | number | undefined} value Raw or stored XOM value.
 * @return {number | undefined} XOM value in seconds.
 */
function normalizeXomValue(value: string | number | undefined) {
  if (typeof value === 'number') {
    return value;
  }

  return value ? timeStringToSeconds(value) : undefined;
}

/**
 * Converts a time string in "mm:ss", "h:mm:ss" or "SSs" format to seconds.
 *
 * @param {string} time Time string in "mm:ss", "h:mm:ss" or "SSs" format.
 * @return {number} Time in seconds.
 */
function timeStringToSeconds(time: string): number {
  const parts = time.split(':').map(Number);
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (time.endsWith('s')) {
    return Number(time.slice(0, -1));
  } else if (parts.length === 1) {
    return Number(parts[0]);
  }

  throw new Error(`Invalid time format: ${time}`);
}

export const onNewActivity = onDocumentCreated(
  {
    document: 'users/{userId}/activities/{activityId}',
    region: REGION,
  },
  async (event) => {
    const userId = event.params.userId;
    const activityId = event.params.activityId;
    const t = await tokens(userId);

    const activityStream = await api<ActivityStream>(
      `/activities/${activityId}/streams?keys=watts&key_by_type=true`,
      t.access_token,
    );

    const powerCurve = calculatePowerCurve(activityStream.watts.data);

    await db
      .doc(`users/${userId}/activities/${activityId}/powerCurve/${activityId}`)
      .set({
        powerCurve,
      });

    return {
      powerCurve,
    };
  },
);

export const onNewPowerCurve = onDocumentWritten(
  {
    document: 'users/{userId}/activities/{activityId}/powerCurve/{activityId}',
    region: REGION,
  },
  async (event) => {
    const userId = event.params.userId;

    const activitiesPath = `users/${userId}/activities`;

    const athleteActivities = await db.collection(activitiesPath).get();

    const powerCurves = await Promise.all(
      athleteActivities.docs.map(async (activityRef) => {
        const powerCurveRef = await db
          .doc(
            `${activitiesPath}/${activityRef.id}/powerCurve/${activityRef.id}`,
          )
          .get();
        return powerCurveRef.data()?.powerCurve as ActivityPowerCurve;
      }),
    );

    const bestPowerCurve = powerCurves.reduce(
      (best: ActivityPowerCurve, current) => {
        if (!current) return best;
        for (const duration of DURATIONS) {
          const currentPowerW = current[duration];

          if (
            typeof currentPowerW === 'number' &&
            Number.isFinite(currentPowerW) &&
            currentPowerW > (best[duration] || 0)
          ) {
            best[duration] = currentPowerW;
          }
        }
        return best;
      },
      {} as ActivityPowerCurve,
    );

    return db.doc(`users/${userId}/performance/profile`).set(
      {
        powerCurve: bestPowerCurve,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  },
);

/**
 * Calculates best observed power across configured durations.
 *
 * @param {number[]} power Array of power values in watts.
 * @return {ActivityPowerCurve} Best observed power by duration.
 */
function calculatePowerCurve(power: number[]): ActivityPowerCurve {
  const curve: ActivityPowerCurve = {};

  // Durations we care about, in seconds.
  for (const duration of DURATIONS) {
    if (power.length < duration) continue;

    let windowSum = 0;
    let maxAverage = 0;

    // First window
    for (let i = 0; i < duration; i++) {
      windowSum += power[i];
    }

    maxAverage = windowSum / duration;

    // Slide the window through the activity.
    for (let i = duration; i < power.length; i++) {
      windowSum += power[i];
      windowSum -= power[i - duration];

      const average = windowSum / duration;

      if (average > maxAverage) {
        maxAverage = average;
      }
    }

    curve[duration] = maxAverage;
  }

  return curve;
}

export const onNewSegment = onDocumentWritten(
  {
    document: 'segments/{segmentId}',
    region: REGION,
  },
  async (event) => {
    const segmentId = event.params.segmentId;

    const users = await db.collection('users').get();

    for (const user of users.docs) {
      const id = user.id;

      const athleteRef = await db.doc(`users/${id}`).get();

      if (!athleteRef.exists) {
        continue;
      }

      const powerCurveRef = await db
        .doc(`users/${id}/performance/profile`)
        .get();

      if (!powerCurveRef.exists) {
        continue;
      }

      console.log('Processing segment', segmentId);
      const segmentRef = await db.doc(`segments/${segmentId}`).get();

      if (!segmentRef.exists) {
        continue;
      }

      const score = computeSegmentScore(
        segmentRef.data() as Segment,
        athleteRef.data() as AthleteProfile,
        powerCurveRef.data()?.powerCurve as ActivityPowerCurve,
      );

      console.log('Computed score', score);

      await db.doc(`users/${id}/segments/${segmentId}`).set({
        segment: segmentRef.ref,
        score,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  },
);

/**
 * Computes the KOM opportunity score for a stored segment and athlete profile.
 *
 * @param {Segment} segment Strava segment data.
 * @param {AthleteProfile} athleteProfile Stored athlete performance profile.
 * @param {ActivityPowerCurve} powerCurve Best observed power by duration.
 * @return {object} Segment opportunity score details.
 */
function computeSegmentScore(
  segment: Segment,
  athleteProfile: AthleteProfile,
  powerCurve: ActivityPowerCurve,
): {
  estimatedTimeDiff: number;
  estimatedPowerNeeded: number;
  confidence: {
    score: number;
    label: 'low' | 'medium' | 'high';
    reasons: string[];
  };
} {
  const timePrediction = predictSegmentTime(
    segment,
    athleteProfile.athlete,
    powerCurve,
  );
  return {
    estimatedTimeDiff: timePrediction.timeSeconds - (segment.xoms.kom || 0),
    estimatedPowerNeeded: timePrediction.estimatedPowerW,
    confidence: timePrediction.confidence,
  };
}

/**
 * Estimates the athlete's best time from a stored power-duration curve.
 *
 * The curve contains best observed average power for fixed durations. The
 * estimate interpolates between those benchmark durations and finds the effort
 * duration at which the athlete's available power equals the segment's
 * required rider power.
 *
 * @param {object} segment Segment geometry and grade.
 * @param {object} athlete Athlete physiology data.
 * @param {ActivityPowerCurve} powerCurve Best observed power by duration.
 * @param {SegmentTimePredictionOptions} options Prediction tuning options.
 * @return {SegmentTimePrediction} Estimated segment time and confidence.
 */
export function predictSegmentTime(
  segment: Pick<
    Segment,
    'id' | 'distance' | 'average_grade' | 'elevation_low' | 'elevation_high'
  >,
  athlete: Pick<Athlete, 'weight' | 'ftp'>,
  powerCurve: ActivityPowerCurve,
  options: SegmentTimePredictionOptions = {},
): SegmentTimePrediction {
  const distanceM = requirePositiveFinite(segment.distance, 'segment.distance');
  // Strava grades are percentages: 5.7 means 5.7%, not 5.7.
  const gradeRatio =
    requireFinite(segment.average_grade, 'segment.average_grade') / 100;

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

  const totalMassKg = riderWeightKg + bikeAndEquipmentWeightKg;
  const theta = Math.atan(gradeRatio);
  const gravity = 9.80665;
  const constantForceN =
    totalMassKg * gravity * (Math.sin(theta) + crr * Math.cos(theta));
  const aeroCoefficient = 0.5 * rho * cda;

  const availablePowerAt = (durationSeconds: number): number =>
    bestAveragePowerForDuration(powerCurvePoints, durationSeconds) *
    realizationFactor;

  const requiredRiderPowerAt = (durationSeconds: number): number => {
    const speedMps = distanceM / durationSeconds;
    const wheelPowerW =
      constantForceN * speedMps + aeroCoefficient * speedMps ** 3;

    // On a descent gravity may provide all the power required at a given speed.
    return Math.max(0, wheelPowerW / drivetrainEfficiency);
  };

  const balanceAt = (durationSeconds: number): number =>
    requiredRiderPowerAt(durationSeconds) - availablePowerAt(durationSeconds);

  // At the lower bound the required power is deliberately enormous. Increase
  // the upper bound until the rider's estimated available power is sufficient.
  let lowerSeconds = Math.max(1, distanceM / 60);
  let upperSeconds = Math.max(60, distanceM / 2);

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
  const estimatedPowerW = availablePowerAt(timeSeconds);
  const shortestCurveSeconds = powerCurvePoints[0].durationSeconds;
  const longestCurveSeconds =
    powerCurvePoints[powerCurvePoints.length - 1].durationSeconds;

  const confidenceReasons = [
    'Power between benchmark durations is interpolated from the stored curve.',
    'Wind, corners, road surface, braking, and the detailed ' +
      'elevation profile are unavailable.',
  ];
  let confidenceScore = 80;

  if (!hasMeasuredWeight) {
    confidenceScore -= 25;
    confidenceReasons.push(
      `Athlete weight is unavailable; ${riderWeightKg} kg was assumed.`,
    );
  }

  if (!(Number.isFinite(athlete.ftp) && (athlete.ftp ?? 0) > 0)) {
    confidenceScore -= 5;
    confidenceReasons.push(
      'FTP is unavailable, so it could not be used as a plausibility check.',
    );
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

  console.log(
    `Predicted segment ${segment.id} time: ${timeSeconds.toFixed(
      1,
    )} s, speed: ${speedMps.toFixed(2)} m/s, power: ${estimatedPowerW.toFixed(
      0,
    )} W, confidence: ${confidenceScore}%`,
  );

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

type PowerCurvePoint = {
  durationSeconds: number;
  powerW: number;
};

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
 * Requires a finite number.
 *
 * @param {number} value Value to validate.
 * @param {string} name Name to use in the thrown validation error.
 * @return {number} The validated value.
 */
function requireFinite(value: number, name: string): number {
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
function requirePositiveFinite(value: number, name: string): number {
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
function requireInRange(
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
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Rounds a number to a fixed number of decimal places.
 *
 * @param {number} value Value to round.
 * @param {number} decimalPlaces Number of decimal places.
 * @return {number} The rounded value.
 */
function round(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}
