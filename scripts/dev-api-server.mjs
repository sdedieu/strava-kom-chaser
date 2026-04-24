#!/usr/bin/env node
/**
 * Standalone Express server that serves the Strava OAuth proxy and the
 * `/api/config` endpoint during development.
 *
 * Angular's Vite-based dev-server (`@angular/build:dev-server`) does not
 * reliably execute the Express middleware in `src/server.ts`. Instead,
 * `ng serve` proxies `/api/*` calls to this process (see `proxy.conf.json`).
 *
 * In production, the exact same routes are mounted inside `src/server.ts`
 * on the SSR server, so the front-end code is unchanged.
 */

import 'dotenv/config';
import express from 'express';

const PORT = Number(process.env.API_PORT) || 4001;
const STRAVA_OAUTH_TOKEN_URL = 'https://www.strava.com/api/v3/oauth/token';

function readStravaEnv() {
  return {
    clientId: (process.env.STRAVA_CLIENT_ID ?? '').trim(),
    clientSecret: (process.env.STRAVA_CLIENT_SECRET ?? '').trim(),
    redirectUri:
      (process.env.STRAVA_REDIRECT_URI ?? '').trim() ||
      'http://localhost:4200/auth/callback',
  };
}

const app = express();
app.use(express.json());

app.get('/api/config', (_req, res) => {
  const env = readStravaEnv();
  const configured = !!env.clientId && !!env.clientSecret;
  res.json({
    clientId: env.clientId,
    redirectUri: env.redirectUri,
    useMock: !configured,
  });
});

app.post('/api/auth/strava/exchange', async (req, res) => {
  const env = readStravaEnv();
  if (!env.clientId || !env.clientSecret) {
    return res.status(503).json({ error: 'Strava credentials are not configured.' });
  }
  const code = typeof req.body?.code === 'string' ? req.body.code : '';
  if (!code) {
    return res.status(400).json({ error: 'Missing `code` in request body.' });
  }
  try {
    const stravaResponse = await fetch(STRAVA_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: env.clientId,
        client_secret: env.clientSecret,
        code,
        grant_type: 'authorization_code',
      }),
    });
    const payload = await stravaResponse.json();
    res.status(stravaResponse.status).json(payload);
  } catch (err) {
    res.status(502).json({
      error: 'Failed to reach Strava',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post('/api/auth/strava/refresh', async (req, res) => {
  const env = readStravaEnv();
  if (!env.clientId || !env.clientSecret) {
    return res.status(503).json({ error: 'Strava credentials are not configured.' });
  }
  const refreshToken =
    typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : '';
  if (!refreshToken) {
    return res.status(400).json({ error: 'Missing `refresh_token` in request body.' });
  }
  try {
    const stravaResponse = await fetch(STRAVA_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: env.clientId,
        client_secret: env.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const payload = await stravaResponse.json();
    res.status(stravaResponse.status).json(payload);
  } catch (err) {
    res.status(502).json({
      error: 'Failed to reach Strava',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

app.listen(PORT, () => {
  const env = readStravaEnv();
  const label = env.clientId && env.clientSecret ? 'configured' : 'mock mode (no credentials)';
  console.log(`[dev-api] Strava OAuth proxy listening on http://localhost:${PORT} · ${label}`);
});
