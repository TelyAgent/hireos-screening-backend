# HireOS Resume Screening Backend

NestJS + PostgreSQL + Prisma backend for the HireOS Resume Screening module.

## Current Status

Phase 0 through Phase 7 are implemented. The service now supports private
source-file storage, text extraction, candidate creation, duplicate review,
evidence-backed local profile parsing, durable parse-job status, versioned job
criteria, pre-link recommendations, human-controlled linking, and versioned
screening evaluations, ranking snapshots, comparison sets, human decisions,
delivery state, workspace settings, source connections and audit activity.

## Phase 0

Phase 0 establishes the runnable service boundary:

- NestJS application bootstrap;
- PostgreSQL/Prisma client and initial foundational schema;
- `/api/health`;
- workspace-scoped development identity;
- production fail-closed behavior until real authentication is connected;
- port `3002`, leaving the Interview backend on `3001`;
- durable `Material`, `ProcessingJob` and `AuditRecord` primitives.

The initial business modules are implemented below without changing the
production authentication boundary.

## Profile parsing and processing jobs

After a successful new-candidate import, the backend creates a `resume_parse`
`ProcessingJob`. A small worker claims queued jobs with a lease, extracts
contact/location/work-authorization/skills evidence from the stored material,
and creates a versioned `CandidateProfile` snapshot.

- `GET /api/candidates/:id/profile` returns the latest profile snapshot;
- `GET /api/processing-jobs/:id` returns queue state, attempts and result;
- `POST /api/processing-jobs/:id/retry` requeues a failed job;
- `CandidateProfile.sourceEntries` points each extracted value back to a
  material segment;
- the local parser is deliberately partial and does not claim AI verification;
- original files and extracted source text remain unchanged when a profile
  snapshot is created.

## Jobs, criteria and discovery

The Phase 2 slice exposes:

- `GET /api/jobs` and `POST /api/jobs`;
- `GET /api/jobs/:id`;
- `PATCH /api/jobs/:id/criteria`;
- `POST /api/jobs/:id/criteria/confirm`;
- `POST /api/jobs/:id/criteria/reopen`;
- `POST /api/candidates/:id/match`;
- `POST /api/jobs/:id/match`;
- `GET /api/candidates/:id` with persisted recommendations;
- `POST /api/recommendations/:id/dismiss`;
- `POST /api/recommendations/:id/defer`.

Criteria confirmation creates an immutable confirmed version. Reopening
creates a new draft version, so old evaluations remain tied to their original
criteria. Local discovery only creates `PreLinkMatchEvaluation` and
`CandidateJobRecommendation`; it never creates an `Application`. External AI
is not claimed until a configured adapter is added.

### JD/Core criteria integration

The existing Screening criteria endpoints remain the frontend contract, but
they can delegate authoritative role criteria to the JD and Core Record
services:

- `CORE_RECORD_MODE=remote` enables the remote criteria facade;
- `JD_BASE_URL` points to the JD backend, for example
  `http://127.0.0.1:3005/api`;
- edits update the current JD draft and its Core role definition version;
- confirmation marks the Core role version as confirmed;
- reopening creates a new draft role version;
- Screening keeps a local `JobCriteriaVersion` projection for compatibility
  with its matching and evaluation modules.

The frontend does not need to change. Set `CORE_RECORD_MODE=mock` to keep the
existing local-only behavior during isolated development.

### Reusable JD import

`POST /api/jobs/import` accepts:

```json
{
  "sourceFileName": "role.txt",
  "sourceText": "职位名称：..."
}
```

The import is idempotent for the same workspace and source text. It parses the
source into a draft role definition, creates the Core Job, creates the JD
draft, and keeps the original text in Screening for provenance. The same
method is used by the existing `POST /api/jobs` create flow when `jdText` is
provided.

For local sample data:

```sh
npm run jobs:import:samples
```

Imported roles intentionally remain `draft` until a human confirms the
criteria from the existing Job Criteria page. This preserves the JD contract:
source ingestion is not the same fact as approval or activation.

## Linking and human tasks

Phase 3 adds the human-controlled transition from a recommendation to a
formal recruiting relationship:

- `POST /api/recommendations/:id/confirm-link`;
- `GET /api/applications`;
- `GET /api/applications/:id`;
- `GET /api/tasks`;
- `GET /api/tasks?scope=mine`;
- `GET /api/tasks?scope=queue`;
- `POST /api/tasks/:id/claim`;
- `POST /api/tasks/:id/defer`;
- `POST /api/tasks/:id/complete`.

Confirming a current recommendation checks the open job, available candidate,
current profile version and current criteria version. It then atomically
creates or reuses the `(workspace, candidate, job, cycle)` Application,
records a `LinkDecision`, marks the recommendation confirmed, creates a
Screening Review task and writes an audit record. It does not run screening or
send a notification.

## Screening evaluation

Phase 4 adds formal screening after an `Application` exists:

- `GET /api/applications/:id/screening`;
- `GET /api/applications/:id/evaluations`;
- `POST /api/applications/:id/screen`;
- `POST /api/evaluations/:id/refresh`;
- `PATCH /api/evaluations/:id/human-assessments`;
- `POST /api/concerns/:id/resolve`;
- `POST /api/verification-items/:id/assign`;
- `POST /api/verification-items/:id/resolve`.

Each run creates a `ScreeningSession` and a new `ScreeningEvaluation` version.
Previous evaluations are marked stale rather than overwritten. The local
evaluator is intentionally explainable and non-AI: it stores dimension-level
reasons, source evidence, eligibility results, concerns and verification
items. Overall score remains `null` when weighted evidence coverage is below
70%. Human assessments are stored separately from dimension scores, preserving
the original evaluation for audit.

