# Resumable Strava sync

A connection creates `stravaSyncJobs/{uid}` with work under
`stravaSyncJobs/{uid}/runs/{runId}/work`. Each task processes one small step:

1. Read the athlete or one activity page.
2. Save an activity and schedule its streams and segment efforts.
3. Save a bounded batch of efforts and schedule missing segments.
4. Fetch each missing segment or power stream.

`processWork` takes a named callback for the selected step. The callback returns
its data writes, child work and next checkpoint; a single transaction saves them
together. A callback returning nothing completes an already cached item.

The shared quota document tracks both Strava rate limits across all users,
including concurrent discovery requests. When quota runs out, the job waits
until the applicable reset plus five seconds. No invocation sleeps until then.
Deployments using the same Strava client ID must share this quota store.

Leases prevent duplicate workers from saving competing progress. The five-minute
recovery schedule resumes interrupted jobs and failed enqueues, and discovers
users connected before deployment. Reauthorization resumes unfinished work.
Completed jobs report `complete` or `complete_with_errors`; failed work items
retain the HTTP error. `needs_auth` means the athlete must reconnect Strava.

## Validate and deploy

From this directory, run `npm ci`, `npm run build`, `npm run lint`, and `npm test`.
Tests exercise the exported handlers with mocked Firestore, Cloud Tasks, Strava
responses and time. Production uses Node.js 24.

Enable Cloud Tasks, Cloud Scheduler and billing. Deploy `processStravaSync` first
to create its queue. Give enqueueing runtime service accounts
`roles/cloudtasks.enqueuer` and permission to act as the task identity
(`roles/iam.serviceAccountUser`); give the task identity `roles/run.invoker` on
the worker. Then deploy the remaining functions. Keep the existing
`STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` secrets.

New connections start automatically; existing users are picked up by recovery.
The authenticated `syncStravaData` callable starts another backfill or resumes
an unfinished one. Token refreshes alone do not start a backfill. This code does
not register or handle Strava webhooks.

References: [Firebase task functions](https://firebase.google.com/docs/functions/task-functions),
[Strava rate limits](https://developers.strava.com/docs/rate-limits/).
