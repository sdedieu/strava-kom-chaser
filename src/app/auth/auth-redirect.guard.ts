import { ActivatedRouteSnapshot, CanActivateFn, Router } from '@angular/router';

import { inject } from '@angular/core';
import { catchError, from, map, Observable, of, switchMap } from 'rxjs';
import { StravaService } from '../core/strava.service';
import {
  Auth,
  signInAnonymously,
  User,
  user,
  UserCredential,
} from '@angular/fire/auth';

export function authenticationRedirectGuard(): CanActivateFn {
  return (route: ActivatedRouteSnapshot) => {
    const stravaService: StravaService = inject(StravaService);
    const router: Router = inject(Router);
    const auth = inject(Auth);

    const user$: Observable<User | null | UserCredential> = auth.currentUser
      ? user(auth)
      : from(signInAnonymously(auth));

    return user$.pipe(
      switchMap(() =>
        stravaService.authCallback(route.queryParams['code']).pipe(
          map((res) => {
            console.log('authCallback result', res);
            return router.createUrlTree(['/']);
          }),
          catchError((err) => {
            console.error(err);
            throw err;
          }),
        ),
      ),
    );
  };
}
