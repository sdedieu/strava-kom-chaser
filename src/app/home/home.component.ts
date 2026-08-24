import {
  Component,
  inject,
  OnInit,
  ChangeDetectionStrategy,
  effect,
  computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { AppInitService } from '../core/app-init.service';
import { StravaService } from '../core/strava.service';
import { Opportunity } from '../models';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-root',
  imports: [CommonModule],
  template: `
    <main class="mx-auto min-h-screen max-w-[1100px] px-6 py-14">
      <header
        class="mb-[38px] flex items-end justify-between gap-[30px] max-[800px]:flex-col max-[800px]:items-start"
      >
        <div>
          <span class="text-xs font-black tracking-[0.15em]">KOM HUNTER</span>
          <h1
            class="mb-3 mt-2 text-[clamp(40px,7vw,72px)] font-extrabold leading-[0.95] tracking-[-0.055em]"
          >
            Find the KOMs you can take.
          </h1>
          <p class="max-w-[720px] text-[17px] text-[#667085]">
            Discover segments, learn your historical performance and rank the
            opportunities where your predicted time beats the current KOM.
          </p>
        </div>
        @if (connected()) {
          <span class="font-extrabold first-letter:text-green-500"
            >● {{ athlete() }}</span
          >
        }
      </header>

      <section class="mb-10">
        @if (connected() && segments().length > 0) {
          <div class="mb-6 flex flex-col justify-between">
            <h2 class="text-lg font-bold">Best opportunities</h2>
            <table>
              <caption class="mb-2 caption-bottom text-sm text-[#667085]">
                Best opportunities are ranked by the difference between your
                predicted time and the current KOM time. A negative difference
                means you are faster than the KOM, while a positive difference
                means you are slower.
              </caption>
              <thead>
                <tr>
                  <th class="text-left border-b p-4" scope="col">
                    Segment name
                  </th>
                  <th class="text-left border-b p-4" scope="col">
                    Estimated power
                  </th>
                  <th class="text-left border-b p-4" scope="col">
                    Estimated Time Diff
                  </th>
                  <th class="text-left border-b p-4" scope="col">
                    Strava link
                  </th>
                </tr>
              </thead>
              <tbody>
                @for (segment of segments(); track segment.id) {
                  <tr>
                    <th class="text-left border-b p-4" scope="row">
                      {{ segment.name }}
                    </th>
                    <td class="border-b p-4">
                      {{ segment.score.estimatedPowerNeeded }}
                    </td>
                    <td class="border-b p-4">
                      {{ segment.score.estimatedTimeDiff | number: '1.0-0' }}s
                    </td>
                    <td class="border-b p-4">
                      <a [href]="segment.stravaLink" target="_blank"
                        >View on Strava</a
                      >
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    </main>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class HomeComponent implements OnInit {
  private init = inject(AppInitService);
  private strava = inject(StravaService);

  busy = false;
  message = '';
  rows: Opportunity[] = [];

  connected = computed(() => Boolean(this.strava.stravaToken()));
  athlete = computed(
    () =>
      `${this.strava.athelete()?.firstname} ${this.strava.athelete()?.lastname}`,
  );

  segments = this.strava.sortedAthleteSegments;

  auth = effect(() => {
    const token = this.strava.stravaToken();
    console.log('token', token);
    if (token === null) return;
    if (token === undefined) {
      return firstValueFrom(this.strava.startOAuth()).then(
        (url) => (location.href = url),
      );
    }
    if (token.expires_at * 1000 < Date.now()) return this.strava.refreshToken();
  });

  async ngOnInit() {
    await this.init.init();
  }

  async connectToStrava() {
    const url = await firstValueFrom(this.strava.startOAuth());
    location.href = url;
  }

  sync() {
    this.strava.normalizeExistingSegmentsXoms();
  }

  discover() {
    this.busy = true;
    this.message = 'Discovering and scoring segments…';
    // Example geographic box. Replace with map-drawn bounds.
    this.strava.discover([41.34, 2.0, 41.48, 2.25]).subscribe({
      next: (r) => {
        this.rows = r;
        this.message = `Found ${r.length} candidate segments.`;
        this.busy = false;
      },
      error: (e) => {
        this.message = e.message || 'Discovery failed.';
        this.busy = false;
      },
    });
  }

  fmt(sec: number) {
    sec = Math.max(0, Math.round(sec));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }
}
