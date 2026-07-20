# logger.ts coverage + the two /analysis gaps (A2b) — design

**Status:** proposed
**Date:** 2026-07-20
**Sub-project:** A2b of the mutation-testing effort (A1 done → A2a done → **A2b** → A3 → B)

## Context

A2 was "tests for `rate-limit.ts` and `logger.ts`, plus the two coverage gaps
A1 recorded." A2a took the `rate-limit.ts` slice because reading it surfaced a
live security defect. A2b is the remainder:

1. `logger.ts` — audited in A2a (no secret leaks), never tested.
2. The `/analysis` **subset invariant** A1 designed, then removed because no
   fixture in the file could prove it.
3. The `/analysis` **clamp** A1 found unproven (deleting both clamps left the
   suite green).

All three are **test-only**. No product defect was found — verified firsthand,
not assumed (see Findings). This is coverage that closes A1's own IOUs, held to
A1's standard: every assertion falsifiable by a recorded mutation
([[flackyness-test-assertion-standard]]).

## Findings — two suspected logger defects, both disproved

Before designing tests, two behaviours were probed to make sure this isn't
secretly a bug-fix job:

**F1 — Does `requestLogger` skip the "completed" log when `next()` throws?**
*No.* Probed: a handler that `throw`s an `HTTPException` still produces both a
"Request started" and a "Request completed" log (started=1, completed=1). Hono's
`app.onError` converts the throw into a response before it propagates back
through `await next()`, so lines 93-97 run normally with the error status. The
app always mounts `onError` (`index.ts:40`), so there is no observability gap.
No fix.

**F2 — Does `logError` leak a stack trace in production?**
*No.* Probed with `NODE_ENV=production` (via `vi.resetModules()` + re-import):
`logError` emits valid JSON, `error.stack` is absent, and a planted
`secret/path/file.ts` string does not appear in the output. The `isDev ?
err.stack : undefined` gate holds. No fix.

