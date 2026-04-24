# Strava KOM Chaser · Grenoble

A small Angular 21 web app that lists the public **bike** Strava segments around
Grenoble where, according to your power curve, you have a realistic chance of
taking the KOM.

For each segment the app:

1. Fetches the current overall KOM time.
2. Estimates the **average power** required to match it, from a physics model
   that combines gravity, rolling resistance and aerodynamic drag.
3. Reads the matching duration from your **mean-maximal power curve**
   (rebuilt client-side from your recent activity streams).
4. Compares the two and tags the segment as `easy`, `realistic`, `stretch` or
   `out of reach`.

## Stack

- Angular 21 (standalone, signals-first, OnPush, new control flow)
- Tailwind CSS 4
- Angular SSR + Express (also hosts the Strava OAuth proxy)
- Vitest for unit tests

## Run it (zero-config, demo data)

```bash
npm install
npm start          # http://localhost:4200
```

The app boots straight into a working dashboard with a curated set of
Grenoble climbs and a sample athlete. The header shows a yellow
**Demo data** badge so you know you're not on real Strava data yet.

## Switch to real Strava data

You need a Strava developer app. It's free.

1. Create an app at <https://www.strava.com/settings/api>.
   - **Authorization Callback Domain** = `localhost`
   - Note the **Client ID** and **Client Secret**.
2. Drop your credentials in a local `.env`:

   ```bash
   cp .env.example .env
   # then edit .env:
   #   STRAVA_CLIENT_ID=12345
   #   STRAVA_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxx
   #   STRAVA_REDIRECT_URI=http://localhost:4200/auth/callback
   ```
3. Restart the dev server:

   ```bash
   npm start
   ```

`npm start` launches two processes in parallel:

- the **Angular dev-server** on http://localhost:4200, and
- a small **dev API server** on http://localhost:4001 that handles
  `/api/config` and the Strava OAuth token exchange (`scripts/dev-api-server.mjs`).

The Angular dev-server is configured (via `proxy.conf.json`) to forward
every `/api/*` request to :4001, so from the browser everything is still
same-origin on :4200. You don't need to start anything manually.

Once you land on http://localhost:4200, the app detects that credentials are
configured and redirects you straight to Strava's consent screen. After you
authorise, the app:

- exchanges the OAuth `code` server-side (the `client_secret` never reaches
  the browser),
- stores the access + refresh tokens in `localStorage`,
- refreshes them transparently 5 minutes before they expire,
- pulls your athlete profile, recent rides, watts streams, and the live
  segments around Grenoble,
- rebuilds your mean-maximal power curve from those streams.

The header badge turns green and reads **Live Strava**. A small caption under
the power curve also tells you whether it was rebuilt from real streams or
estimated from your FTP (fallback when no powered ride is found).

> The `client_secret` is only ever read by the Express server (`src/server.ts`)
> via two endpoints: `POST /api/auth/strava/exchange` and `POST /api/auth/strava/refresh`.
> Both are also used for the production server bundle, so the same flow works
> behind `npm run serve:ssr:strava-kom-chaser`.

## Architecture

```
src/
├── server.ts                          Express SSR + OAuth proxy + /api/config (prod)
├── ../scripts/
│   └── dev-api-server.mjs             Standalone OAuth proxy on :4001 (dev only)
├── ../proxy.conf.json                 Forwards /api/* from :4200 to :4001 during ng serve
└── app/
    ├── core/
    │   ├── config/
    │   │   ├── grenoble.config.ts     Grenoble bbox + Strava endpoints
    │   │   └── runtime-config.service.ts   loads /api/config on bootstrap
    │   ├── models/strava.models.ts    Athlete, Segment, PowerCurve, KomAnalysis
    │   ├── strava/
    │   │   ├── strava-auth.service.ts       OAuth lifecycle (login / refresh / logout)
    │   │   ├── strava-token.interceptor.ts  injects Bearer token on Strava calls
    │   │   ├── strava.service.ts            REST wrapper (real or mock)
    │   │   ├── power-curve-builder.ts       mean-max + FTP fallback
    │   │   └── mock-data.ts                 fixtures used when no credentials
    │   └── kom/
    │       ├── power-estimator.ts     physics: P = f(distance, grade, time, mass)
    │       └── kom-chaser.service.ts  signal store: athlete + curve + segments
    ├── features/
    │   ├── auth/
    │   │   ├── connect-cta.component.*       login button shown when logged out
    │   │   └── auth-callback.component.ts    /auth/callback: code → tokens
    │   ├── profile/profile-summary.component.*
    │   └── segments/
    │       ├── segments-page.component.*     layout + filters + status switch
    │       └── segment-card.component.*      per-segment KOM analysis
    └── shared/format.ts               duration / distance / watts formatting
```

The KOM analysis service exposes everything as Angular **signals**, so the UI
re-renders automatically whenever the athlete, the power curve, or the segment
list changes.

## How the power curve is rebuilt

Strava does not expose a `power-curve` endpoint. The app rebuilds yours
client-side:

1. `GET /athlete/activities?per_page=30` (last 30 rides).
2. Keep only rides with real power (`device_watts === true` or `average_watts > 0`),
   take the 12 most recent.
3. For each, `GET /activities/{id}/streams?keys=watts` to pull the watts
   stream.
4. Compute the mean-max power for each target duration (5 s, 15 s, 30 s,
   1 min, 2 min, 5 min, 10 min, 20 min, 30 min, 1 h, 1 h 30) using a rolling
   sum (`O(n)` per duration).
5. Take the maximum across all activities for each duration.

If no powered ride is found, the curve is **estimated from your FTP** using
Coggan-style fractions, and the panel labels itself as such.

## Power model

The required-power estimate uses the classic cycling power equation:

```
P = (1 / η) · ( m·g·v·sin θ + m·g·Crr·cos θ·v + ½·ρ·CdA·v³ )
```

Defaults (tunable in `core/kom/power-estimator.ts`):

| Parameter | Value |
|-----------|-------|
| Bike mass | 8.5 kg |
| Drivetrain efficiency | 0.97 |
| Rolling resistance (`Crr`) | 0.005 |
| Drag area (`CdA`) | 0.32 m² |
| Air density (`ρ`) | 1.225 kg/m³ |

The athlete's expected power for the KOM duration is **linearly interpolated**
from their power curve points (no extrapolation past the curve range).
