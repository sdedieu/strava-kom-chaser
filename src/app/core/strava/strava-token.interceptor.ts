import { HttpEvent, HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { Observable, switchMap } from 'rxjs';

import { STRAVA_API_BASE_URL } from '../config/grenoble.config';
import { StravaAuthService } from './strava-auth.service';

/**
 * Functional HTTP interceptor that:
 *  - leaves all non-Strava requests untouched,
 *  - asks {@link StravaAuthService} for a fresh access token (refreshing
 *    transparently when needed),
 *  - injects `Authorization: Bearer <token>` on every Strava API call.
 */
export function stravaTokenInterceptor(
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> {
  if (!req.url.startsWith(STRAVA_API_BASE_URL)) {
    return next(req);
  }

  const auth = inject(StravaAuthService);
  return auth.getValidAccessToken().pipe(
    switchMap((token) => {
      if (!token) return next(req);
      const authedReq = req.clone({
        setHeaders: { Authorization: `Bearer ${token}` },
      });
      return next(authedReq);
    }),
  );
}