## Ranking, comparison and export

Phase 5 adds same-job comparison and snapshot-based ranking:

- `POST /api/comparisons`;
- `GET /api/comparisons/:id`;
- `POST /api/comparisons/:id/members`;
- `POST /api/comparisons/:id/refresh`;
- `POST /api/comparisons/:id/annotations`;
- `POST /api/comparisons/:id/exports`.

Comparison refresh validates the current evaluation baseline and assigns ranks
only to entries with a non-null overall score. Candidates with insufficient
evidence remain visible with `rank: null`. Every refresh creates a new
`ComparisonSnapshot` and `RankingSnapshot`; prior snapshots become stale but
remain queryable. Export currently creates a queued structured export job
with restricted evidence removed. PNG/PDF rendering is intentionally left
behind the renderer adapter and is not represented as completed until that
worker is connected.

## Decisions and delivery

Phase 6 adds the human-controlled decision and handoff boundary:

- `POST /api/applications/:id/decisions`;
- `POST /api/applications/:id/review-report`;
- `POST /api/applications/:id/decline-notice`;
- `POST /api/applications/:id/assessment/complete`;
- `GET /api/deliveries`;
- `GET /api/deliveries/:id`;
- `POST /api/deliveries/:id/send`;
- `POST /api/deliveries/:id/retry`;
- `POST /api/deliveries/:id/receipt`;
- `POST /api/deliveries/:id/download`.

Decisions are persisted separately from screening evaluations. An evaluation
can inform a decision, but it cannot create one automatically. Jobs can require
an assessment before `move_to_interview`; the local development path blocks
that transition until the application is marked completed, or records two
explicit exception approvals. Hold and reject outcomes can generate
review-only packages. Repeated decision requests are idempotent, while
delivery retries create a new attempt without re-running screening, linking or
invitation logic.

The current delivery adapter is local and structured: it persists package,
attempt, receipt and audit state, and exposes a restricted JSON download. Real
email, assessment, interview and PNG/PDF renderer providers still need
production adapters.

## Files, settings and audit

Phase 7 adds the shared settings boundary:

- `GET /api/materials`;
- `GET /api/connections`;
- `POST /api/connections/:id/read`;
- `POST /api/connections/:id/reconnect`;
- `POST /api/connections/:id/pause`;
- `GET /api/activity`;
- `GET /api/preferences`;
- `POST /api/preferences/proposals/:id/activate`;
- `POST /api/preferences/proposals/:id/reject`;
- `POST /api/preferences/versions/:id/rollback`;
- `GET /api/ai-models`.

Files are read from persisted `Material` records and never expose storage
paths. Connections are workspace-scoped records with masked account labels and
explicit authorization-required/paused/watching states. Preferences and AI
model policies are stored as versioned workspace settings; activating,
rejecting or rolling back a preference creates a new version and an audit
record. Activity is backed by the existing append-only `AuditRecord` table.

The current connection and AI model data are local structured adapters. They
provide realistic state transitions and policy visibility without claiming
real provider credentials, model calls, automatic price synchronization or
external mailbox/folder access.

## Resume file storage

Uploaded source files are stored on the backend host under the private
`STORAGE_DIR` directory, using a random storage key without the original file
extension. The default is `.local/materials`.

- the directory is created with mode `0700`;
- each stored file is written with mode `0600`;
- the original path is never returned by an API;
- the database stores the hash, metadata, extracted text, segments and random
  `storageKey`;
- the backend does not expose this directory as static web content;
- future downloads must go through an authenticated, workspace-scoped endpoint.

For production, replace the local directory with a private object-storage
adapter while keeping the same metadata and access boundary.

## Local setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env` and configure `DATABASE_URL`.

3. Generate the Prisma client and apply migrations:

   ```sh
   npm run prisma:generate
   npm run prisma:migrate:deploy
   ```

4. Start the service:

   ```sh
   npm run start:dev
   ```

For local development against the existing PostgreSQL instance, use:

```sh
DATABASE_URL='postgresql://hireos@127.0.0.1:55432/hireos_screening' npm run prisma:migrate:deploy
DATABASE_URL='postgresql://hireos@127.0.0.1:55432/hireos_screening' npm run start:dev
```

5. Check health:

   ```sh
   curl http://127.0.0.1:3002/api/health
   ```

The default database URL uses port `55433` so it does not collide with the Interview backend's local PostgreSQL instance on `55432`. PostgreSQL must be running separately.

## Validation

```sh
npm run build
npm run typecheck
npm run lint
npm test
```

`DEV_AUTH_ENABLED=true` is local-only. Production startup rejects the development identity until real authentication and workspace authorization are implemented.

## Frontend real API mode

The frontend keeps mock mode as the default for prototype smoke tests. To use
the Phase 1 backend for Import, Library, Candidate and Duplicate Review:

```sh
VITE_API_MODE=real npm run dev
```

The Vite proxy sends `/api` requests to `http://127.0.0.1:3002` by default.

## Core Record compatibility mode

Screening now has a `CoreRecordClient` boundary for master-record writes.
Development defaults to:

```env
CORE_RECORD_MODE=mock
CORE_RECORD_BASE_URL=http://127.0.0.1:3004/api/v1
CORE_RECORD_SERVICE_NAME=screening
```

Set `CORE_RECORD_MODE=remote` after the Core Record service is running. New
Candidate, Job and Application writes will create the master record first and
then create a local Screening shadow record with the same ID. Existing
Screening queries and evaluation data remain local during this compatibility
phase.
