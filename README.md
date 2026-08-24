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
