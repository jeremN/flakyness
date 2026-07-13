# Plan 017: Ingest JUnit XML reports alongside Playwright JSON

> **Executor instructions**: Follow step by step; run every verification
> command. On any STOP condition, stop and report. Update your row in
> `plans/README.md` when done — unless a reviewer dispatched you and said
> they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7609d55..HEAD -- apps/api/src/routes/reports.ts apps/api/src/parsers/ apps/api/package.json`
> Plan 015 may have added `tags`/`annotations` to `ParsedTestResult` — if so,
> your JUnit parser emits empty arrays for them. If `reports.ts` no longer
> reads the body via a single JSON call, re-read it before Step 2.

## Status

- **Priority**: P2
- **Effort**: M–L
- **Risk**: MED (new dependency; touches the ingest entry point; format sniffing must not regress the JSON path)
- **Depends on**: 015 (soft — same files `reports.ts`/parsers; land after it to avoid conflicts). **Serial constraint with 018**: both add a dependency → lockfile conflicts; land 017 before 018.
- **Category**: feature (direction D3)
- **Planned at**: commit `7609d55`, 2026-07-10

## Why this matters

Flackyness only ingests Playwright JSON — `apps/api/src/routes/reports.ts`
hardcodes `parsePlaywrightReport(rawReport)` on a `c.req.json()` body.
JUnit XML is the lingua franca of CI test output (Jest via jest-junit,
pytest, Go, JUnit/Surefire, Cypress, …): accepting it turns Flackyness from
a Playwright-only tool into a general flaky-test tracker. The internal
contract barely changes — everything downstream of the parser consumes
`ParsedReport`, which stays identical.

## Current state

- `apps/api/src/routes/reports.ts` (139 lines): `projectAuth()` +
  `reportRateLimit`; query params validated by zod
  (branch ≤255 default `main` / commit ≤40 required / pipeline ≤100); body:
  `await c.req.json()` in a try/catch returning
  `{ error: 'Invalid JSON body' }` 400; then
  `parsePlaywrightReport(rawReport)` (throws → 400 with parser message);
  then one transaction inserting `test_runs` + chunked `test_results`;
  fire-and-forget `updateFlakyTests`; 201 with a summary.
- `apps/api/src/parsers/playwright.ts` — exports
  `parsePlaywrightReport(raw: unknown): ParsedReport`.
  `ParsedReport = { totalTests, passed, failed, skipped, flaky, startedAt, finishedAt, durationMs, results: ParsedTestResult[] }`;
  `ParsedTestResult = { testName, testFile, status: 'passed'|'failed'|'skipped'|'flaky', durationMs, retryCount, errorMessage: string | null }`
  (+ `tags`/`annotations` if plan 015 landed). Name/file clamps: 500 chars;
  error message clamp 10_000.
- There is a body-size limit middleware on the app (`bodyLimit` in
  `src/index.ts`) — XML passes through it the same as JSON; no change needed.
- `apps/api/package.json` — no XML dependency. Workspace rules: pnpm 11,
  `minimumReleaseAge: 1440`, adding a dep needs
  `CI=true pnpm --filter api add fast-xml-parser --no-frozen-lockfile`
  (no-TTY prompts otherwise).
- CI runs `pnpm install --frozen-lockfile` — commit `pnpm-lock.yaml` with
  the dep.

## Design decisions (advisor — do not relitigate)

1. Dependency: `fast-xml-parser` (pure JS, no install scripts, mature —
   safe under the workspace's `allowBuilds` policy).
2. Format detection at the ROUTE, by content: read the body ONCE as text
   (`await c.req.text()`), trim, then: starts with `<` → JUnit path;
   otherwise `JSON.parse` → Playwright path (JSON.parse failure keeps the
   exact existing `Invalid JSON body` 400). Content-Type is logged but NOT
   trusted for dispatch (CI uploaders lie about it constantly).
3. New `apps/api/src/parsers/junit.ts`:
   `parseJUnitReport(xml: string): ParsedReport` — same output contract, so
   `reports.ts` after the branch point is UNTOUCHED.
4. Status mapping per `<testcase>`: has `<failure>` or `<error>` child →
   `failed`; has `<skipped>` → `skipped`; else `passed`. **No `flaky`
   status and `retryCount: 0` always** — JUnit has no retry semantics;
   flakiness emerges across runs via `updateFlakyTests` (rate =
   (failed+flaky)/total), which is exactly how the product already works.
   Document this in API.md.
5. Field mapping: `testName` = `classname + ' › ' + name` (just `name` when
   classname is empty/missing); `testFile` = testcase `file` attr, else
   testsuite `file` attr, else `classname`, else `''`; `durationMs` =
   `Math.round(time * 1000)` (attr is seconds, may be absent → 0);
   `errorMessage` = failure/error node's `message` attr + text content,
   clamped to 10_000 like the Playwright parser. Apply the same 500-char
   name/file clamps.
6. Structure tolerance: accept both `<testsuites>` root and single
   `<testsuite>` root; suites may nest. `startedAt`/`finishedAt`: use the
   root/first `timestamp` attr when parseable, else `new Date()` at parse
   time (matches how the Playwright parser falls back — check and mirror);
   `durationMs` from the root `time` attr else sum of suites.
7. Payload guards (the XML analog of the JSON zod clamps): reject >50_000
   testcases with a clear message; `fast-xml-parser` config must disable
   entity processing (`processEntities: false`) — XXE/entity-expansion
   defense; no DTD honoring.

## Commands you will need

Add dep: `CI=true pnpm --filter api add fast-xml-parser --no-frozen-lockfile`.
Typecheck `pnpm --filter api exec tsc --noEmit`; tests `pnpm --filter api test`
(DB-gated needs `DATABASE_URL`+`ADMIN_TOKEN`); lint `pnpm lint` (garbled →
`rtk proxy pnpm lint`). Disposable DB:
`docker run -d --name flackyness-test-pg-017 -e POSTGRES_PASSWORD=test_password -e POSTGRES_DB=flackyness_test -p 5438:5432 postgres:16-alpine`,
`touch .env` at root, `DATABASE_URL=postgres://postgres:test_password@localhost:5438/flackyness_test pnpm db:migrate`.
ALWAYS clean up container + temp `.env`. Never `docker compose up`.

