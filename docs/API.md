# Flackyness API Documentation

Base URL: `http://localhost:8080` (development) or your production URL

## Authentication

All write endpoints require Bearer token authentication:

```http
Authorization: Bearer your-project-token
```

**Read endpoints** (`GET /api/v1/projects/*`, `GET /api/v1/tests/*`) are open
by default. If the server sets `READ_TOKEN`, they require a Bearer token that
is **either**:

| Token | Scope |
|---|---|
| `READ_TOKEN` | every project on the instance |
| a project token | that project only |

`GET /api/v1/projects` and `GET /api/v1/tests/flaky/:id` accept `READ_TOKEN`
only — they are not scoped to a single project.

A project token presented for a *different* project gets `401`, so a project
token can never read another project's data.

Tokens are generated per-project and should be stored securely (e.g., GitLab CI/CD variables).

---

## Endpoints

### Health Check

```http
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-12-11T12:00:00.000Z"
}
```

---

### API Info

```http
GET /api/v1
```

**Response:**
```json
{
  "name": "Flackyness API",
  "version": "0.0.1"
}
```

---

### Projects

#### List Projects

```http
GET /api/v1/projects
```

**Response:**
```json
{
  "projects": [
    {
      "id": "uuid",
      "name": "my-project",
      "createdAt": "2024-12-01T00:00:00.000Z"
    }
  ]
}
```

#### Get Project Stats

```http
GET /api/v1/projects/:id/stats
```

**Response:**
```json
{
  "project": {
    "id": "uuid",
    "name": "my-project"
  },
  "activeFlakyTests": 5,
  "resolvedThisWeek": 2,
  "totalRuns": 150,
  "totalTests": 250
}
```

#### Get Project Flaky Tests

```http
GET /api/v1/projects/:id/flaky-tests?status=active&limit=50
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | `active` | Filter by status: `active`, `resolved`, `ignored`, or `all` |
| `limit` | number | `50` | Number of flaky tests to return, clamped to `[1, 100]` |

**Response:**
```json
{
  "flakyTests": [
    {
      "id": "uuid",
      "testName": "user login should work",
      "testFile": "tests/auth.spec.ts",
      "firstDetected": "2024-12-01T00:00:00.000Z",
      "lastSeen": "2024-12-11T00:00:00.000Z",
      "flakeCount": 15,
      "totalRuns": 50,
      "flakeRate": "0.30",
      "status": "active"
    }
  ]
}
```

#### Get Quarantine List (CI-consumable)

```http
GET /api/v1/projects/:id/quarantine
GET /api/v1/projects/:id/quarantine?format=playwright
```

A machine-readable view of the project's flaky-test rows, shaped for a CI
job to act on directly. It splits rows into two sets that must never be
conflated:

- **`muted`** — `status = 'ignored'`. An operator explicitly muted the test
  via [Mute / Unmute a Flaky Test](#mute--unmute-a-flaky-test). Human
  judgment. **Safe to skip.**
- **`flaky`** — `status = 'active'`. Auto-detected by the current threshold.
  Machine judgment only. **Advisory** — retry or annotate it, but Flackyness
  deliberately does **not** offer a way to skip it automatically. Silently
  skipping a test nobody has signed off on could hide a real regression.

`grepInvert` is a ready-to-use Playwright `--grep-invert` regex built from
**`muted` tests only** — it never includes `flaky` (auto-detected) tests.
It is `""` (empty string) when there are no muted tests — not `null`, and
not a regex that matches everything. **Always check for an empty string
before passing it to `--grep-invert`**: passing an empty pattern runs zero
tests instead of the full suite, which is worse than not filtering at all.

There is no pagination limit — a CI consumer needs the *complete* quarantine
set, or the skip list is wrong. A hard safety cap of 1000 rows applies;
`truncated: true` signals the cap was hit (a project with over 1000
quarantined tests has a bigger problem than pagination).

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `format` | string | (unset) | `playwright` returns the bare `grepInvert` pattern as `text/plain`, so a CI job can do `curl … > skip.txt` without `jq`. Omit for the JSON shape below. |

**Response (JSON, default):**
```json
{
  "projectId": "uuid",
  "muted": [
    { "testName": "flaky login test", "testFile": "tests/auth.spec.ts", "flakeRate": "0.4200", "lastSeen": "2024-12-11T00:00:00.000Z" }
  ],
  "flaky": [
    { "testName": "checkout retries under load", "testFile": "tests/checkout.spec.ts", "flakeRate": "0.1100", "lastSeen": "2024-12-11T00:00:00.000Z" }
  ],
  "grepInvert": "^(?:flaky\\ login\\ test)$",
  "truncated": false
}
```

**Response (`?format=playwright`):** `text/plain; charset=utf-8`, body is
just the `grepInvert` string (may be empty).

An unknown-but-well-formed project id returns `200` with empty arrays and
`grepInvert === ""` (an empty quarantine list is a valid answer, not a
`404`). A malformed id returns `400`.

**Example — skip only operator-muted tests in CI:**
```bash
SKIP=$(curl -s "$FLACKYNESS_URL/api/v1/projects/$PROJECT_ID/quarantine?format=playwright")
if [ -n "$SKIP" ]; then
  npx playwright test --grep-invert "$SKIP"
else
  npx playwright test
fi
```
The `-n` guard is not decoration — it is what stops an empty pattern from
being passed to `--grep-invert`, which would otherwise skip the entire suite.

#### Get Project Test Runs

```http
GET /api/v1/projects/:id/runs?limit=20
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | `20` | Number of runs to return |

**Response:**
```json
{
  "runs": [
    {
      "id": "uuid",
      "branch": "main",
      "commitSha": "abc123def456",
      "pipelineId": "12345",
      "startedAt": "2024-12-11T12:00:00.000Z",
      "finishedAt": "2024-12-11T12:05:00.000Z",
      "totalTests": 100,
      "passed": 95,
      "failed": 3,
      "skipped": 1,
      "flaky": 1,
      "createdAt": "2024-12-11T12:00:00.000Z"
    }
  ]
}
```

#### Get Run Detail (per-run results)

```http
GET /api/v1/projects/:id/runs/:runId
GET /api/v1/projects/:id/runs/:runId?status=all
```

Returns one run's summary plus its individual test results. The run lookup
is scoped by **both** `:id` and `:runId` (`WHERE test_runs.id = :runId AND
test_runs.project_id = :id`) — a well-formed `runId` that belongs to a
*different* project returns `404`, not that project's data.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | `failed`+`flaky` | `all` returns every result; `failed`, `flaky`, `passed`, or `skipped` returns only that one status; omitted (or unparseable) defaults to `failed`+`flaky` results only — the default view is "what needs attention", not the full suite. |

