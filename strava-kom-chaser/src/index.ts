import {onCall, HttpsError} from "firebase-functions/v2/https";
import {defineSecret} from "firebase-functions/params";
import {initializeApp} from "firebase-admin/app";
import {
  getFirestore,
  FieldPath,
  FieldValue,
  Transaction,
} from "firebase-admin/firestore";
import {getFunctions} from "firebase-admin/functions";
import {onTaskDispatched} from "firebase-functions/v2/tasks";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {
  onDocumentCreated,
  onDocumentWritten,
} from "firebase-functions/v2/firestore";
import crypto from "node:crypto";

initializeApp();
const db = getFirestore();
const CLIENT_ID = defineSecret("STRAVA_CLIENT_ID");
const CLIENT_SECRET = defineSecret("STRAVA_CLIENT_SECRET");
const API = "https://www.strava.com/api/v3";
const OAUTH = "https://www.strava.com/oauth";
const REGION = "europe-west1";

const QUARTER_HOUR = 15 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const RESET_MARGIN = 5000;
const LEASE_DURATION = 120 * 1000;
const PAGE_SIZE = 100;
const EFFORT_BATCH_SIZE = 40;
const JOBS = "stravaSyncJobs";
const QUOTA = "stravaSyncControl/quota";

type QuotaBucket = {
  limit: number;
  used: number;
  start: number;
  duration: number;
};
// Each pair holds the 15-minute quota followed by the daily quota.
type QuotaState = {
  overall: [QuotaBucket, QuotaBucket];
  read: [QuotaBucket, QuotaBucket];
  blockedUntil: number;
  pending: Record<string, number>;
};
type SyncJob = {
  runId: string;
  connectionId: string;
  status:
    | "pending"
    | "running"
    | "waiting"
    | "complete"
    | "complete_with_errors"
    | "needs_auth";
  nextRunAt?: number;
  leaseOwner?: string;
  leaseUntil?: number;
  failures: number;
  attempts: number;
  backfillStarted?: boolean;
};
type SyncWork = {
  kind:
    | "athlete"
    | "page"
    | "activity"
    | "segment"
    | "stream";
  status: "pending" | "complete" | "failed";
  resourceId?: number;
  page?: number;
  before?: number;
  phase?: "details" | "efforts";
  effortIndex?: number;
  lastError?: string;
};
type ClaimedJob = SyncJob & {userId: string; leaseOwner: string};
type WorkChild = {id: string; work: SyncWork};

/** Signals a durable pause until the applicable Strava quota resets. */
class QuotaUnavailable extends Error {
  /** @param {number} resumeAt Earliest retry time, in epoch milliseconds. */
  constructor(readonly resumeAt: number) {
    super("Strava quota exhausted.");
  }
}

/** Preserves HTTP status without retaining a private response body. */
class StravaRequestError extends Error {
  /** @param {number} status Strava HTTP response status. */
  constructor(readonly status: number) {
    // Response bodies can contain private athlete data; do not persist them.
    super(`Strava request failed with HTTP ${status}.`);
  }
}

/** Authorization must be renewed by the athlete. */
class ConnectionRequired extends Error {}

const quotaBucket = (
  now: number,
  duration: number,
  limit: number,
): QuotaBucket => ({
  limit,
  used: 0,
  start: Math.floor(now / duration) * duration,
  duration,
});

const readQuota = (data: QuotaState | undefined, now: number): QuotaState => {
  const quota = data || {
    overall: [quotaBucket(now, QUARTER_HOUR, 200), quotaBucket(now, DAY, 2000)],
    read: [quotaBucket(now, QUARTER_HOUR, 100), quotaBucket(now, DAY, 1000)],
    blockedUntil: 0,
    pending: {},
  };
  quota.pending ||= {};
  for (const [id, expiresAt] of Object.entries(quota.pending)) {
    if (expiresAt <= now) delete quota.pending[id];
  }
  for (const bucket of [...quota.overall, ...quota.read]) {
    if (now >= bucket.start + bucket.duration + RESET_MARGIN) {
      bucket.start = Math.floor(now / bucket.duration) * bucket.duration;
      bucket.used = Object.keys(quota.pending).length;
    }
  }
  return quota;
};

// Quota updates share one transaction across sync and discovery requests.
// These callbacks only change data; HTTP calls stay outside the transaction.
const updateQuota = <T>(
  update: (quota: QuotaState, now: number) => T,
): Promise<T> =>
    db.runTransaction(async (tx) => {
      const ref = db.doc(QUOTA);
      const now = Date.now();
      const quota = readQuota((await tx.get(ref)).data() as QuotaState, now);
      const result = update(quota, now);
      tx.set(ref, quota);
      return result;
    });

const quotaResumeAt = (quota: QuotaState, now: number): number =>
  Math.max(
    now,
    quota.blockedUntil,
    ...[...quota.overall, ...quota.read]
      .filter((bucket) => bucket.used >= bucket.limit)
      .map((bucket) => bucket.start + bucket.duration + RESET_MARGIN),
  );

const headerPair = (value: string | null): number[] | undefined => {
  if (!value) return undefined;
  const pair = value.split(",").map((part) => Number(part.trim()));
  return pair.length === 2 && pair.every((n) => Number.isFinite(n) && n >= 0) ?
    pair :
    undefined;
};