## Scope

**In scope**: `apps/api/package.json` + `pnpm-lock.yaml` (the one dep), NEW
`apps/api/src/parsers/junit.ts` + `junit.test.ts`, NEW fixture(s)
`apps/api/fixtures/junit-*.xml`, `apps/api/src/routes/reports.ts` (body
reading + dispatch ONLY — nothing below the parse call), its test file,
`docs/API.md` + `docs/GETTING_STARTED.md` (JUnit upload example, e.g.
`--data-binary @report.xml`).

**Out of scope**: `parsers/playwright.ts` (zero edits); schema/migrations;
the flakiness service; dashboard; retry/flaky inference for JUnit (v2 at
most — some emitters output reruns as duplicate testcases; do NOT guess).

## Git workflow

Branch `advisor/017-junit-xml-ingestion`; single-line conventional commits
(e.g. `feat(api): ingest JUnit XML reports`); NO `Co-Authored-By` trailers;
no push/PR unless the operator instructed it.

## Steps

### Step 1: Dependency + fixtures

Add `fast-xml-parser`. Create fixtures: `junit-basic.xml`
(`<testsuites>` with 2 suites — passed, failed-with-message, skipped,
missing-time cases), `junit-single-suite.xml` (`<testsuite>` root), and a
malformed one for negative tests. Base them on real emitter output (jest-junit
/ pytest format — plain, no exotic attributes).

### Step 2: Parser