Results are ordered `failed`, then `flaky`, then `skipped`, then `passed`;
within a status, alphabetically by `testName`. Capped at 2000 rows —
the default scope will essentially never hit this, but `?status=all` on a
large suite could otherwise return an unbounded payload; `truncated: true`
signals the cap was hit (same semantics as the quarantine endpoint's flag).
The ordering is applied before the cap, so a truncated response drops
`passed` rows first and never hides a `failed` or `flaky` result.

**Response:**
```json
{
  "run": {
    "id": "uuid",
    "branch": "main",
    "commitSha": "abc123def456",
    "pipelineId": "12345",
    "startedAt": "2024-12-11T12:00:00.000Z",
    "finishedAt": "2024-12-11T12:05:00.000Z",
    "createdAt": "2024-12-11T12:00:00.000Z",
    "totalTests": 100,
    "passed": 95,
    "failed": 3,
    "skipped": 1,
    "flaky": 1
  },
  "results": [
    {
      "testName": "checkout should redirect after payment",
      "testFile": "tests/checkout.spec.ts",
      "status": "failed",
      "durationMs": 4200,
      "retryCount": 1,
      "errorMessage": "Expected redirect to /success, got /checkout",
      "tags": [],
      "annotations": [],
      "failureDetail": {
        "errors": [
          {
            "message": "Expected redirect to /success, got /checkout",
            "stack": "Error: Expected redirect to /success, got /checkout\n    at /app/tests/checkout.spec.ts:42:11",
            "snippet": "  40 |   await page.click('#pay');\n  41 |   await expect(page).toHaveURL('/success');\n> 42 |   // failed here"
          }
        ],
        "stdout": "Starting checkout flow...\n",
        "attachments": [
          { "name": "screenshot", "contentType": "image/png", "path": "test-results/checkout-failed/screenshot.png" }
        ]
      }
    }
  ],
  "truncated": false
}
```

**Note:** `errorMessage` is only the first error's message text, truncated
to 10,000 characters. `failureDetail` carries richer detail for the same
result: every distinct error's message/stack/snippet (up to 10), stdout and
stderr (each flattened and capped at 10,000 characters), and attachment
**metadata only** — `{ name, contentType, path }`. The attachment *files*
themselves (screenshots, videos, traces) are never stored by Flackyness —
only their name/type/path are recorded for cross-referencing the CI job's
own artifacts. `failureDetail` is `null` for passing results and for any
result ingested before this field existed.

A malformed `:id` or `:runId` returns `400`. A well-formed `:runId` that
doesn't exist, or belongs to a different project than `:id`, returns `404`.

#### Get Real-Time Flakiness Analysis

```http
GET /api/v1/projects/:id/analysis?days=14&threshold=0.05
```

Computes flakiness directly from stored test results (not cached). Responds
`404` if the project doesn't exist.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `days` | number | project's `windowDays` override, else `14` | Analysis window in days, clamped to `[1, 90]` |
| `threshold` | number | project's `flakeThreshold` override, else `0.05` | Flake-rate threshold (0–1) above which a test is considered flaky, clamped to `[0, 1]` |

An explicit `days` or `threshold` query param always overrides the project's
stored config (see [Update Project Flakiness Config](#update-project-flakiness-config)).
`minRuns` is not query-overridable here; it always comes from the project's
resolved config (default `3`).

**Response:**
```json
{
  "windowDays": 14,
  "threshold": 0.05,
  "flakyTests": [
    {
      "testName": "user login should work",
      "testFile": "tests/auth.spec.ts",
      "totalRuns": 20,
      "passCount": 15,
      "failCount": 2,
      "flakyCount": 3,
      "flakeRate": 0.15,
      "isFlaky": true,
      "lastSeen": "2024-12-11T12:00:00.000Z"
    }
  ],
  "allTests": [
    {
      "testName": "user login should work",
      "testFile": "tests/auth.spec.ts",
      "totalRuns": 20,
      "passCount": 15,
      "failCount": 2,
      "flakyCount": 3,
      "flakeRate": 0.15,
      "isFlaky": true,
      "lastSeen": "2024-12-11T12:00:00.000Z"
    }
  ]
}
```

#### Get Flake Rate Trend

```http
GET /api/v1/projects/:id/trend?days=7
```

Daily flake rate aggregation for the requested window.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `days` | number | `7` | Trend window in days, clamped to `[1, 90]` |

**Response:**
```json
{
  "days": ["Jul 4", "Jul 5", "Jul 6", "Jul 7", "Jul 8", "Jul 9", "Jul 10"],
  "rates": [1.2, null, 2.5, 1.8, 0.0, 3.1, 1.2]
}
```

`rates` are flake percentages (0–100) per day, computed as `(flaky + failed) / total * 100`.

**`rates[i]` is `null` — not `0` — for a day with zero runs.** "CI never ran
that day" and "CI ran and nothing flaked" are different facts; collapsing
them into `0` draws a confident flat line through a hole in the data (a
weekend, an outage, a paused pipeline) — precisely the case where this
endpoint actually knows nothing. A day with at least one run always reports
a plain number, including a genuine `0.0`. This mirrors the identical
`flakeRate: null` rule on [Get Per-Test Flake-Rate Trend](#get-per-test-flake-rate-trend);
a consumer (chart, alert) must not treat `null` as "healthy" and should
render it as a gap, not a zero.

The `days` query parameter is clamped to `[1, 90]`; an unparseable value
(e.g. `days=abc`) falls back to the default of `7` rather than producing an
empty series.

---

### Reports

#### Upload a Test Report (Playwright JSON or JUnit XML)

```http
POST /api/v1/reports?branch=main&commit=abc123&pipeline=12345
```

The target project is identified by the Bearer token — there is no `project` parameter.

**Headers:**
```http
Authorization: Bearer your-project-token
Content-Type: application/json
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `branch` | string | No | Git branch name; defaults to `main`; max 255 chars |
| `commit` | string | Yes | Git commit SHA, max 40 chars |
| `pipeline` | string | No | CI pipeline ID; max 100 chars |
| `wait` | string | No | Set to exactly `true` to await flakiness reconciliation before responding — see [Synchronous ingest (`?wait=true`)](#synchronous-ingest-wait-true) below. Any other value (absent, `1`, `yes`) takes the default async behavior. |

**Body:** Raw Playwright JSON report (from `--reporter=json`), or a JUnit XML report.

##### Format detection

The format is detected from the **body content**, not `Content-Type` — CI
uploaders frequently send an inaccurate or generic content type. The body is
read once and dispatched by shape to the first recognized report format:
**JUnit XML** (the body starts with `<`) or **Playwright JSON** (a JSON
object with a top-level `suites` key). `Content-Type: application/json` or
`application/xml` are both accepted (or any other value) — send whichever
your CI tool defaults to.

A body matching a recognized format that fails to parse returns
`400 { "error": "Failed to parse <format> report: <details>" }` (`<format>`
is `JUnit` or `Playwright`). A body matching neither recognized format
returns `400 { "error": "Unrecognized report format" }`.

##### JUnit XML support

JUnit XML is the common output format for jest-junit, pytest, Go, Maven
Surefire, Cypress, and most other test runners. Both a `<testsuites>` root
(possibly wrapping multiple, possibly nested `<testsuite>` elements) and a
bare single `<testsuite>` root (pytest's default) are accepted.

Per `<testcase>`, status is derived structurally:

| Testcase contains | Status |
|--------------------|--------|
| a `<failure>` or `<error>` child | `failed` |
| a `<skipped>` child (and no `<failure>`/`<error>`) | `skipped` |
| none of the above | `passed` |

**JUnit reports never produce a `flaky` status and `retryCount` is always
`0`** — the JUnit format has no retry semantics (a rerun that an emitter
encodes as a duplicate `<testcase>` is not something Flackyness infers
within a single report). Flakiness for JUnit-sourced tests instead emerges
the same way it already does for everything else: from the flake-rate
`(failed + flaky) / total` computed **across multiple report uploads** for
the same test name (see [Get Real-Time Flakiness Analysis](#get-real-time-flakiness-analysis)).
A test that fails in 1 of 3 JUnit uploads is flagged flaky by that rate,
even though each individual upload only ever reports it as plainly `passed`
or `failed`.

Field mapping: `testName` is `classname › name` (or just `name` when
`classname` is empty/absent); `testFile` prefers the testcase's own `file`
attribute, then falls back to the containing `<testsuite>`'s `file`
attribute, then `classname`, then `''`. `durationMs` comes from the `time`
attribute (seconds → milliseconds), defaulting to `0` when absent. The same
name/file (500 char) and error-message (10,000 char) truncation the
Playwright parser applies also apply here. `tags` and `annotations` are
always empty arrays for JUnit-sourced results (JUnit has no equivalent
concept) — they persist as `NULL`, same as an empty Playwright report.
Reports over 50,000 `<testcase>` elements are rejected with a `400`.

**Response (201):**
```json
{
  "success": true,
  "testRun": {
    "id": "uuid",
    "project": "my-project",
    "branch": "main",
    "commit": "abc123",
    "pipeline": "12345",
    "summary": {
      "total": 100,
      "passed": 95,
      "failed": 2,
      "flaky": 3,
      "skipped": 0
    }
  }
}
```

##### Synchronous ingest (`?wait=true`)

By default, ingesting a report triggers flakiness reconciliation (the
recomputation that updates `flaky_tests`) **in the background** — the `201`
above is returned as soon as the report is stored, **before** `flaky_tests`
necessarily reflects it. This keeps high-throughput CI uploaders from
blocking on recomputation, but it means a client that immediately reads
flakiness state afterward (e.g. [Get Quarantine List](#get-quarantine-list-ci-consumable) or
[Get Project Flaky Tests](#get-project-flaky-tests)) is racing that background job — it may
still see pre-ingest state.

Pass `?wait=true` to opt into synchronous behavior instead: the response is
only sent once `flaky_tests` has been reconciled for this ingest, and the
body gains a `reconcile` field describing what changed:

```http
POST /api/v1/reports?branch=main&commit=abc123&wait=true
```

```json
{
  "success": true,
  "testRun": { "...": "unchanged, same shape as above" },
  "reconcile": {
    "newlyFlaky": ["auth.spec.ts › should log in"],
    "newlyResolved": []
  }
}
```

`newlyFlaky` / `newlyResolved` are test names that transitioned status as
part of *this* reconcile (see [Get Real-Time Flakiness Analysis](#get-real-time-flakiness-analysis)
for the underlying transition rules) — an empty array means nothing
transitioned, not that reconciliation didn't run. A client that then
immediately calls the quarantine or flaky-tests endpoints is guaranteed to
see this ingest's effect, with no polling required.

**Latency trade-off**: `?wait=true` adds the reconcile's DB work (a scan of
this project's `test_results` within the configured window, then an upsert)
to the request's latency — normally low tens of milliseconds, but it scales
with the project's history and test count. Do not set it as the default for
a high-throughput uploader; use it only where a caller specifically needs the
post-ingest guarantee (the shipped GitHub Action uses it for exactly this
reason — see [`docs/GITHUB_ACTION.md`](GITHUB_ACTION.md)).

**Bounded, and never turns a successful upload into a `500`**: the report is
already committed by the time reconciliation runs, so a reconcile that fails
or takes longer than 10 seconds does not fail the request — it still returns
`201`, with the failure reported in the body instead:

```json
{
  "success": true,
  "testRun": { "...": "..." },
  "reconcile": { "error": "Reconcile timed out after 10000ms" }
}
```

The reconcile itself is triggered exactly once regardless of `wait`; a slow
or failed reconcile under `?wait=true` keeps running in the background past
the timeout, same as the default path.

---

### Tests

#### Get Test History

```http
GET /api/v1/tests/:name/history?project=project-id
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | Yes | Project ID |

**Response:**
```json
{
  "testName": "user login should work",
  "flakyInfo": {
    "id": "uuid",
    "testName": "user login should work",
    "testFile": "tests/auth.spec.ts",
    "flakeRate": "0.30",
    "status": "active",
    "firstDetected": "2024-12-01T00:00:00.000Z",
    "lastSeen": "2024-12-11T00:00:00.000Z"
  },
  "stats": {
    "totalRuns": 50,
    "passed": 35,
    "failed": 10,
    "flaky": 5,
    "skipped": 0,
    "avgDuration": 1500
  },
  "history": [
    {
      "id": "uuid",
      "status": "flaky",
      "durationMs": 1234,
      "retryCount": 1,
      "errorMessage": null,
      "tags": ["@smoke"],
      "annotations": [{ "type": "issue", "description": "JIRA-999" }],
      "createdAt": "2024-12-11T12:00:00.000Z",
      "branch": "main",
      "commitSha": "abc123"
    }
  ]
}
```

`tags` (`string[] | null`) and `annotations` (`{ type: string; description?: string }[] | null`) come from the
Playwright report's test case (and, for annotations, its per-project entries) and are `null` when the report
carried none.

#### Get Per-Test Flake-Rate Trend

```http
GET /api/v1/tests/:name/trend?project=project-id&days=30
```

Daily flake-rate trend for a single test, so you can answer "is this test
getting worse, or settling down?" There is no snapshot table behind this —
it's computed on demand from `test_results` every request (same approach as
[Get Flake Rate Trend](#get-flake-rate-trend) for a whole project).

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project` | string | Yes | — | Project ID (a test name is only unique within a project) |
| `days` | number | No | `30` | Trend window in days, clamped to `[1, 90]` |

**Response:**
```json
{
  "testName": "Checkout › should complete purchase",
  "projectId": "uuid",
  "days": 30,
  "direction": "worsening",
  "trend": [
    { "date": "2026-06-14", "totalRuns": 4, "failed": 0, "flaky": 0, "flakeRate": 0 },
    { "date": "2026-06-15", "totalRuns": 0, "failed": 0, "flaky": 0, "flakeRate": null },
    { "date": "2026-06-16", "totalRuns": 5, "failed": 2, "flaky": 1, "flakeRate": 0.6 }
  ]
}
```

`trend` always has exactly `days` entries, oldest first, one per calendar
day in the window — a day with no runs is zero-filled rather than omitted.
`flakeRate` is `(failed + flaky) / totalRuns` for that day, computed the
same way as everywhere else in the product (`skipped` counts toward
neither); it is a plain number when `totalRuns > 0`.

**`flakeRate: null` means the test did not run that day — it is not a `0`.**
"The test didn't run" and "the test ran and never flaked" are different
facts, and a consumer (chart, alert) must not treat `null` as "healthy". A
day with `totalRuns: 0` is always paired with `flakeRate: null`.

`direction` (`'improving' | 'worsening' | 'stable' | 'insufficient-data'`)
compares the mean flake rate of the first half of the window against the
second half, counting only days that actually had runs. A swing of `0.05`
or less (absolute) is `'stable'`; if either half has no runs at all, it's
`'insufficient-data'`. This is a deliberately crude heuristic meant to sort
a list, not a statistical claim.

**The trend horizon is bounded by the project's data retention** (see
[retentionDays](#update-project-flakiness-config) under Admin Endpoints). This endpoint
reads directly from `test_results`, so once a project has `retentionDays`
configured and old runs are pruned, days older than that window have no
rows left — they report `totalRuns: 0` and `flakeRate: null`, identical to
a day that genuinely had no runs. The trend silently shortens; it does not
error.

#### Get Flaky Test by ID

```http
GET /api/v1/tests/flaky/:id
```

Returns a single flaky-test row by its UUID. Responds `404` if no flaky test with that ID exists.

**Response:**
```json
{
  "flakyTest": {
    "id": "uuid",
    "projectId": "uuid",
    "testName": "user login should work",
    "testFile": "tests/auth.spec.ts",
    "firstDetected": "2024-12-01T00:00:00.000Z",
    "lastSeen": "2024-12-11T00:00:00.000Z",
    "flakeCount": 15,
    "totalRuns": 50,
    "flakeRate": "0.30",
    "status": "active"
  }
}
```

#### Mute / Unmute a Flaky Test

```http
PATCH /api/v1/tests/flaky/:id
```

Requires the admin Bearer token (see [Admin Endpoints](#admin-endpoints)), not a project token — this is a management action, not a per-project write.

**Body:**
```json
{
  "status": "ignored"
}
```

Only `"ignored"` (mute) and `"active"` (unmute) are accepted. `"resolved"` is system-managed and rejected with `400`. Reconcile passes (triggered on every report ingest) never overwrite an `"ignored"` status back to `"active"` or `"resolved"` — an operator must explicitly unmute.

A manual mute sets `mute_source` to `"manual"` and clears any auto-quarantine
expiry — manual mutes are **indefinite** and never auto-released by the
auto-quarantine engine (which only ever releases `mute_source: "auto"` rows).
A manual unmute clears `mute_source` back to `null` and stamps
`quarantine_released_at`. Both actions append one row to the internal
`quarantine_events` audit trail (`event: "manual_mute"` /
`"manual_unmute"`, `source: "manual"`) — there is no API endpoint to read
this table in v1; it exists for future auditing/UI.

**Response:**
```json
{
  "flakyTest": {
    "id": "uuid",
    "projectId": "uuid",
    "testName": "user login should work",
    "testFile": "tests/auth.spec.ts",
    "firstDetected": "2024-12-01T00:00:00.000Z",
    "lastSeen": "2024-12-11T00:00:00.000Z",
    "flakeCount": 15,
    "totalRuns": 50,
    "flakeRate": "0.30",
    "status": "ignored"
  }
}
```

Responds `400` for a malformed ID or an invalid `status` value, `404` if no flaky test with that ID exists.

---

## Admin Endpoints

Admin endpoints require the `ADMIN_TOKEN` environment variable for authentication.

```http
Authorization: Bearer your-admin-token
```

> ⚠️ **Security:** Set a strong `ADMIN_TOKEN` in production. Generate with: `openssl rand -hex 32`

> **Dashboard console:** the SvelteKit dashboard ships a `/admin` web console
> (plan 053) that drives these same endpoints — list, create, edit settings,
> rotate token, prune, delete. It is gated by the dashboard's own
> `DASHBOARD_PASSWORD` Basic Auth (`hooks.server.ts`), and spends `ADMIN_TOKEN`
> server-side only (`$lib/server/adminApi.ts`) — the token never reaches the
> browser. No endpoint contract changes; the console is a thin client of the
> API below.

### List All Projects

```http
GET /api/v1/admin/projects
```

**Response:**
```json
{
  "projects": [
    {
      "id": "uuid",
      "name": "my-project",
      "gitlabProjectId": "123",
      "hasToken": true,
      "createdAt": "2024-12-01T00:00:00.000Z",
      "flakeThreshold": null,
      "windowDays": null,
      "minRuns": null,
      "webhookUrl": null,
      "webhookKind": null,
      "retentionDays": null,
      "autoQuarantineEnabled": false,
      "quarantineThreshold": null,
      "quarantineMinRuns": null,
      "quarantineTtlDays": null,
      "stats": {
        "totalRuns": 150,
        "totalTests": 5000,
        "activeFlakyTests": 5
      }
    }
  ]
}
```

`flakeThreshold`, `windowDays`, and `minRuns` are per-project flakiness detection
overrides — see [Update Project Flakiness Config](#update-project-flakiness-config).
`null` means the project uses the built-in default for that field.

`webhookUrl` is an optional outbound notification URL — see
[Flaky-Test Transition Webhooks](#flaky-test-transition-webhooks). `null` means
no webhook is configured.

`webhookKind` picks the payload format sent to `webhookUrl` — `"slack"`,
`"generic"`, or `null` (the default) to auto-detect from the URL host. See
**Channel selection** under
[Flaky-Test Transition Webhooks](#flaky-test-transition-webhooks).

`retentionDays` is an optional per-project data retention window — see
[Update Project Flakiness Config](#update-project-flakiness-config) and
[Prune Project Data](#prune-project-data). `null` (the default for every
project, including ones created before this field existed) means **keep
forever**; no data is ever deleted automatically.

`autoQuarantineEnabled`, `quarantineThreshold`, `quarantineMinRuns`, and
`quarantineTtlDays` configure auto-quarantine — see
[Update Project Flakiness Config](#update-project-flakiness-config).
`autoQuarantineEnabled` defaults to `false` (opt-in, current behavior
unchanged); the other three are `null` until overridden, meaning they use
their respective built-in defaults.

### Create Project

```http
POST /api/v1/admin/projects
```

**Body:**
```json
{
  "name": "new-project",
  "gitlabProjectId": "123"  // optional
}
```

**Response (201):**
```json
{
  "project": {
    "id": "uuid",
    "name": "new-project",
    "createdAt": "2024-12-11T00:00:00.000Z"
  },
  "token": "flackyness_abc123...",
  "warning": "Save this token securely. It will not be shown again."
}
```

### Rotate Token

```http
POST /api/v1/admin/projects/:id/rotate-token
```

**Response:**
```json
{
  "project": {
    "id": "uuid",
    "name": "my-project"
  },
  "token": "flackyness_newtoken...",
  "warning": "Save this token securely. The old token is now invalid."
}
```

### Update Project Flakiness Config

```http
PATCH /api/v1/admin/projects/:id
```

Update a project's per-project flakiness detection overrides, its
transition-notification webhook, its data retention, and/or its
auto-quarantine config. Fields omitted from the body are left unchanged;
sending a field as `null` explicitly clears it back to the built-in default
(or, for `webhookUrl`, disables the webhook; for `retentionDays`, reverts to
"keep forever"). At least one field is required.

**Body (all fields optional, but at least one required):**
```json
{
  "flakeThreshold": 0.1,
  "windowDays": 30,
  "minRuns": 5,
  "webhookUrl": "https://example.com/hooks/flackyness",
  "webhookKind": "slack",
  "retentionDays": 60,
  "autoQuarantineEnabled": true,
  "quarantineThreshold": 0.25,
  "quarantineMinRuns": 5,
  "quarantineTtlDays": 10
}
```

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `flakeThreshold` | number \| null | `[0, 1]` | Flake-rate threshold above which a test is considered flaky. `null` resets to the default (`0.05`). |
| `windowDays` | integer \| null | `[1, 90]` | Analysis window in days used by background flakiness reconciliation. `null` resets to the default (`14`). |
| `minRuns` | integer \| null | `[1, 100]` | Minimum number of runs required before a test is analyzed. `null` resets to the default (`3`). |
| `webhookUrl` | string \| null | max 2048 chars, `http:`/`https:` only | Outbound URL notified on flaky-test transitions — see [Flaky-Test Transition Webhooks](#flaky-test-transition-webhooks) — **and** on auto-quarantine entry/exit — see [Auto-Quarantine Webhooks](#auto-quarantine-webhooks). Both share this one URL. `null` disables both. |
| `webhookKind` | `"slack"` \| `"generic"` \| null | — | Explicit payload-format override for `webhookUrl`. `null` (default) auto-detects from the URL host (`hooks.slack.com` → Slack format, else generic). Set to `"slack"` for a self-hosted **Mattermost** URL, which accepts Slack's payload but isn't on `hooks.slack.com`. See **Channel selection** under [Flaky-Test Transition Webhooks](#flaky-test-transition-webhooks). |
| `retentionDays` | integer \| null | `[1, 3650]` | Days of `test_runs` history to keep — see [Prune Project Data](#prune-project-data). `null` (the default) means **keep forever**; no global default exists. |
| `autoQuarantineEnabled` | boolean | — | Turns auto-quarantine on/off for this project. Defaults to `false` (opt-in; current behavior unchanged). |
| `quarantineThreshold` | number \| null | `[0, 1]` | Flake-rate threshold above which a test is auto-quarantined. `null` resets to the default (`0.20`). Must be **>= the resolved `flakeThreshold`** (this request's, if it sets one, else the stored/default value) — a quarantine bar below the detection bar is rejected with `400`. |
| `quarantineMinRuns` | integer \| null | `[1, 100]` | Minimum number of runs required before a test is (re-)quarantined. `null` resets to the resolved `minRuns`. |
| `quarantineTtlDays` | integer \| null | `[1, 365]` | Mandatory TTL of an auto-quarantine, in days. `null` resets to the default (`7`). |

**Response (200):**
```json
{
  "project": {
    "id": "uuid",
    "name": "my-project",
    "gitlabProjectId": "123",
    "createdAt": "2024-12-01T00:00:00.000Z",
    "flakeThreshold": 0.1,
    "windowDays": 30,
    "minRuns": 5,
    "webhookUrl": "https://example.com/hooks/flackyness",
    "webhookKind": "slack",
    "retentionDays": 60,
    "autoQuarantineEnabled": true,
    "quarantineThreshold": 0.25,
    "quarantineMinRuns": 5,
    "quarantineTtlDays": 10
  }
}
```

Returns `400` if the body fails validation (out-of-range values, a non-`http(s)`
`webhookUrl`, a `quarantineThreshold` below the resolved `flakeThreshold`, or
an empty body) and `404` if the project doesn't exist.

> **The retention/window guard:** `retentionDays` may never be lower than the
> project's *resolved* flakiness `windowDays` (the stored override if set,
> otherwise the default `14`) — pruning data still inside the analysis window
> would make flake rates drift as history vanishes underneath them. A request
> that violates this is rejected with `400` naming both numbers:
> ```json
> { "error": "retentionDays (7) must be >= the flakiness windowDays (14)" }
> ```
> If the same request sets **both** fields, the check validates against the
> **new** `windowDays` being written, not the previously stored one.

> **Tuning flakiness detection:** Flakiness is normally governed by three
> defaults — `windowDays: 14`, `flakeThreshold: 0.05`, `minRuns: 3`. This
> endpoint overrides them per project. Changes take effect on the **next
> report ingest** (the flaky-tests table is only recomputed then), and MAY
> reclassify tests already tracked for the project: tightening a threshold
> can resolve tests that no longer qualify as flaky, while loosening it can
> activate tests that newly cross the bar. This is expected, not a bug.
> `GET /api/v1/projects/:id/analysis` picks up overrides immediately (it's
> computed live), but explicit `days`/`threshold` query params on that
> endpoint still take precedence over the stored project config.

### Flaky-Test Transition Webhooks

Set `webhookUrl` via [Update Project Flakiness Config](#update-project-flakiness-config)
to get a notification whenever a report ingest causes a test to newly become
flaky or a previously-flaky test to resolve.

**Example — set a webhook:**
```http
PATCH /api/v1/admin/projects/:id
Authorization: Bearer your-admin-token
Content-Type: application/json

{ "webhookUrl": "https://example.com/hooks/flackyness" }
```

**Channel selection:** the payload format sent to `webhookUrl` is picked by
`webhookKind` (set alongside `webhookUrl` in the same PATCH body):

| `webhookKind` | Behavior |
|---|---|
| `null` (default) | Auto-detect from the URL: a `hooks.slack.com` host gets the Slack format below; anything else gets the generic format. |
| `"slack"` | Always send the Slack format, regardless of host. |
| `"generic"` | Always send the generic format, regardless of host. |

A self-hosted **Mattermost** instance accepts Slack's incoming-webhook
payload but isn't on `hooks.slack.com`, so auto-detect won't catch it — set
`webhookKind` explicitly to opt in:
```json
{ "webhookUrl": "https://mattermost.example.com/hooks/xyz", "webhookKind": "slack" }
```

**Trigger:** the background reconciliation that already runs after every
`POST /api/v1/reports` ingest (see [Upload Playwright Report](#upload-playwright-report)).
If that reconciliation finds at least one newly-flaky or newly-resolved test
**and** the project has a `webhookUrl` configured, the API sends **one** POST
request per ingest, in the format `webhookKind` (or auto-detection) selects:

**Generic payload:**
```http
POST <webhookUrl>
Content-Type: application/json
```
```json
{
  "event": "flaky_tests_changed",
  "project": { "id": "uuid", "name": "my-project" },
  "newlyFlaky": ["login test flakes on retry"],
  "newlyResolved": ["checkout test"],
  "run": { "branch": "main", "commitSha": "abc123..." },
  "dashboardUrl": null
}
```

**Slack payload** (same event, `DASHBOARD_BASE_URL=https://flackyness.example.com`):
```http
POST <webhookUrl>
Content-Type: application/json
```
```json
{
  "text": "<https://flackyness.example.com/flaky|*my-project*> on `main` — ⚠️ 1 newly flaky: login test flakes on retry  ·  ✅ 1 resolved: checkout test",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "<https://flackyness.example.com/flaky|*my-project*> on `main` — ⚠️ 1 newly flaky: login test flakes on retry  ·  ✅ 1 resolved: checkout test"
      }
    }
  ]
}
```
`text` is a plain Slack mrkdwn summary — Slack's required notification
fallback, and also the part Mattermost renders reliably (its Block Kit
support is partial, so `blocks` degrades to `text` there). `blocks` is the
richer Slack rendering of the same content. The `<url|label>` markup only
appears when `DASHBOARD_BASE_URL` is set (see below); without it, the
project/test name renders as plain mrkdwn text. Project and test names are
mrkdwn-escaped (`& < >`) before interpolation, so a test name can't inject
markup or a live link.

`newlyFlaky` and `newlyResolved` are test names (`newlyFlaky` may be empty if
only resolutions happened, and vice versa — the webhook only fires when at
least one of the two is non-empty). A test that was previously `ignored`
(muted) does **not** count as a transition even if it still meets the flake
threshold — an operator-muted test stays silent. `dashboardUrl` (generic
payload only) links to the project's flaky-test list when the deployment
sets `DASHBOARD_BASE_URL`, and is `null` otherwise — it was always `null` in
earlier releases; existing consumers that ignore the field are unaffected.

**Dashboard deep-links (`DASHBOARD_BASE_URL`):** a deployment-global
environment variable, not a per-project setting. Set it to the dashboard's
public `http(s)` base URL (e.g. `https://flackyness.example.com`, no
trailing slash needed) to have webhook payloads link back into the
dashboard: `<base>/flaky` for this event, `<base>/tests/<url-encoded-test-name>`
for a specific test (auto-quarantine events, below). Unset, empty, or a
non-`http(s)` value disables deep-links everywhere — `dashboardUrl: null` in
the generic payload, plain-text (no `<url|label>`) in the Slack payload.
This is the default and fully backward-compatible.

**Delivery semantics (v1):**
- One best-effort POST per ingest; a 5-second timeout.
- **No retries.** A non-2xx response or network failure is logged
  server-side and otherwise dropped.
- **No payload signing / shared secret.** Anything that can read the
  response body of your webhook endpoint can also forge a payload if it
  knows the URL — do not treat the payload as authenticated.
- Delivery failures never block or delay the `201` response for the report
  ingest that triggered them; the webhook send happens after ingest, in the
  same fire-and-forget background step as flakiness reconciliation.
- `webhookUrl` is set only through the admin-token-protected PATCH route —
  the same trust level as the operator's shell. There is **no IP deny-list**
  in v1 (no protection against pointing the webhook at an internal/private
  address); this is a deliberate tradeoff for a single-operator deployment,
  not an oversight.

### Auto-Quarantine Webhooks

Set `webhookUrl` via [Update Project Flakiness Config](#update-project-flakiness-config)
— the same URL used for [Flaky-Test Transition Webhooks](#flaky-test-transition-webhooks)
— to also get a notification whenever the auto-quarantine engine promotes a
test into quarantine or releases one back out. These only fire for a project
with `autoQuarantineEnabled: true`; see
[Get Quarantine List](#get-quarantine-list-ci-consumable) for how a
quarantined test shows up in `muted`/`grepInvert`.

Channel selection is shared with the flaky-transition webhook above:
`webhookKind` (or host auto-detection) picks generic vs. Slack format for
this webhook too — see **Channel selection** above.

**Trigger:** the same background reconciliation that runs after every
`POST /api/v1/reports` ingest, immediately after flaky-test detection
settles (auto-quarantine reads the freshly-reconciled `flaky_tests` rows).
If that reconciliation promotes a test into quarantine or releases one past
its TTL, **and** the project has a `webhookUrl` configured, the API sends
**one** POST request per transition (a single ingest can therefore fire more
than one of these, unlike the flaky-transition webhook which sends at most
one per ingest):

**Generic payload:**
```http
POST <webhookUrl>
Content-Type: application/json
```
```json
{
  "event": "quarantine_entered",
  "project": { "id": "uuid", "name": "my-project" },
  "testName": "login test flakes on retry",
  "flakeRate": 0.42,
  "expiresAt": "2024-12-18T00:00:00.000Z"
}
```

**Slack payload** (same event, `DASHBOARD_BASE_URL=https://flackyness.example.com`
— the test name links to its trend page, `<base>/tests/<url-encoded-test-name>`):
```json
{
  "text": "🔒 <https://flackyness.example.com/flaky|*my-project*>: quarantined <https://flackyness.example.com/tests/login%20test%20flakes%20on%20retry|login test flakes on retry> (flake rate 42%), muted until 2024-12-18",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "🔒 <https://flackyness.example.com/flaky|*my-project*>: quarantined <https://flackyness.example.com/tests/login%20test%20flakes%20on%20retry|login test flakes on retry> (flake rate 42%), muted until 2024-12-18"
      }
    }
  ]
}
```
A `quarantine_released` event renders as `🔓 <project>: released <test> from
quarantine` (no flake rate or TTL), with the same link markup rules. Without
`DASHBOARD_BASE_URL`, the project/test names render as plain mrkdwn text.

`event` is `quarantine_entered` when a test crosses `quarantineThreshold` and
is auto-muted, or `quarantine_released` when an auto-mute's TTL expires and
the test returns to `active`. `flakeRate` is the test's flake rate at the
time of the transition (`null` if unavailable). `expiresAt` is the ISO
timestamp the quarantine will auto-release at — only populated for
`quarantine_entered`; it is always `null` for `quarantine_released`. The
generic payload's field names/shape are unchanged by this work — it never
had a `dashboardUrl` field and still doesn't; the Slack payload's link
markup is the only way this event carries a dashboard link.

**Delivery semantics (v1):** identical to the flaky-transition webhook above
— one best-effort POST per transition, a 5-second timeout, no retries, no
payload signing, and delivery failures never block or delay the `201`
ingest response (or `?wait=true`'s reconcile, which only waits for the
quarantine *database* state to settle, never for webhook delivery).

### Delete Project

```http
DELETE /api/v1/admin/projects/:id
```

**Response:**
```json
{
  "success": true,
  "message": "Project \"my-project\" and all associated data deleted."
}
```

### Prune Project Data

```http
POST /api/v1/admin/projects/:id/prune
POST /api/v1/admin/projects/:id/prune?confirm=true
```

Deletes `test_runs` older than the project's configured `retentionDays` (set
via [Update Project Flakiness Config](#update-project-flakiness-config)).
`test_results` for those runs cascade automatically via a foreign key —
they are never deleted directly. **`flaky_tests` is never touched by this
route**: it is the product's memory of past and currently-muted flakiness
(including `status: "ignored"` rows) and has no relationship to `test_runs`,
so it survives pruning intact regardless of how much run history is deleted.

There is no scheduler — call this endpoint from cron, a CI job, or any
trigger you control, on whatever cadence you choose.

**Dry-run is the default.** Without `?confirm=true`, the route reports the
counts it *would* delete and **deletes nothing**. Deletion only happens with
the explicit `?confirm=true` query parameter — an admin token plus a `curl`
typo must not be able to destroy history.

**Dry-run response (200), no `?confirm=true`:**
```json
{
  "dryRun": true,
  "cutoff": "2024-11-11T00:00:00.000Z",
  "runsToDelete": 42,
  "resultsToDelete": 1830
}
```

**Confirmed response (200), `?confirm=true`:**
```json
{
  "dryRun": false,
  "cutoff": "2024-11-11T00:00:00.000Z",
  "runsDeleted": 42,
  "resultsDeleted": 1830
}
```

`cutoff` is `now - retentionDays` (ISO 8601); runs with `created_at` older
than `cutoff` are the ones counted/deleted. Deletion happens in batches of
5000 run ids per statement so a first prune of a long-lived database doesn't
hold one enormous lock.

**Error responses:**

| Status | Condition |
|--------|-----------|
| `400` | `retentionDays` is not configured for this project (`null`) — pruning without an explicit retention is always a mistake. |
| `400` | The stored `retentionDays` is lower than the project's *resolved* `windowDays` — the same guard enforced on PATCH, re-checked here because `windowDays` may have been raised **after** `retentionDays` was set, leaving a stale, invalid pair. Names both numbers, e.g. `{ "error": "retentionDays (7) must be >= the flakiness windowDays (14)" }`. Nothing is deleted. |
| `404` | Project doesn't exist. |

**Example — nightly prune via cron (dry-run first, then confirmed):**
```bash
# Dry-run: see what would be deleted, deletes nothing.
curl -sX POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$FLACKYNESS_URL/api/v1/admin/projects/$PROJECT_ID/prune"

# Nightly prune (drop --confirm=true to go back to a dry-run).
curl -sX POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$FLACKYNESS_URL/api/v1/admin/projects/$PROJECT_ID/prune?confirm=true"
```

### Quarantine Rules

Ordered per-project policy rules (roadmap 4b) that decide whether a test
gets **quarantined** (auto-muted) or **exempted** (never auto-muted),
replacing the single project-wide `quarantineThreshold` (see
[Update Project Flakiness Config](#update-project-flakiness-config)) with
finer-grained, selector-scoped policy. When a project has at least one
**enabled** rule, auto-quarantine reconciliation evaluates the rule list;
otherwise it falls back unchanged to the legacy single-threshold behavior.

**Rule shape:**

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `id` | uuid | — | Server-generated, read-only. |
| `name` | string \| null | max 255 chars | Optional label. |
| `enabled` | boolean | — | Disabled rules are skipped during evaluation but stay in the list (position included). Defaults to `true` on create. |
| `position` | integer | `>= 0` | Evaluation order — **lower runs first, and the first matching rule wins.** Managed by create (append) and [Reorder Rules](#reorder-rules); not a plain create/patch field beyond the initial create-time value. |
| `selectorBranch` | string \| null | max 255 chars | Glob (`*` within a path segment, `**` across segments, `?` one char) matched against the run's branch. `null` matches any branch. |
| `selectorFile` | string \| null | max 500 chars | Glob matched against the test's file path. `null` matches any file. |
| `selectorTag` | string \| null | max 255 chars | Exact tag membership (the test must carry this tag). `null` matches any tags. |
| `action` | `"quarantine"` \| `"exempt"` | — | `"quarantine"`: mute the test when its condition fires. `"exempt"`: never auto-mute the test, unconditionally — no `conditionType`/threshold fields allowed. |
| `conditionType` | `"flake_rate"` \| `"consecutive"` \| null | — | Required (non-null) for `action: "quarantine"`; must be `null` for `action: "exempt"`. |
| `flakeThreshold` | number \| null | `[0, 1]` | Required when `conditionType: "flake_rate"`. Flake-rate bar within the rule's evaluation window. |
| `minRuns` | integer \| null | `[1, 100]` | Minimum runs in-window before a `flake_rate` condition can fire. |
| `windowDays` | integer \| null | `[1, 90]` | Evaluation window for `flake_rate`. |
| `consecutiveFailures` | integer \| null | `[1, 100]` | Required when `conditionType: "consecutive"`. Consecutive-failure streak (newest-first) needed to fire. |
| `ttlDays` | integer \| null | `[1, 365]` | TTL applied to a quarantine entered via this rule. |

A rule's selectors are `AND`ed together (all non-null selectors must match);
a `null` selector field imposes no constraint. Every rule under a project
must have a valid `action`; `conditionType`/threshold fields are validated
together — e.g. `conditionType: "flake_rate"` without `flakeThreshold` is
rejected with `400`, as is any condition field set alongside
`action: "exempt"`.

**First-match-wins + fallback:** rules are evaluated in ascending `position`
order; the first rule whose selectors match the test owns the decision and
evaluation stops there (later rules are not consulted for that test). If no
rule's selectors match a test, evaluation falls back to the project's legacy
single-threshold `quarantineThreshold` config.

#### List Rules

```http
GET /api/v1/admin/projects/:id/rules
```

Returns the project's rules ordered by `position` (evaluation order).

**Response (200):**
```json
{
  "rules": [
    {
      "id": "uuid",
      "projectId": "uuid",
      "position": 0,
      "name": "exempt release branches",
      "enabled": true,
      "selectorBranch": "release/*",
      "selectorFile": null,
      "selectorTag": null,
      "action": "exempt",
      "conditionType": null,
      "flakeThreshold": null,
      "minRuns": null,
      "windowDays": null,
      "consecutiveFailures": null,
      "ttlDays": null,
      "createdAt": "2024-12-01T00:00:00.000Z",
      "updatedAt": "2024-12-01T00:00:00.000Z"
    }
  ]
}
```

Returns `400` for a malformed project id. Does **not** 404 for a
well-formed but non-existent project id — it returns an empty `rules` array,
matching the read behavior of `GET /api/v1/projects/:id/flaky-tests`.

#### Create Rule

```http
POST /api/v1/admin/projects/:id/rules
```

**Body:** any subset of the rule shape above, plus a required `action` (and
its matching condition fields for `action: "quarantine"`). Without an
explicit `position`, the rule is appended after the project's current
highest position (evaluated last / lowest priority).

```json
{ "action": "quarantine", "conditionType": "flake_rate", "flakeThreshold": 0.3, "selectorBranch": "main" }
```

**Response (201):** `{ "rule": { ... } }` — same shape as the list above.
Returns `400` on a validation failure (e.g. `action: "exempt"` with a
`conditionType` set, or `conditionType: "consecutive"` without
`consecutiveFailures`).

#### Update Rule

```http
PATCH /api/v1/admin/projects/:id/rules/:ruleId
```

**Body:** any subset of the rule shape's writable fields (all optional).
The **merged** row (existing values overlaid with the patch) is re-validated
against the full rule schema, so a partial patch can never leave the rule in
an inconsistent state — e.g. patching `{ "action": "exempt" }` on a rule
that still carries a `flakeThreshold` from before is rejected with `400`
rather than silently landing a broken rule.

**Response (200):** `{ "rule": { ... } }`. Returns `400` on a validation
failure and `404` if `ruleId` doesn't exist under this `id`.

#### Delete Rule

```http
DELETE /api/v1/admin/projects/:id/rules/:ruleId
```

**Response (200):** `{ "success": true }`. Returns `404` if `ruleId` doesn't
exist under this `id` (including a `ruleId` that belongs to a different
project).

#### Reorder Rules

```http
POST /api/v1/admin/projects/:id/rules/reorder
```

**Body:** `order` must be exactly the project's current rule ids, in the
desired evaluation order (each id's index becomes its new `position`):
```json
{ "order": ["uuid-of-rule-now-first", "uuid-of-rule-now-second"] }
```

**Response (200):** `{ "success": true }`. Returns `400` if `order` is not
exactly the project's current rule id set (missing an id, containing an
extra/unknown id, or a duplicate) — nothing is written in that case.

### System Health

```http
GET /api/v1/admin/health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-12-11T12:00:00.000Z",
  "database": {
    "projects": 5,
    "testRuns": 150,
    "testResults": 15000,
    "flakyTests": 25
  },
  "version": "0.0.1"
}
```

---

## Monitoring

```http
GET /metrics
```

A Prometheus scrape endpoint on the root app (not under `/api/v1`, per
Prometheus convention). Off by default: with no `METRICS_TOKEN` set in the
environment, the route returns `404` and is otherwise invisible. Once set,
requests must present it as a Bearer token:

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:8080/metrics
```

An unset or wrong token returns `401`. On success the response is
`text/plain; version=0.0.4` Prometheus exposition format containing:

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `flackyness_reports_ingested_total` | Counter | `project` | Reports successfully ingested (HTTP 201) |
| `flackyness_report_parse_failures_total` | Counter | — | Ingest requests that failed to parse (Playwright JSON or JUnit XML) |
| `flackyness_flaky_tests_active` | Gauge | `project` | Currently active flaky tests, computed at scrape time |
| `flackyness_test_runs_total` | Gauge | `project` | Total ingested test runs, computed at scrape time |

Plus the standard Node.js process metrics (`process_cpu_*`, `process_resident_memory_bytes`,
`nodejs_eventloop_lag_seconds`, etc.) from `prom-client`'s default collector.

If the database is unreachable when Prometheus scrapes, the two gauges are
simply omitted from that scrape (logged server-side) rather than the
endpoint returning an error — the counters and process metrics are always
served.

**Example Prometheus scrape config:**
```yaml
scrape_configs:
  - job_name: flackyness
    bearer_token: <your METRICS_TOKEN>
    static_configs:
      - targets: ['flackyness-api:8080']
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Error message description"
}
```

### Common Status Codes

| Code | Description |
|------|-------------|
| `200` | Success |
| `201` | Created |
| `400` | Bad Request - Invalid input |
| `401` | Unauthorized - Missing or invalid token |
| `404` | Not Found - Resource doesn't exist |
| `409` | Conflict - Resource already exists |
| `429` | Too Many Requests - Rate limit exceeded |
| `500` | Internal Server Error |

---

## Rate Limiting

| Endpoint | Limit |
|----------|-------|
| `POST /api/v1/reports` | 60 requests/minute per token |
| `Admin endpoints` | 20 requests/minute per IP |
| All other endpoints | 100 requests/minute per IP |

When rate limited, you'll receive:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
```

---

## Example: Upload Report with curl

```bash
# Run Playwright tests with JSON reporter
npx playwright test --reporter=json --output-file=results.json

# Upload results
curl -X POST "https://flackyness.example.com/api/v1/reports" \
  --url-query "branch=main" \
  --url-query "commit=$(git rev-parse HEAD)" \
  --url-query "pipeline=$CI_PIPELINE_ID" \
  -H "Authorization: Bearer $FLACKYNESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d @results.json
```

## Example: Upload a JUnit XML Report with curl

```bash
# e.g. jest --reporters=jest-junit --testResultsProcessor=jest-junit,
# or pytest --junitxml=report.xml

curl -X POST "https://flackyness.example.com/api/v1/reports" \
  --url-query "branch=main" \
  --url-query "commit=$(git rev-parse HEAD)" \
  --url-query "pipeline=$CI_PIPELINE_ID" \
  -H "Authorization: Bearer $FLACKYNESS_TOKEN" \
  -H "Content-Type: application/xml" \
  --data-binary @report.xml
```

Note `--data-binary` (not `-d`), which sends the file byte-for-byte —
curl's `-d` strips newlines, which is harmless for JSON but can corrupt XML.

## Example: Create Project (Admin)

```bash
curl -X POST "http://localhost:8080/api/v1/admin/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-new-project"}'
```