const reserveQuota = async (): Promise<string> => {
  const reservationId = crypto.randomUUID();
  await updateQuota((quota, now) => {
    const resumeAt = quotaResumeAt(quota, now);
    if (resumeAt > now) throw new QuotaUnavailable(resumeAt);
    for (const bucket of [...quota.overall, ...quota.read]) bucket.used++;
    quota.pending[reservationId] = now + LEASE_DURATION;
  });
  return reservationId;
};

const recordQuota = async (
  response: Response,
  requestedAt: number,
  reservationId?: string,
): Promise<number> =>
  updateQuota((quota, now) => {
    if (reservationId) delete quota.pending[reservationId];
    const outstanding = Object.keys(quota.pending).length;
    const serverTime = Date.parse(response.headers.get("date") || "");
    const observedAt = Number.isFinite(serverTime) ? serverTime : requestedAt;
    for (const [key, prefix] of [
      ["overall", "x-ratelimit"],
      ["read", "x-readratelimit"],
    ] as const) {
      const limits = headerPair(response.headers.get(`${prefix}-limit`));
      const usage = headerPair(response.headers.get(`${prefix}-usage`));
      quota[key].forEach((bucket, index) => {
        if (limits?.[index]) bucket.limit = limits[index];
        const start =
          Math.floor(observedAt / bucket.duration) * bucket.duration;
        if (usage && start >= bucket.start) {
          if (start > bucket.start) {
            bucket.start = start;
            bucket.used = 0;
          }
          // Headers may not include requests still in flight. Retain headroom
          // for those requests even when observed usage jumps unexpectedly.
          bucket.used = Math.max(bucket.used, usage[index] + outstanding);
        }
      });
    }
    let resumeAt = quotaResumeAt(quota, now);
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const retryAt = retryAfter ?
        /^\d+$/.test(retryAfter) ?
          now + Number(retryAfter) * 1000 :
          Date.parse(retryAfter) :
        0;
      if (resumeAt <= now) {
        resumeAt =
          (Math.floor(now / QUARTER_HOUR) + 1) * QUARTER_HOUR + RESET_MARGIN;
      }
      quota.blockedUntil = Math.max(
        resumeAt,
        Number.isFinite(retryAt) ? retryAt + RESET_MARGIN : 0,
      );
      resumeAt = quota.blockedUntil;
    }
    return resumeAt;
  });

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
    [key: string]: {zones: {max: number; min: number; time: number}[]};
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
  resource_state?: number;
  sport_type?: string;
  type?: string;
  segment_efforts?: Effort[];
};

type ActivityStreamKey = "time" | "heartrate" | "watts" | "distance";

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

type StravaSegment = Omit<Segment, "xoms"> & {
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
    label: "low" | "medium" | "high";
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
  const reservationId = await reserveQuota();
  const requestedAt = Date.now();
  let recorded = false;
  try {
    const r = await fetch(API + path, {
      headers: {Authorization: `Bearer ${token}`},
      signal: AbortSignal.timeout(20000),
    });
    const resumeAt = await recordQuota(r, requestedAt, reservationId);
    recorded = true;
    if (r.status === 429) throw new QuotaUnavailable(resumeAt);
    if (!r.ok) throw new StravaRequestError(r.status);
    return r.json() as Promise<T>;
  } finally {
    if (!recorded) {
      await updateQuota((quota) => {
        // A timed-out request may have reached Strava; keep its usage.
        delete quota.pending[reservationId];
      });
    }
  }
}

/**
 * Gets the authenticated user's Firebase UID.
 *
 * @param {RequestWithAuth} req Callable function request.
 * @return {string} Firebase user ID.
 */
function uid(req: RequestWithAuth) {
  if (!req.auth?.uid) {
    throw new HttpsError("unauthenticated", "Sign in first.");
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
    throw new ConnectionRequired("Connect Strava first.");
  }

  const t = s.data() as Token;

  if (t.expires_at > Date.now() / 1000 + 120) {
    return t;
  }

  const r = await fetch(`${OAUTH}/token`, {
    method: "POST",
    signal: AbortSignal.timeout(20000),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID.value(),
      client_secret: CLIENT_SECRET.value(),
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
    }),
  });

  if (!r.ok) {
    if (r.status === 429) {
      throw new QuotaUnavailable(await recordQuota(r, Date.now()));
    }
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      throw new ConnectionRequired(
        "Reconnect Strava to refresh authorization.",
      );
    }
    throw new StravaRequestError(r.status);
  }

  const n = (await r.json()) as Token;

  await db.doc(`users/${id}/stravaTokens/${id}`).set(
    {
      ...t,
      ...n,
    },
    {merge: true},
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
  ).toString("base64url");

  const sig = crypto
    .createHmac("sha256", CLIENT_SECRET.value())
    .update(payload)
    .digest("base64url");

  return `${payload}.${sig}`;
}

