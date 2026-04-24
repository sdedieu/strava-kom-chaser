import { BoundingBox } from '../models/strava.models';

/**
 * Bounding box covering the cycling playground around Grenoble:
 * Vercors, Chartreuse, Belledonne foothills and the Grésivaudan valley.
 */
export const GRENOBLE_BOUNDS: BoundingBox = {
  southWest: [45.05, 5.55],
  northEast: [45.35, 5.95],
};

export const GRENOBLE_CENTER: readonly [number, number] = [45.188529, 5.724523];

export const STRAVA_API_BASE_URL = 'https://www.strava.com/api/v3';
export const STRAVA_AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';

/** Scopes requested during the OAuth flow. */
export const STRAVA_OAUTH_SCOPES = ['read', 'profile:read_all', 'activity:read_all'];
