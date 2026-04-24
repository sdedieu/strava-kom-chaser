import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import 'dotenv/config';
import express from 'express';
import { join } from 'node:path';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

app.use(express.json());

const STRAVA_OAUTH_TOKEN_URL = 'https://www.strava.com/api/v3/oauth/token';

interface StravaConfigEnv {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

function readStravaEnv(): StravaConfigEnv {
  return {
    clientId: process.env['STRAVA_CLIENT_ID']?.trim() ?? '',
    clientSecret: process.env['STRAVA_CLIENT_SECRET']?.trim() ?? '',
    redirectUri:
      process.env['STRAVA_REDIRECT_URI']?.trim() ||
      'http://localhost:4200/auth/callback',
  };
}

/**
 * Public runtime configuration consumed by the Angular app on bootstrap.
 * Only safe-to-expose fields are returned; the client_secret never leaves
 * the server.
 */
app.get('/api/config', (_req, res) => {
  const env = readStravaEnv();
  const configured = !!env.clientId && !!env.clientSecret;
  res.json({
    clientId: env.clientId,
    redirectUri: env.redirectUri,
    useMock: !configured,
  });
});

/**
 * Exchange a one-shot authorization `code` (from /auth/callback) for an
 * access + refresh token pair. Strava requires the client_secret here,
 * which is why this endpoint exists rather than calling Strava directly
 * from the browser.
 */
app.post('/api/auth/strava/exchange', async (req, res) => {
  const env = readStravaEnv();
  if (!env.clientId || !env.clientSecret) {
    res.status(503).json({ error: 'Strava credentials are not configured.' });
    return;
  }

  const code = typeof req.body?.code === 'string' ? req.body.code : '';
  if (!code) {
    res.status(400).json({ error: 'Missing `code` in request body.' });
    return;
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

/**
 * Trade an existing refresh_token for a fresh access_token.
 * Called transparently by the front-end whenever the access token
 * is about to expire.
 */
app.post('/api/auth/strava/refresh', async (req, res) => {
  const env = readStravaEnv();
  if (!env.clientId || !env.clientSecret) {
    res.status(503).json({ error: 'Strava credentials are not configured.' });
    return;
  }

  const refreshToken =
    typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : '';
  if (!refreshToken) {
    res.status(400).json({ error: 'Missing `refresh_token` in request body.' });
    return;
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

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }
    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI during SSR (production build).
 * Note: in dev (`ng serve`), `/api/*` calls are proxied to
 * `scripts/dev-api-server.mjs` on port 4001 instead — see
 * `proxy.conf.json`. The routes above are only hit in production.
 */
export const reqHandler = createNodeRequestHandler(app);
export default reqHandler;

