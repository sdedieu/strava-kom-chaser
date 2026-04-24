import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { RuntimeConfigService } from '../../core/config/runtime-config.service';
import { StravaAuthService } from '../../core/strava/strava-auth.service';

@Component({
  selector: 'app-connect-cta',
  standalone: true,
  imports: [],
  templateUrl: './connect-cta.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
})
export class ConnectCtaComponent {
  private readonly auth = inject(StravaAuthService);
  private readonly runtime = inject(RuntimeConfigService);

  readonly canConnect = computed(() => !!this.runtime.config().clientId);

  connect(): void {
    this.auth.startLogin();
  }
}