A byproduct worth a test comment, not a fix: in **dev**, `formatLog` prints
only `error.message` (line 33), so the stack it stores is never displayed
either. The stack is thus surfaced nowhere today — harmless (prod correctly
omits it; dev just doesn't show it), but the tests document it so a future
reader isn't surprised.

## Decisions

**D1 — Test `logger.ts` via console spies + `vi.resetModules()`; do NOT
refactor it.** Unlike A2a, where a build-time `VITEST` branch hid a real bug and
a runtime flag was needed to exercise the *real router mounting*, `logger.ts`'s
one build-time branch (`isDev`) is fully reachable by re-importing the module
under a different `NODE_ENV` — **probed to work**. A re-import captures
everything the module does; there is no analog to A2a's "real mounting" property
that a re-import would miss. Refactoring here would be change for its own sake.

**D2 — The subset-invariant fixture is a SINGLE mixed ingest, not three.**
Probed end-to-end: one report with two specs, each carrying **three `tests[]`
entries** (the shape that reaches `minRuns = 3` in one upload — see
`reports.test.ts:601` and its trap comment), yields
`allTests = [A-flaky (isFlaky:true, 3 runs), B-stable (isFlaky:false, 3 runs)]`,
`flakyTests = [A-flaky]`. That is exactly the shape the invariant needs: a
non-flaky test present in `allTests` but absent from `flakyTests`, so the
`flakyTests: analysis` mutation makes `every(isFlaky)` fail. The naive shape
(three `results[]` in one `tests[]` entry) collapses to one row and yields an
empty analysis — probed, and rejected.

**D3 — The subset test uses its OWN project, not `testProjectId`.**
`testProjectId` never ingests (that is A1's "empty analysis" case, which stays).
The invariant needs data, so the new test provisions a dedicated project with
the mixed fixture, self-contained.

**D4 — `/analysis` reads `test_results` synchronously, so no `wait=true` and no
reconcile race.** `analyzeFlakiness` queries `test_results` (written during
ingest, before the 201), not `flaky_tests` (the un-awaited reconcile). So the
analysis reflects the ingest immediately — verified. This test does not touch
the AGENTS.md reconcile sharp edge.

**D5 — Every assertion ships with a recorded mutation proof** (A1's standard).

## Fixes and tests

### `middleware/logger.test.ts` (new)

Spy on `console.log/warn/error` (restore after each). Assert on the captured
strings.

1. **Status → level routing in `requestLogger`.** Drive a Hono app through
   `requestLogger()` with handlers returning 200, 404, 500; assert the
   "Request completed" line went to `console.log` (info), `console.warn`
   (warn), `console.error` (error) respectively, and carries `method`, `path`,
   `status`, and a numeric `duration`.
   *Mutation:* change `status >= 500` to `status >= 600` (or the 400 threshold)
   → the 500/404 case routes to the wrong console fn and the assertion reds.

2. **`requestLogger` sets a request id and logs start.** Assert a "Request
   started" line is emitted and `c.get('requestId')` is a non-empty string
   after the middleware runs.
   *Mutation:* delete `c.set('requestId', requestId)` → the id assertion reds.

3. **`logError` carries context and the error message.** In the default
   (test/dev) env, assert the output contains the method, path, requestId, and
   the error's `message`. **Note (probed): the dev `formatLog` prints only
   `error.message`, not `error.name`** (line 33), so `name` is asserted in the
   prod-JSON path (test 4), not here.
   *Mutation:* drop `message: err.message` from `logError`'s error object → reds.

4. **`logError` omits the stack in production (security property).** Re-import
   the module under `NODE_ENV=production` (`vi.resetModules()`), call
   `logError` with an error whose `.stack` contains a sentinel path; assert the
   emitted JSON parses, carries `error.name` and `error.message`, has **no**
   `error.stack`, and the sentinel path does not appear anywhere in the string.
   *Mutation:* change `stack: isDev ? err.stack : undefined` to
   `stack: err.stack` → the prod output leaks the sentinel and the test reds.
   **This is the load-bearing security proof of the file.**

5. **Format: prod is JSON, dev is not.** Under `NODE_ENV=production` a log line
   is valid `JSON.parse`-able; under the default env it is the pretty prefix
   form (`[timestamp] LEVEL …`) and is *not* valid JSON.
   *Mutation:* force `formatLog` to always take the JSON branch → the dev-format
   assertion reds.

### `routes/projects.test.ts` — `/analysis` clamp (append)

Within the existing `GET /api/v1/projects/:id/analysis` describe (or a sibling),
against `testProjectId` (data-independent — the clamp runs before aggregation):

6. **Out-of-range params are clamped.** `?days=999` → `windowDays === 90`;
   `?threshold=5` → `threshold === 1`. (Also note in a comment: `?days=0`
   resolves to the default, not 1, because `parseInt('0') || default` swallows
   0 — intended, matches the trend endpoint's documented care.)
   *Mutation:* remove the outer `Math.min(..., 90)` → `windowDays === 999`, reds;
   remove the `Math.min(Math.max(rawThreshold,0),1)` clamp → `threshold === 5`,
   reds. A1 confirmed deleting both clamps leaves the rest of the suite green,
   so these are the only tests that catch it.

### `routes/projects.test.ts` — subset invariant (append)

7. **The flaky-subset invariant, on a populated project.** Provision a dedicated
   project, ingest the single mixed report (A-flaky: passed/passed/failed;
   B-stable: passed×3, each as a separate `tests[]` entry). Then `GET /analysis`
   and assert:
   - `allTests.length >= 2` and **at least one `allTests` entry has
     `isFlaky === false`** (anti-vacuity — without a non-flaky test present the
     invariant is vacuous, the trap A1 fell into).
   - `flakyTests.every(t => t.isFlaky) === true`.
   - every `flakyTests` name is in `allTests` (subset).
   *Mutation:* change the endpoint's `flakyTests: analysis.filter(t => t.isFlaky)`
   to `flakyTests: analysis` → `flakyTests` now includes B-stable →
   `every(isFlaky)` reds. This is the proof A1 could not obtain.

## Scope

**In:** a new `logger.test.ts`; appended tests in `projects.test.ts` for the
clamp and the subset invariant.

**Out:** any `logger.ts` change (no bug found — F1/F2); any `projects.ts`
change (the endpoint is correct; only its tests were missing); A3 (`.svelte`
components) and B (Stryker). If a mutation reveals a real product bug, it is
reported, not fixed here.

## Testing strategy

`logger.test.ts` is DB-independent — pure console-spy unit tests — so it runs in
every CI job, not only the DB-backed one. The `projects.test.ts` additions are
DB-gated like the rest of that file. Each assertion names its mutation; the
controller re-verifies the two probed findings (F1/F2) and the fixture shape
firsthand before accepting.

## Risks

- **`vi.resetModules()` bleed.** Re-importing `logger.ts` under a changed
  `NODE_ENV` must restore both the env var and the module registry so later
  tests see the normal module. Mitigated: set/restore `NODE_ENV` around the
  re-import and rely on Vitest's per-file isolation; keep the prod-path cases
  last in the file or fully self-contained.
- **Console-spy leakage.** A spy that isn't restored swallows later test output.
  Mitigated: `afterEach(() => vi.restoreAllMocks())`.
- **Fixture drift.** The subset fixture depends on `minRuns = 3` and the
  three-`tests[]`-entry shape. If either changes, the analysis goes empty and
  the anti-vacuity guard reds loudly (not silently) — which is the correct
  failure.

## Success criteria

- `logger.ts` has tests for status routing, context, the prod stack-omission
  security property, and the format switch — each mutation-proven.
- Both A1 `/analysis` gaps are closed with mutation-proven tests.
- No product source changed. `pnpm --filter api test` green; lint + typecheck
  clean.
