# Plan 018: Prometheus /metrics endpoint for the API

> **Executor instructions**: Follow step by step; run every verification
> command. On any STOP condition, stop and report. Update your row in
> `plans/README.md` when done — unless a reviewer dispatched you and said
> they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7609d55..HEAD -- apps/api/src/index.ts apps/api/src/routes/reports.ts apps/api/package.json .env.example`
> If `src/index.ts` no longer composes the app as excerpted below, re-read it
> before Step 2.

## Status

- **DONE** — merged via PR #56, commit `1daeb46` (2026-07-13).
- **Priority**: P3
- **Effort**: M
- **Risk**: LOW–MED (new dependency; new endpoint; DB queries on scrape)
- **Depends on**: **Serial constraint with 017**: both add a dependency →
  lockfile conflicts; land after 017. No functional dependency.
- **Category**: integration (direction D6)
- **Planned at**: commit `7609d55`, 2026-07-10

## Why this matters

Flackyness is a self-hosted ops tool, and self-hosters run Prometheus. The
API currently exposes operational state only through `GET /api/v1/admin/health`
(admin-token JSON, human-shaped). A `/metrics` endpoint makes ingest volume,
parse failures, and flaky-test counts graphable and alertable with the
stack operators already have — "alert when active flaky tests > N" becomes a
one-line Prometheus rule instead of a Flackyness feature.

## Current state

- `apps/api/src/index.ts` — plain Hono composition: `secureHeaders`, `cors`,
  `bodyLimit`, request logger; `app.get('/health', …)` at line 53 (simple
  liveness, no auth); routers mounted at lines 69–72
  (`/api/v1/reports|projects|tests|admin`); server started via
  `serve({...})` only outside tests (tests use `app.request()` directly).
- `apps/api/src/routes/admin.ts` — `GET /health` (line 197) computes DB
  counts for its JSON body (projects/runs/results totals) — the semantic
  source for scrape-time gauges.
- `apps/api/src/routes/reports.ts` — ingest handler: parse failures return
  400 (in the parse try/catch); successful ingest runs the transaction then
  201 — the two counter increment points.
- `apps/api/package.json` — no metrics dependency. Adding one:
  `CI=true pnpm --filter api add prom-client --no-frozen-lockfile`
  (pnpm 11, `minimumReleaseAge: 1440`; commit the lockfile — CI uses
  `--frozen-lockfile`).
- `.env.example` — DATABASE_URL, DB_PASSWORD, API_PORT, API_HOST,
  PUBLIC_API_URL, ADMIN_TOKEN, commented TRUSTED_PROXY_IPS. No metrics var.
- Env-var handling convention: read from `process.env` at request/startup
  time (see how ADMIN_TOKEN is consumed in `middleware/auth.ts` — mirror it).

## Design decisions (advisor — do not relitigate)

1. Library: `prom-client` (the canonical Node client; pure JS).
2. Exposure/auth: `GET /metrics` on the ROOT app (Prometheus convention —
   not under `/api/v1`). Gated by a new optional `METRICS_TOKEN` env var:
   unset → route returns **404** (feature off, invisible); set → requires
   `Authorization: Bearer <token>` (constant-time comparison — reuse the
   exact comparison helper `adminAuth` uses; read `middleware/auth.ts` and
   share its util rather than re-implementing).
3. Metrics (all prefixed `flackyness_`):
   - `flackyness_reports_ingested_total{project}` — Counter, incremented on
     201 in reports.ts (label = project NAME, bounded by the projects table).
   - `flackyness_report_parse_failures_total` — Counter, incremented on the
     parse-failure 400 path (NO project label needed; keep cardinality flat).
   - `flackyness_flaky_tests_active{project}` — Gauge, computed at SCRAPE
     time via an async `collect()` callback: one grouped query
     (`SELECT p.name, count(*) FROM flaky_tests ft JOIN projects p … WHERE ft.status='active' GROUP BY p.name` —
     written with drizzle, matching repo style).
   - `flackyness_test_runs_total{project}` — same collect() pattern from
     `test_runs`.
   - `collectDefaultMetrics()` (process CPU/mem/eventloop — free and expected).
4. One module `apps/api/src/metrics.ts` owns the `Registry` and exports the
   counters + a `metricsHandler`; nothing else imports prom-client. Use a
   dedicated `new Registry()` (not the global default) so tests can
   instantiate cleanly.
5. Scrape failure isolation: if the gauge DB query throws (DB down), the
   handler still returns the counters it has (wrap collect in try/catch and
   log) — a dead DB must not make /metrics 500, or operators lose visibility
   exactly when they need it. Achieve this by catching inside `collect()`.

## Commands you will need

Add dep: `CI=true pnpm --filter api add prom-client --no-frozen-lockfile`.
Typecheck `pnpm --filter api exec tsc --noEmit`; tests
`pnpm --filter api test` (DB-gated needs `DATABASE_URL`+`ADMIN_TOKEN`); lint
`pnpm lint` (garbled → `rtk proxy pnpm lint`). Disposable DB:
`docker run -d --name flackyness-test-pg-018 -e POSTGRES_PASSWORD=test_password -e POSTGRES_DB=flackyness_test -p 5439:5432 postgres:16-alpine`,
`touch .env` at root, `DATABASE_URL=postgres://postgres:test_password@localhost:5439/flackyness_test pnpm db:migrate`.
ALWAYS clean up container + temp `.env`. Never `docker compose up`.

## Scope