export const stravaOAuthUrl = onCall(
  {
    secrets: [CLIENT_SECRET, CLIENT_ID],
    region: REGION,
  },
  async (req) => {
    const id = uid(req);
    const env = req.data.env as "prod" | "dev";

    const callback =
      env === "prod" ?
        "https://strava-kom-chaser.web.app/oauth-redirect" :
        "http://localhost:4200/oauth-redirect";

    const q = new URLSearchParams({
      client_id: CLIENT_ID.value(),
      redirect_uri: callback,
      response_type: "code",
      approval_prompt: "force",
      scope: "read_all,activity:read_all,profile:read_all",
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
    const segments = await db.collection("segments").get();

    for (const segment of segments.docs) {
      const data = segment.data() as Segment;
      data.xoms = normalizeXoms(data.xoms);
      await db.doc(segment.ref.path).set(data, {merge: true});
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

      const code = String(req.data.code || "");

      const r = await fetch(`${OAUTH}/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID.value(),
          client_secret: CLIENT_SECRET.value(),
          code,
          grant_type: "authorization_code",
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
        connectionId: crypto.randomUUID(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return;
    } catch (e) {
      console.error(e);
      throw new Error("Strava authorization failed.");
    }
  },
);

// Firestore remembers the unfinished work. Cloud Tasks runs one step at a time,
// then the worker saves its progress and schedules the next step.
const enqueueSync = async (
  userId: string,
  runId: string,
  at: number,
): Promise<void> => {
  await getFunctions()
    .taskQueue(`locations/${REGION}/functions/processStravaSync`)
    .enqueue(
      {userId, runId},
      {
        scheduleTime: new Date(Math.max(Date.now(), at)),
        dispatchDeadlineSeconds: 100,
      },
    );
};

const workCollection = (job: {userId: string; runId: string}) =>
  db.collection(`${JOBS}/${job.userId}/runs/${job.runId}/work`);

const startSync = async (
  userId: string,
  connectionId: string,
): Promise<void> => {
  const ref = db.doc(`${JOBS}/${userId}`);
  const job = await db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data() as SyncJob | undefined;
    if (current?.connectionId === connectionId && current.backfillStarted) {
      return current;
    }
    // Reauthorization resumes an unfinished run instead of losing its backlog.
    const resume =
      current && !["complete", "complete_with_errors"].includes(current.status);
    const next: SyncJob = {
      runId: resume ? current.runId : crypto.randomUUID(),
      connectionId,
      status: "pending",
      nextRunAt: Date.now(),
      failures: resume ? current.failures : 0,
      attempts: 0,
      backfillStarted: true,
    };
    tx.set(ref, next);
    if (!resume || !current.backfillStarted) {
      const work = workCollection({userId, runId: next.runId});
      tx.set(work.doc("athlete"), {kind: "athlete", status: "pending"});
      tx.set(work.doc("page"), {
        kind: "page",
        status: "pending",
        page: 1,
        // Bound the backfill so new activities do not shift page offsets.
        before: Math.floor(Date.now() / 1000),
      });
    }
    return next;
  });
  if (job.nextRunAt !== undefined) {
    await enqueueSync(userId, job.runId, job.nextRunAt);
  }
};

export const syncActivities = onDocumentWritten(
  {
    document: "users/{userId}/stravaTokens/{userId}",
    region: REGION,
    retry: true,
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!after) return;
    // Refreshing tokens preserves connectionId and does not start a backfill.
    if (before && before.connectionId === after.connectionId) return;
    await startSync(event.params.userId, after.connectionId || event.id);
  },
);

type ExploreTile = { bounds: number[]; depth: number };
type ExploreJob = {
  pending: ExploreTile[];
  visited: number;
  saturated: number;
  startedAt: number;
  lease: string;
  leaseUntil: number;
};
type ExplorerSegment = {
  id: number;
  name: string;
  start_latlng: number[];
  end_latlng: number[];
  distance?: number;
  avg_grade?: number;
  elev_difference?: number;
  climb_category?: number;
  points?: string;
};

const tileSize = ([south, west, north, east]: number[]): number[] => [
  (north - south) * 111320,
  (east - west) * 111320 * Math.cos((south + north) * Math.PI / 360),
];

// Keep parent results: smaller viewports may rank different segments.
const splitTile = ({bounds, depth}: ExploreTile): ExploreTile[] => {
  if (depth >= 8 || Math.min(...tileSize(bounds)) / 2 < 250) return [];
  const [s, w, n, e] = bounds;
  const lat = (s + n) / 2;
  const lng = (w + e) / 2;
  const dy = (n - s) * 0.01;
  const dx = (e - w) * 0.01;
  return [[s, w, lat + dy, lng + dx], [s, lng - dx, lat + dy, e],
    [lat - dy, w, n, lng + dx], [lat - dy, lng - dx, n, e]]
    .map((child) => ({bounds: child, depth: depth + 1}));
};

export const discoverSegments = onCall<{
  bounds: number[];
  activity_type?: "riding" | "running";
}>(
  {region: REGION, secrets: [CLIENT_ID, CLIENT_SECRET], timeoutSeconds: 90},
  async (req) => {
    const userId = uid(req);
    const {bounds, activity_type: activity = "riding"} = req.data || {};
    if (!Array.isArray(bounds) || bounds.length !== 4 ||
      !bounds.every(Number.isFinite) || bounds[0] < -85 || bounds[2] > 85 ||
      bounds[1] < -180 || bounds[3] > 180 ||
      bounds[0] >= bounds[2] || bounds[1] >= bounds[3] ||
      Math.max(...tileSize(bounds)) > 100000 ||
      !["riding", "running"].includes(activity)) {
      throw new HttpsError("invalid-argument",
        "Use south,west,north,east bounds up to 100 km, riding or running.");
    }
    const queryId = crypto.createHash("sha256")
      .update(JSON.stringify([bounds, activity])).digest("hex");
    const jobRef = db.doc(`segmentDiscoveryJobs/${queryId}`);
    const segments = db.collection("segments");
    const lease = crypto.randomUUID();
    let job = await db.runTransaction(async (tx) => {
      const saved = (await tx.get(jobRef)).data() as ExploreJob | undefined;
      const now = Date.now();
      if (saved && saved.leaseUntil > now) {
        throw new HttpsError("aborted", "Discovery already running. Retry.");
      }
      const next: ExploreJob = {
        ...(saved && saved.startedAt + DAY > now ? saved : {
          pending: [{bounds, depth: 0}], visited: 0,
          saturated: 0, startedAt: now,
        }),
        lease, leaseUntil: now + LEASE_DURATION,
      };
      tx.set(jobRef, next);
      return next;
    });
    let retryAt: number | null = null;
    const deadline = Date.now() + 30000;
    try {
      // Bound each invocation; the caller resumes the same persisted frontier.
      for (let calls = 0;
        job.pending.length && calls < 20 && Date.now() < deadline; calls++) {
        const tile = job.pending[job.pending.length - 1];
        const query = new URLSearchParams({
          bounds: tile.bounds.join(","), activity_type: activity,
        });
        const token = await tokens(userId);
        const response = await api<{segments: ExplorerSegment[]}>(
          `/segments/explore?${query}`, token.access_token,
        );
        if (!Array.isArray(response.segments) ||
          response.segments.length > 10) {
          throw new HttpsError("internal", "Unexpected Explore response.");
        }
        const fetchedAt = new Date(Date.now());
        const documents = response.segments.map((segment) => {
          const validPoint = (point: number[]) => Array.isArray(point) &&
            point.length === 2 && point.every(Number.isFinite) &&
            Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180;
          if (!segment || !Number.isSafeInteger(segment.id) ||
            segment.id <= 0 ||
            typeof segment.name !== "string" ||
            !validPoint(segment.start_latlng) ||
            !validPoint(segment.end_latlng)) {
            throw new HttpsError("internal", "Invalid Explore segment.");
          }
          // Whitelist summary fields; do not persist athlete-specific data.
          return stravaData({
            id: segment.id, name: segment.name, resource_state: 2,
            activity_type: activity === "riding" ? "Ride" : "Run",
            start_latlng: segment.start_latlng, end_latlng: segment.end_latlng,
            distance: segment.distance, average_grade: segment.avg_grade,
            elev_difference: segment.elev_difference,
            climb_category: segment.climb_category,
            map: segment.points ? {polyline: segment.points} : undefined,
          });
        });
        const saturated = response.segments.length === 10;
        const children = saturated ? splitTile(tile) : [];
        const next = {...job,
          pending: [...job.pending.slice(0, -1), ...children],
          visited: job.visited + 1,
          saturated: job.saturated + (saturated && !children.length ? 1 : 0)};
        await db.runTransaction(async (tx) => {
          const current = (await tx.get(jobRef)).data() as
            ExploreJob | undefined;
          if (current?.lease !== lease || current.leaseUntil <= Date.now()) {
            throw new HttpsError("aborted", "Discovery expired. Retry.");
          }
          const unique = [...new Map(documents.map((s) => [s.id, s])).values()];
          const refs = unique.map((s) => segments.doc(String(s.id)));
          const existing = refs.length ? await tx.getAll(...refs) : [];
          // Preserve full details and commit summaries with their checkpoint.
          for (const [index, document] of unique.entries()) {
            const cached = existing[index];
            if (cached.exists && cached.data()?.resource_state !== 2) continue;
            tx.set(refs[index], {...document, fetchedAt,
              expiresAt: new Date(fetchedAt.getTime() + DAY)});
          }
          tx.set(jobRef, next);
        });
        job = next;
      }
    } catch (error) {
      if (error instanceof QuotaUnavailable) {
        retryAt = error.resumeAt;
      } else if (error instanceof ConnectionRequired ||
        (error instanceof StravaRequestError && error.status === 401)) {
        throw new HttpsError("failed-precondition", "Reconnect Strava.");
      } else if (error instanceof StravaRequestError && error.status === 403) {
        throw new HttpsError("permission-denied",
          "Strava Explore requires Extended Access Tier permission.");
      } else if (error instanceof HttpsError) {
        throw error;
      } else {
        throw new HttpsError("unavailable",
          "Discovery interrupted. Call again with the same bounds to resume.");
      }
    } finally {
      await db.runTransaction(async (tx) => {
        const current = (await tx.get(jobRef)).data() as ExploreJob | undefined;
        if (current?.lease === lease) tx.update(jobRef, {leaseUntil: 0});
      });
    }
    return {
      status: job.pending.length ? "paused" : "complete",
      retryAt: job.pending.length ? retryAt ?? Date.now() : null,
      pending: job.pending.length, visited: job.visited,
      saturated: job.saturated,
      cachePath: "segments", exhaustive: false,
    };
  },
);

// Also supports the existing frontend's explicit sync button.
export const syncStravaData = onCall({region: REGION}, async (req) => {
  const userId = uid(req);
  const token = await db.doc(`users/${userId}/stravaTokens/${userId}`).get();
  if (!token.exists) {
    throw new HttpsError("failed-precondition", "Connect Strava first.");
  }
  await startSync(userId, crypto.randomUUID());
  return {queued: true};
});

// Only the lease owner can save progress. A crashed worker loses its lease
// after two minutes, allowing the recovery schedule to resume its work.
const claimJob = async (
  userId: string,
  runId: string,
): Promise<ClaimedJob | undefined> =>
  db.runTransaction(async (tx) => {
    const ref = db.doc(`${JOBS}/${userId}`);
    const job = (await tx.get(ref)).data() as SyncJob | undefined;
    const now = Date.now();
    if (
      !job ||
      job.runId !== runId ||
      job.nextRunAt === undefined ||
      job.nextRunAt > now ||
      (job.leaseUntil || 0) > now
    ) {
      return undefined;
    }
    const leaseOwner = crypto.randomUUID();
    tx.update(ref, {
      status: "running",
      leaseOwner,
      leaseUntil: now + LEASE_DURATION,
      nextRunAt: now + LEASE_DURATION,
    });
    return {...job, userId, leaseOwner};
  });

const ownsLease = (current: SyncJob | undefined, job: ClaimedJob): boolean =>
  current?.runId === job.runId &&
  current.leaseOwner === job.leaseOwner &&
  (current.leaseUntil || 0) > Date.now();

type WorkResult = {
  checkpoint?: Partial<SyncWork>;
  children?: WorkChild[];
  save?: (tx: Transaction) => void;
};
type WorkContext = {
  job: ClaimedJob;
  work: SyncWork;
  request: <T>(path: string) => Promise<T>;
};
type WorkHandler = (context: WorkContext) => Promise<WorkResult | void>;

const workItem = (kind: SyncWork["kind"], resourceId: number): WorkChild => ({
  id: `${kind}-${resourceId}`,
  work: {kind, resourceId, status: "pending"},
});

// Save the data and its follow-up work together. Retrying a step can repeat
// a GET, but cannot skip the segments or streams of an already saved activity.
const commitWork = async (
  job: ClaimedJob,
  workId: string,
  {checkpoint = {}, children = [], save}: WorkResult = {},
): Promise<void> => {
  await db.runTransaction(async (tx) => {
    const jobRef = db.doc(`${JOBS}/${job.userId}`);
    const current = (await tx.get(jobRef)).data() as SyncJob | undefined;
    if (!ownsLease(current, job)) throw new Error("Sync lease expired.");
    const work = workCollection(job);
    const byId = new Map(children.map((child) => [child.id, child]));
    const unique = [...byId.values()];
    const existing = unique.length ?
      await tx.getAll(...unique.map((child) => work.doc(child.id))) : [];
    unique.forEach((child, index) => {
      if (!existing[index].exists) tx.set(work.doc(child.id), child.work);
    });
    save?.(tx);
    tx.set(work.doc(workId),
      {status: "complete", ...checkpoint}, {merge: true});
    if (checkpoint.status === "failed") {
      tx.update(jobRef, {failures: FieldValue.increment(1)});
    }
  });
};

// Firestore rejects undefined optional fields in Strava responses.
const stravaData = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// Callbacks fetch outside the transaction and return what should be saved.
// A callback with no result simply completes an already cached work item.
const processWork = async (
  job: ClaimedJob,
  workId: string,
  work: SyncWork,
  callback: WorkHandler,
): Promise<void> => {
  const result = await callback({
    job,
    work,
    request: async <T>(path: string) =>
      api<T>(path, (await tokens(job.userId)).access_token),
  });
  await commitWork(job, workId, result || {});
};

const syncAthlete: WorkHandler = async ({job, request}) => {
  const athlete = await request<Athlete>("/athlete");
  return {
    save: (tx) => tx.set(db.doc(`users/${job.userId}`), {
      athlete, updatedAt: FieldValue.serverTimestamp(),
    }, {merge: true}),
  };
};

const syncActivityPage: WorkHandler = async ({work, request}) => {
  const page = work.page || 1;
  const activities = await request<Activity[]>(
    `/athlete/activities?page=${page}&per_page=${PAGE_SIZE}` +
      `&before=${work.before}`,
  );
  return {
    checkpoint: {
      page: page + 1,
      status: activities.length < PAGE_SIZE ? "complete" : "pending",
    },
    children: activities.map((activity) => workItem("activity", activity.id)),
  };
};

// An existing activity can still have unfinished segment and stream work.
const syncActivity: WorkHandler = async (context) => {
  const {job, work, request} = context;
  if (work.phase === "efforts") return syncActivityEfforts(context);
  const ref = db.doc(`users/${job.userId}/activities/${work.resourceId}`);
  const cached = (await ref.get()).data() as Activity | undefined;
  const hasDetails = cached?.resource_state === 3 || cached?.segment_efforts;
  const activity = cached && hasDetails ? cached : await request<Activity>(
    `/activities/${work.resourceId}?include_all_efforts=true`,
  );
  return {
    checkpoint: {status: "pending", phase: "efforts", effortIndex: 0},
    children: [workItem("stream", activity.id)],
    save: (tx) => tx.set(ref, {
      ...activity, stravaSyncRun: job.runId,
      updatedAt: FieldValue.serverTimestamp(),
    }, {merge: true}),
  };
};

const syncActivityEfforts: WorkHandler = async ({job, work}) => {
  const ref = db.doc(`users/${job.userId}/activities/${work.resourceId}`);
  const activity = (await ref.get()).data() as Activity | undefined;
  if (!activity) return {checkpoint: {status: "pending", phase: "details"}};
  const efforts = activity.segment_efforts || [];
  const offset = work.effortIndex || 0;
  // Bound transaction size even for activities containing hundreds of efforts.
  const batch = efforts.slice(offset, offset + EFFORT_BATCH_SIZE);
  const valid = batch.filter((effort) => effort.segment?.id);
  return {
    checkpoint: {
      effortIndex: offset + batch.length,
      status: offset + batch.length >= efforts.length ? "complete" : "pending",
    },
    children: valid.map((effort) => workItem("segment", effort.segment.id)),
    save: (tx) => {
      for (const {segment, ...effort} of valid) {
        tx.set(db.doc(`users/${job.userId}/segmentEfforts/${effort.id}`),
          stravaData({...effort, segmentId: segment.id}));
      }
    },
  };
};

const syncSegment: WorkHandler = async ({work, request}) => {
  const ref = db.doc(`segments/${work.resourceId}`);
  const cached = await ref.get();
  if (cached.exists && cached.data()?.resource_state !== 2) return;
  const segment = await request<StravaSegment>(`/segments/${work.resourceId}`);
  const fetchedAt = new Date(Date.now());
  return {
    save: (tx) => tx.set(ref, {
      ...stravaData({...segment, resource_state: 3,
        xoms: normalizeXoms(segment.xoms)}),
      ...(cached.data()?.expiresAt ? {
        fetchedAt, expiresAt: new Date(fetchedAt.getTime() + DAY),
      } : {}),
    }),
  };
};

const syncStream: WorkHandler = async ({job, work, request}) => {
  const ref = db.doc(
    `users/${job.userId}/activities/${work.resourceId}` +
      `/powerCurve/${work.resourceId}`,
  );
  if ((await ref.get()).exists) return;
  let stream: Partial<ActivityStream> = {};
  try {
    stream = await request<Partial<ActivityStream>>(
      `/activities/${work.resourceId}/streams?keys=watts&key_by_type=true`,
    );
  } catch (error) {
    // Activities without power streams can return 404 or omit watts.
    if (!(error instanceof StravaRequestError) || error.status !== 404) {
      throw error;
    }
  }
  const powerCurve = calculatePowerCurve(stream.watts?.data || []);
  return {save: (tx) => tx.set(ref, {powerCurve})};
};

// Stored work kinds select their callbacks when a task runs.
const workHandlers: Record<SyncWork["kind"], WorkHandler> = {
  athlete: syncAthlete,
  page: syncActivityPage,
  activity: syncActivity,
  segment: syncSegment,
  stream: syncStream,
};

type SyncProgress = {
  status: SyncJob["status"];
  nextRunAt?: number;
  lastError?: string;
  attempts?: number;
};

const releaseJob = async (
  job: ClaimedJob, update: SyncProgress,
): Promise<void> => {
  const next = await db.runTransaction(async (tx) => {
    const ref = db.doc(`${JOBS}/${job.userId}`);
    const current = (await tx.get(ref)).data() as SyncJob | undefined;
    if (!ownsLease(current, job)) return;
    let progress = update;
    const finished =
      ["complete", "complete_with_errors"].includes(update.status);
    if (finished) {
      // An activity trigger may have added work since the worker's last query.
      const pending = await tx.get(
        workCollection(job).where("status", "==", "pending").limit(1),
      );
      if (!pending.empty) progress = {status: "pending", nextRunAt: Date.now()};
    }
    tx.update(ref, {
      ...progress,
      lastError: progress.lastError || null,
      attempts: progress.attempts || 0,
      nextRunAt: progress.nextRunAt ?? FieldValue.delete(),
      leaseOwner: FieldValue.delete(), leaseUntil: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return progress;
  });
  // Persist first: the recovery schedule repairs a failed enqueue or a crash.
  if (next?.nextRunAt !== undefined) {
    await enqueueSync(job.userId, job.runId, next.nextRunAt);
  }
};

export const processStravaSync = onTaskDispatched<{
  userId: string; runId: string;
}>(
  {
    region: REGION,
    secrets: [CLIENT_ID, CLIENT_SECRET],
    timeoutSeconds: 90,
    rateLimits: {maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1},
    retryConfig: {
      maxAttempts: 5, minBackoffSeconds: 30, maxBackoffSeconds: 300,
    },
  },
  async (req) => {
    const {userId, runId} = req.data;
    const invalidId = [userId, runId].some((id) =>
      typeof id !== "string" || !id || id.includes("/"));
    if (invalidId) {
      throw new HttpsError("invalid-argument", "Invalid sync task.");
    }
    const job = await claimJob(userId, runId);
    if (!job) return;
    let workId: string | undefined;
    try {
      const pending = await workCollection(job)
        .where("status", "==", "pending").limit(1).get();
      if (pending.empty) {
        return releaseJob(job, {
          status: job.failures ? "complete_with_errors" : "complete",
        });
      }
      workId = pending.docs[0].id;
      const work = pending.docs[0].data() as SyncWork;
      await processWork(job, workId, work, workHandlers[work.kind]);
    } catch (error) {
      if (error instanceof QuotaUnavailable) {
        return releaseJob(job, {
          status: "waiting", nextRunAt: error.resumeAt, attempts: job.attempts,
        });
      }
      const unauthorized =
        error instanceof StravaRequestError && error.status === 401;
      const needsAuth = error instanceof ConnectionRequired ||
        (unauthorized && job.attempts > 0);
      if (needsAuth) {
        return releaseJob(job, {
          status: "needs_auth", lastError: "Reconnect Strava to continue.",
        });
      }
      if (unauthorized) {
        await db.doc(`users/${userId}/stravaTokens/${userId}`)
          .update({expires_at: 0});
      } else if (error instanceof StravaRequestError && error.status >= 400 &&
        error.status < 500 && error.status !== 408 && workId) {
        await commitWork(job, workId, {
          checkpoint: {status: "failed", lastError: error.message},
        });
        return releaseJob(job, {status: "pending", nextRunAt: Date.now()});
      }
      const attempts = job.attempts + 1;
      const delay = Math.min(3600000, 30000 * 2 ** Math.min(attempts - 1, 7));
      console.error("Strava sync step failed", {
        userId, workId, attempts,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      return releaseJob(job, {
        status: "pending", nextRunAt: Date.now() + delay, attempts,
        lastError: "Temporary sync failure; retry scheduled.",
      });
    }
    await releaseJob(job, {status: "pending", nextRunAt: Date.now()});
  },
);

export const recoverStravaSyncs = onSchedule(
  {schedule: "every 5 minutes", region: REGION, timeoutSeconds: 120},
  async () => {
    // Finished jobs have no nextRunAt. This query uses a single-field index.
    const due = await db
      .collection(JOBS)
      .where("nextRunAt", "<=", Date.now())
      .limit(100)
      .get();
    for (const snapshot of due.docs) {
      const job = snapshot.data() as SyncJob;
      try {
        await enqueueSync(snapshot.id, job.runId, Date.now());
      } catch {
        console.error("Could not enqueue overdue Strava sync", {
          userId: snapshot.id,
        });
      }
    }
    // Gradually bootstrap users connected before this worker was deployed.
    const cursorRef = db.doc("stravaSyncControl/bootstrap");
    const cursor = (await cursorRef.get()).data()?.cursor as string | undefined;
    let query = db
      .collectionGroup("stravaTokens")
      .orderBy(FieldPath.documentId())
      .limit(100);
    if (cursor) query = query.startAfter(db.doc(cursor));
    const connections = await query.get();
    for (const connection of connections.docs) {
      const parts = connection.ref.path.split("/");
      if (parts.length !== 4 || parts[0] !== "users") continue;
      const userId = parts[1];
      if (!(await db.doc(`${JOBS}/${userId}`).get()).data()?.backfillStarted) {
        await startSync(
          userId,
          connection.data().connectionId || `legacy-${userId}`,
        );
      }
    }
    await cursorRef.set({
      cursor: connections.size === 100 ? connections.docs[99].ref.path : null,
    });
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
  if (typeof value === "number") {
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
  const parts = time.split(":").map(Number);
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (time.endsWith("s")) {
    return Number(time.slice(0, -1));
  } else if (parts.length === 1) {
    return Number(parts[0]);
  }

  throw new Error(`Invalid time format: ${time}`);
}

// The worker records activity details and stream work in one transaction.
// Keep this trigger for activities created by other writers.
export const onNewActivity = onDocumentCreated(
  {
    document: "users/{userId}/activities/{activityId}",
    region: REGION,
    retry: true,
  },
  async (event) => {
    if (!event.data || event.data.data().stravaSyncRun) return;
    await queueActivity(event.params.userId, Number(event.params.activityId));
  },
);

const queueActivity = async (
  userId: string, activityId: number,
): Promise<void> => {
  if (!Number.isSafeInteger(activityId) || activityId <= 0) return;
  const ref = db.doc(`${JOBS}/${userId}`);
  const job = await db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data() as SyncJob | undefined;
    const next: SyncJob = current || {
      runId: crypto.randomUUID(), connectionId: "", status: "pending",
      failures: 0, attempts: 0,
    };
    const child = workItem("activity", activityId);
    const work = workCollection({userId, runId: next.runId}).doc(child.id);
    if ((await tx.get(work)).exists) return next;
    tx.set(work, child.work);
    const paused = current?.status === "needs_auth";
    if (!current || (current.nextRunAt === undefined && !paused)) {
      next.status = "pending";
      next.nextRunAt = Date.now();
      tx.set(ref, next);
    } else {
      // Make a simultaneous completion transaction notice the new work.
      tx.update(ref, {updatedAt: FieldValue.serverTimestamp()});
    }
    return next;
  });
  if (job.nextRunAt !== undefined) {
    await enqueueSync(userId, job.runId, job.nextRunAt);
  }
};

export const onNewPowerCurve = onDocumentWritten(
  {
    document: "users/{userId}/activities/{activityId}/powerCurve/{activityId}",
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
            typeof currentPowerW === "number" &&
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

    if (Object.keys(bestPowerCurve).length === 0) return;

    return db.doc(`users/${userId}/performance/profile`).set(
      {
        powerCurve: bestPowerCurve,
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
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
    document: "segments/{segmentId}",
    region: REGION,
  },
  async (event) => {
    const segmentId = event.params.segmentId;
    const segmentRef = await db.doc(`segments/${segmentId}`).get();
    const segment = segmentRef.data() as Segment | undefined;
    // Explore summaries cannot support KOM scoring; wait for full details.
    if (!segment || segment.resource_state === 2 || !segment.xoms) return;

    const users = await db.collection("users").get();

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

      console.log("Processing segment", segmentId);

      const score = computeSegmentScore(
        segment,
        athleteRef.data() as AthleteProfile,
        powerCurveRef.data()?.powerCurve as ActivityPowerCurve,
      );

      console.log("Computed score", score);

      await db.doc(`users/${id}/segments/${segmentId}`).set({
        segment: segmentRef.ref,
        name: segment.name,
        score,
        ...(segmentRef.data()?.expiresAt ? {
          expiresAt: segmentRef.data()?.expiresAt,
        } : {}),
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
    label: "low" | "medium" | "high";
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
    "id" | "distance" | "average_grade" | "elevation_low" | "elevation_high"
  >,
  athlete: Pick<Athlete, "weight" | "ftp">,
  powerCurve: ActivityPowerCurve,
  options: SegmentTimePredictionOptions = {},
): SegmentTimePrediction {
  const distanceM = requirePositiveFinite(segment.distance, "segment.distance");
  // Strava grades are percentages: 5.7 means 5.7%, not 5.7.
  const gradeRatio =
    requireFinite(segment.average_grade, "segment.average_grade") / 100;

  if (!powerCurve || Object.keys(powerCurve).length === 0) {
    throw new Error("A powerCurve is required to predict segment time.");
  }

  const powerCurvePoints = normalizePowerCurve(powerCurve);

  const fallbackRiderWeightKg = requirePositiveFinite(
    options.fallbackRiderWeightKg ?? 70,
    "options.fallbackRiderWeightKg",
  );
  const hasMeasuredWeight =
    Number.isFinite(athlete.weight) && athlete.weight > 0;
  const riderWeightKg = hasMeasuredWeight ?
    athlete.weight :
    fallbackRiderWeightKg;

  const bikeAndEquipmentWeightKg = requirePositiveFinite(
    options.bikeAndEquipmentWeightKg ?? 10,
    "options.bikeAndEquipmentWeightKg",
  );
  const cda = requirePositiveFinite(options.cda ?? 0.32, "options.cda");
  const crr = requirePositiveFinite(options.crr ?? 0.004, "options.crr");
  const averageElevationM =
    Number.isFinite(segment.elevation_low) &&
    Number.isFinite(segment.elevation_high) ?
      (segment.elevation_low + segment.elevation_high) / 2 :
      0;
  const estimatedAirDensityKgM3 =
    1.225 * Math.exp(-Math.max(0, averageElevationM) / 8500);
  const rho = requirePositiveFinite(
    options.airDensityKgM3 ?? estimatedAirDensityKgM3,
    "options.airDensityKgM3",
  );
  const drivetrainEfficiency = requireInRange(
    options.drivetrainEfficiency ?? 0.975,
    0.5,
    1,
    "options.drivetrainEfficiency",
  );
  const realizationFactor = requireInRange(
    options.powerCurveRealizationFactor ??
      options.histogramRealizationFactor ??
      1,
    0.5,
    1,
    "options.powerCurveRealizationFactor",
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
    throw new Error("Could not find a physically feasible segment time.");
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
    "Power between benchmark durations is interpolated from the stored curve.",
    "Wind, corners, road surface, braking, and the detailed " +
      "elevation profile are unavailable.",
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
      "FTP is unavailable, so it could not be used as a plausibility check.",
    );
  }

  if (powerCurvePoints.length < DURATIONS.length) {
    confidenceScore -= 10;
    confidenceReasons.push(
      "The stored power curve is missing some benchmark durations.",
    );
  }

  if (timeSeconds < shortestCurveSeconds) {
    confidenceScore -= 10;
    confidenceReasons.push(
      "The predicted effort is shorter than the shortest power-curve point.",
    );
  }

  if (timeSeconds > longestCurveSeconds) {
    confidenceScore -= 20;
    confidenceReasons.push(
      "The predicted effort is longer than the longest power-curve point.",
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
        confidenceScore >= 75 ?
          "high" :
          confidenceScore >= 50 ?
            "medium" :
            "low",
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

    if (typeof powerW !== "number" || !Number.isFinite(powerW) || powerW <= 0) {
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
      "powerCurve must contain at least one positive finite power value.",
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
  const duration = requirePositiveFinite(durationSeconds, "durationSeconds");
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