`parsers/junit.ts` per design decisions 3–7. Zod-validate the PARSED object
shape (mirror the Playwright parser's philosophy: zod at the boundary,
clamps, explicit error messages) rather than trusting fast-xml-parser's
output blindly. Configure the parser:
`new XMLParser({ ignoreAttributes: false, processEntities: false })` — and
handle the single-child quirk (fast-xml-parser yields an object instead of
an array for one `<testcase>`; normalize with a small `toArray` helper).

Unit tests (`junit.test.ts`, style-matched to `playwright.test.ts`): counts
per status; name/file/duration/error mapping incl. clamps; single-suite
root; single-testcase normalization; missing time → 0; malformed XML →
throws with clear message; entity payload (`<!DOCTYPE … <!ENTITY …>`) does
NOT expand (assert the literal text or a parse rejection — never expansion);
>50k testcases rejected (generate synthetically in the test). If plan 015
landed: `tags: []`/`annotations: []` present on every result.

**Verify**: `pnpm --filter api test` (no-DB fine for parser tests) → pass;
tsc → 0.

### Step 3: Route dispatch

In `reports.ts`, replace the body-read block only:

```ts
let parsedReport: ParsedReport;
const bodyText = await c.req.text();
if (bodyText.trimStart().startsWith('<')) {
  // JUnit XML path
  parsedReport = parseJUnitReport(bodyText); // wrap: parse errors → 400 like the JSON path
} else {
  let rawReport: unknown;
  try {
    rawReport = JSON.parse(bodyText);
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  parsedReport = parsePlaywrightReport(rawReport);
}
```

Keep the existing try/catch structure and error-shape EXACTLY for the JSON
path (existing tests pin it); give the XML path symmetric 400s. Everything
from the transaction down is untouched.

Route tests: existing JSON ingest tests still green UNMODIFIED; new
DB-gated cases — XML upload → 201 with correct summary counts and
`test_results` rows (status/duration/error persisted); malformed XML → 400;
JSON-with-leading-whitespace still hits the JSON path; a body of `"   "` →
400.

**Verify**: DB-env `pnpm --filter api test` → all green.

### Step 4: Flakiness e2e + docs

DB-gated integration: upload `junit-basic.xml` 3× (different `commit`s)
where a testcase fails in 1 of 3 → after reconcile, an active `flaky_tests`
row exists for it (rate 0.33 ≥ 0.05, runs 3 ≥ 3). This proves the
cross-format promise: JUnit tests become flaky via rate-over-runs despite
`retryCount: 0`.

Docs: API.md — formats section (detection by body content, JUnit status
mapping table, no-retry note); GETTING_STARTED — a JUnit curl example next
to the Playwright one (`--data-binary @junit.xml`, same auth/query params).

## Done criteria

- [ ] `fast-xml-parser` in api deps; lockfile updated; `CI=true pnpm install --frozen-lockfile` green from clean state
- [ ] `parseJUnitReport` returns the `ParsedReport` contract; unit tests cover mapping, clamps, malformed, entity-defense, size cap
- [ ] Route sniffs by content; JSON path byte-identical behavior (old tests pass unmodified)
- [ ] 3-upload flakiness e2e green; docs updated with JUnit example
- [ ] Gates: api tsc + tests (both modes), `pnpm lint`; `git status` clean outside scope

## STOP conditions

- `reports.ts` body handling differs structurally from the excerpt → re-read;
  if the single-read-then-parse refactor isn't possible without touching the
  transaction code, STOP.
- `fast-xml-parser` install is blocked by `minimumReleaseAge` (a release
  <24h old) → pin the previous version; if THAT fails, STOP.
- Ambiguity about rerun-encoded flakiness in JUnit fixtures → do NOT infer;
  it's declared out of scope.

## Maintenance notes

- The sniff (`<` prefix) is the extension seam — a future format (e.g.
  Mocha JSON, TAP) slots in the same dispatch block; keep parser modules
  format-named and route logic format-agnostic below the parse call.
- If plan 015's tags land, JUnit `<properties>` could map to tags in v2 —
  deliberately skipped now.
- Entity processing must STAY disabled in the XMLParser config — treat any
  future config change there as security-sensitive in review.