**In scope**: `apps/api/package.json` + `pnpm-lock.yaml` (the one dep), NEW
`apps/api/src/metrics.ts` + `metrics.test.ts`, `apps/api/src/index.ts`
(route mount only), `apps/api/src/routes/reports.ts` (two increment lines),
`.env.example` (commented `METRICS_TOKEN`), `docs/` (short "Monitoring"
section in GETTING_STARTED or API.md — pick where health is documented and
sit next to it).

**Out of scope**: dashboard; docker-compose (no Prometheus service);
Grafana dashboards; alerting rules; histogram/latency metrics (v2 — needs
middleware, different blast radius); the admin /health endpoint itself.

## Git workflow

Branch `advisor/018-prometheus-metrics`; single-line conventional commits
(e.g. `feat(api): prometheus /metrics endpoint`); NO `Co-Authored-By`
trailers; no push/PR unless the operator instructed it.

## Steps

### Step 1: Dependency + metrics module

Add `prom-client`. Create `src/metrics.ts` per design decision 3–5:
registry, two Counters, two Gauges with async `collect()` (drizzle grouped
counts, try/catch-logged), `collectDefaultMetrics({ register })`, and:

```ts
export async function renderMetrics(): Promise<string> {
  return register.metrics();
}
```

Counter export shape: `export const reportsIngestedTotal`, etc. — direct
named exports, matching the repo's plain-module style (see how `db` or
`logger` are exported).

**Verify**: tsc → 0.

### Step 2: Route mount

In `src/index.ts`, next to the existing `app.get('/health', …)` (line 53):

```ts
app.get('/metrics', async (c) => {
  const token = process.env.METRICS_TOKEN;
  if (!token) return c.json({ error: 'Not found' }, 404);
  // Bearer check — same parsing + constant-time comparison as adminAuth
  …
  c.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  return c.body(await renderMetrics());
});
```

Reuse (import) `adminAuth`'s token-extraction/comparison helper from
`middleware/auth.ts` — if it isn't exported, export it from there (that
file is then in scope for that one-line export ONLY). Match the 401 error
shape the middleware uses.

**Verify**: tsc → 0.

### Step 3: Increments in reports.ts

- On the 201 path (after the transaction commits, before returning):
  `reportsIngestedTotal.inc({ project: project.name })`.
- On the parse-failure 400 path(s): `reportParseFailuresTotal.inc()`.
  If plan 017 landed there are two parse branches (JSON + XML) — increment
  in both.

**Verify**: tsc → 0; existing reports tests unchanged and green.

### Step 4: Tests

`metrics.test.ts` via `app.request()` like existing route tests
(env juggling with `vi.stubEnv` or save/restore — copy whatever
`admin.test.ts` does for ADMIN_TOKEN):

1. `METRICS_TOKEN` unset → 404.
2. Set, no/bad Bearer → 401; correct → 200 `text/plain` containing
   `flackyness_reports_ingested_total` and `process_cpu` lines.
3. DB-gated: ingest a fixture report → scrape shows
   `flackyness_reports_ingested_total{project="…"} 1` and
   `flackyness_test_runs_total{project="…"} 1`; POST garbage body →
   parse-failure counter ≥ 1.
4. Gauge resilience: without DATABASE_URL (or with the pool closed —
   whichever the no-DB test mode makes natural), scrape still 200s and
   contains the counters. If the lazy-DB-init design makes "DB down" hard to
   simulate, assert at the unit level that `collect()` swallows a thrown
   query and note it.

**Verify**: `pnpm --filter api test` → green in DB and no-DB modes.

### Step 5: Env + docs + e2e

`.env.example`: commented `# METRICS_TOKEN=` with a one-line comment
(enables GET /metrics). Docs: Monitoring section — enabling, a
`curl -H "Authorization: Bearer $METRICS_TOKEN" localhost:8080/metrics`
example, metric list with one-line meanings, and a sample Prometheus
scrape config block (4 lines). E2E: disposable stack, METRICS_TOKEN set,
ingest the real fixture, curl /metrics → expected series present; unset
token → 404. Clean up.

## Done criteria

- [ ] `prom-client` added; lockfile committed; frozen install green
- [ ] `/metrics`: 404 when unconfigured, 401 bad auth, 200 text/plain with all four `flackyness_*` series + default metrics
- [ ] Counters increment on ingest/parse-failure; gauges reflect DB state at scrape; DB-down scrape still 200s
- [ ] `.env.example` + docs updated
- [ ] Gates: api tsc + tests (both modes), `pnpm lint`; `git status` clean outside scope

## STOP conditions

- The auth helper in `middleware/auth.ts` can't be shared without
  restructuring the middleware → STOP (don't re-implement token comparison
  ad hoc; that's how timing bugs are born).
- prom-client's default registry global state leaks across vitest suites
  (double-registration errors) → use per-instance registries as designed;
  if that still collides, STOP and report the conflict.
- Any temptation to add per-test-name labels (unbounded cardinality) — the
  design deliberately labels by project only.

## Maintenance notes

- Counters are in-process: they reset on restart and under-count in any
  future multi-replica deployment — standard Prometheus practice (`rate()`
  handles restarts), but gauge-vs-counter semantics should be kept in mind
  if the API ever scales horizontally (the ops backlog notes single-instance
  design).
- Every new labeled metric must keep label cardinality bounded (projects
  table = fine; test names/branches = never).
- If a future plan adds request-latency histograms, mount the timing
  middleware BEFORE the routers in `index.ts` and keep `/metrics` itself
  excluded from measurement.
