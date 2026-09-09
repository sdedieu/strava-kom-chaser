# KOM Hunter — Angular + Firebase + Strava

Starter project for discovering Strava cycling segments and ranking likely KOM opportunities.

## Stack
- Angular standalone
- Firebase Auth / Firestore / Cloud Functions / Hosting
- Strava OAuth on Cloud Functions
- Server-side Strava tokens
- Segment Explore + athlete activity/segment-effort discovery
- Initial similarity-based performance model

## Important Strava constraint
Strava's Segment Explore access is subject to its current developer access policy. Keep discovery behind the `discoverKOMOpportunities` function so it can be replaced by another candidate-source later.

## Setup

1. `npm install`
2. `cd functions && npm install && cd ..`
3. Create a Firebase project and enable Anonymous Authentication, Firestore, Functions and Hosting.
4. Create a Strava API application.
5. Copy `src/environments/environment.example.ts` to `src/environments/environment.ts` and fill in Firebase config + deployed function URL.
6. Set Cloud Function secrets:

```bash
firebase functions:secrets:set STRAVA_CLIENT_ID
firebase functions:secrets:set STRAVA_CLIENT_SECRET
```

7. Deploy:
```bash
npm run build
firebase deploy
```

## OAuth
The callback URL is:
`https://<region>-<project-id>.cloudfunctions.net/stravaOAuthCallback`

The callback redirects to your configured Angular hosting URL. Change `APP_URL` in `functions/src/index.ts` before deploying.

## MVP model
The first implementation uses historical segment efforts with similar distance/grade as nearest neighbours. It predicts a time and compares it to the current KOM.

Replace `predictTime()` later with the stronger model described in the product plan:
- power-duration curve
- rider/bike mass
- CdA / rolling resistance
- elevation profile
- gradient distribution
- acceleration/cornering penalty
- uncertainty / probability of beating KOM

## Local segment discovery cache

Call the authenticated `discoverSegments` Cloud Function with
`{ bounds: [south, west, north, east], activity_type: 'riding' }` (or `'running'`).
It subdivides saturated tiles and saves summaries in the global
`segments/<segmentId>` collection with a 24-hour expiry. Progress is shared at
`segmentDiscoveryJobs/<queryId>`, so another caller can resume the same query.
The authenticated user only supplies the Strava token; discovered segments and
jobs do not belong to that user.
Explore requires Strava Extended Access permission and cannot guarantee exhaustive coverage.

Each call makes up to 20 Explore requests within a bounded execution time, using
the same application quota tracking as activity sync. If `status` is `paused`,
call again with the same parameters at or after `retryAt` (Unix milliseconds).
Continuation requires another call; no background discovery worker is started.
Completed queries are reused for 24 hours. `saturated` counts tiles still returning
ten results at the subdivision limit. Configure the client callable timeout to 120 seconds.

Enable the `segments.expiresAt` TTL policy from `firestore.indexes.json`
before use, or run:

```bash
gcloud firestore fields ttls update expiresAt --collection-group=segments --enable-ttl --project=YOUR_PROJECT_ID
```

TTL deletion is asynchronous; only serve documents with `expiresAt` in the future.
Explore summaries have `resource_state: 2` and never replace existing full
details. The scoring trigger skips summaries; activity sync upgrades them to
full details (`resource_state: 3`) when needed, retaining temporary expiry.
Derived user scores inherit that expiry; the `segments` collection-group TTL
also covers those `users/<uid>/segments` documents. Existing browser access
rules remain unchanged.
