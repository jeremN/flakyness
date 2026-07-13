# Plan 001: Make the parser ingest real Playwright JSON reports

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f8b0cc..HEAD -- apps/api/src/parsers/ apps/api/src/routes/reports.ts apps/api/fixtures/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `0f8b0cc`, 2026-07-10

## Why this matters

Flackyness exists to ingest Playwright JSON reports from CI. The parser at
`apps/api/src/parsers/playwright.ts` reads test attempts from `spec.results`,
but the real Playwright JSON reporter (`--reporter=json`) nests attempts under
`spec.tests[].results` — `results` never appears directly on a spec. Worse,
the zod schema validates `spec.tests[]` entries against a shape that requires
`title` and `ok`, fields real test entries do not have, so **every genuine
Playwright report is rejected with a 400** ("Failed to parse Playwright
report"). Only the hand-simplified fixtures in `apps/api/fixtures/` parse.
The core product function does not work on real input, and the passing test
suite gives false confidence because it only exercises the fixture shape.

This plan also fixes two adjacent parser defects while the file is open:
an error-message extraction bug, and missing size bounds on ingested strings
(defense-in-depth for a 10MB untrusted-JSON endpoint).

## Current state

Files:

- `apps/api/src/parsers/playwright.ts` — zod schema + parser. The whole file is in scope.
- `apps/api/src/routes/reports.ts` — ingestion route; calls `parsePlaywrightReport` (line 62); query schema at lines 20–24.
- `apps/api/fixtures/sample-report.json` — the only realistic-looking fixture; uses the WRONG simplified shape (`results` directly on specs).
- `apps/api/src/parsers/playwright.test.ts` — tests, currently only exercising the simplified shape.
- `apps/api/src/db/schema.ts` — column widths the parser output must respect: `test_name varchar(500)`, `test_file varchar(500)` (lines 41–42), `error_message text` (line 47); `test_runs.branch varchar(255)`, `pipeline_id varchar(100)` (lines 19, 21).

Key excerpts as of `0f8b0cc`:

`apps/api/src/parsers/playwright.ts:72-94` — `TestCaseSchema` requires `title`
and `ok`, and reuses ITSELF for the `tests` array (wrong shape):

```ts
const TestCaseSchema: z.ZodType<TestCaseType> = z.object({
  title: z.string(),
  ok: z.boolean(),
  tags: z.array(z.string()).optional(),
  tests: z.lazy(() => z.array(TestCaseSchema)).optional(),   // <-- wrong: real entries lack title/ok
  ...
  results: z.array(TestResultSchema).optional(),
  ...
});
```

`apps/api/src/parsers/playwright.ts:284-287` — the parse loop reads
`spec.results` and never looks at `spec.tests`:

```ts
for (const { spec, file, titlePath } of allSpecs) {
    if (!spec.results || spec.results.length === 0) {
      continue;
    }
```

`apps/api/src/parsers/playwright.ts:250-260` — `extractErrorMessage` returns
`null` prematurely: if the FIRST result with a non-empty `errors` array has an
entry without `message`, it returns `null` instead of scanning later results:

```ts
function extractErrorMessage(results: TestResult[]): string | null {
  for (const result of results) {
    if (result.error?.message) {
      return result.error.message;
    }
    if (result.errors && result.errors.length > 0) {
      return result.errors[0].message || null;   // <-- early null return
    }
  }
  return null;
}
```

`apps/api/src/routes/reports.ts:20-24` — query schema; `branch` and `pipeline`
have no `.max()` even though their DB columns are varchar(255)/varchar(100):

```ts
const reportQuerySchema = z.object({
  branch: z.string().min(1).default('main'),
  commit: z.string().min(1).max(40),
  pipeline: z.string().optional(),
});
```

### The real Playwright JSON reporter shape (authoritative for this plan)

Produced by `npx playwright test --reporter=json`. Relevant subset:

```jsonc
{
  "config": { ... },
  "suites": [
    {
      "title": "auth.spec.ts",        // file-level suite
      "file": "auth.spec.ts",
      "specs": [ ... ],               // may be empty
      "suites": [                     // nested describe() suites
        {
          "title": "Login flow",
          "specs": [
            {
              "title": "should login",
              "ok": true,
              "tags": [],
              "tests": [              // ONE ENTRY PER PLAYWRIGHT PROJECT (browser)
                {
                  "timeout": 30000,
                  "annotations": [],
                  "expectedStatus": "passed",
                  "projectId": "chromium",
                  "projectName": "chromium",
                  "results": [        // ONE ENTRY PER ATTEMPT (retries)
                    {
                      "workerIndex": 0,
                      "status": "passed",   // passed|failed|timedOut|skipped|interrupted
                      "duration": 2500,
                      "errors": [],
                      "stdout": [], "stderr": [],
                      "retry": 0,
                      "startTime": "2026-07-01T10:00:00.000Z",
                      "attachments": []
                    }
                  ],
                  "status": "expected"  // skipped|expected|unexpected|flaky
                }
              ],
              "id": "abc-123",
              "file": "auth.spec.ts",
              "line": 5,
              "column": 5
            }
          ]
        }
      ]
    }
  ],
  "errors": [],
  "stats": { "startTime": "...", "duration": 12345, "expected": 10, "unexpected": 1, "flaky": 1, "skipped": 0 }
}
```

Critical differences from the current code's assumptions:

1. Attempts live at `spec.tests[].results[]`, not `spec.results[]`.
2. `spec.tests[]` entries have NO `title` and NO `ok` — they have
   `timeout`, `annotations`, `expectedStatus`, `projectId`, `projectName`,
   `results`, `status`.
3. A spec can have multiple `tests[]` entries (one per Playwright project /
   browser). Each is an independent execution of the same spec.

Repo conventions to match: zod for all validation; no `console.log` (use the
structured `logger` from `apps/api/src/middleware/logger.ts` if logging is
needed — the parser currently does not log and should stay pure); strict TS
(`strict: true` in root tsconfig).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck API | `pnpm --filter api exec tsc --noEmit` | exit 0, no output |
| API unit tests | `pnpm --filter api test` | all pass (integration suites auto-skip without `DATABASE_URL`) |
| Lint | `pnpm lint` | exit 0 |

Parser tests are pure (no DB needed) — `pnpm --filter api test` runs them
unconditionally.

## Scope

**In scope** (the only files you should modify/create):
- `apps/api/src/parsers/playwright.ts`
- `apps/api/src/parsers/playwright.test.ts`
- `apps/api/src/routes/reports.ts` (ONLY the `reportQuerySchema` bounds in Step 5)
- `apps/api/fixtures/real-report.json` (create)
- `apps/api/fixtures/real-report-edge-cases.json` (create)

**Out of scope** (do NOT touch):
- `apps/api/src/services/flakiness.ts` — downstream consumer; its input type
  `ParsedTestResult` must NOT change shape.
- `apps/api/fixtures/sample-report.json` and the other existing fixtures — the
  simplified shape stays supported (backward compat); existing tests must keep passing.
- `apps/api/src/db/schema.ts` — no schema/migration changes in this plan.
- `docs/API.md`, `.gitlab-ci.yml.example` — covered by plan 003.

## Git workflow

- Branch: `advisor/001-parser-real-playwright-format`
- Conventional-commit, single-line subject only (repo style, e.g.
  `fix(api): parse real Playwright JSON reporter format`). Do NOT add any
  `Co-Authored-By` trailer. Do not push or open a PR unless the operator
  instructed it.

## Steps

### Step 1: Create a real-format fixture

Create `apps/api/fixtures/real-report.json` following the "real Playwright
JSON reporter shape" above exactly. It must contain, across 2 file-level
suites (one with a nested describe suite):

1. A passing test (1 result, `status: "passed"`).
2. A flaky test: results `[{status:"failed", retry:0, errors:[{message:"Expected X", stack:"..."}]}, {status:"passed", retry:1}]`, test-level `status: "flaky"`.
3. A failing test: results `[{status:"failed"}, {status:"timedOut", retry:1}]`, test-level `status: "unexpected"`.
4. A skipped test: results `[{status:"skipped"}]`.
5. A test whose FIRST failed result has `errors: [{}]` (an entry with no
   `message`) and whose SECOND result has `errors: [{message:"real message"}]`
   — regression fixture for Step 4.
6. One spec with TWO `tests[]` entries (`projectName: "chromium"` and
   `projectName: "firefox"`), chromium passing, firefox failing.

Every `results[]` entry needs `workerIndex`, `status`, `duration`, `retry`,
`startTime` (the current `TestResultSchema` requires them — keep that).

Create `apps/api/fixtures/real-report-edge-cases.json` with: a suite with an
empty `specs: []`; a spec with `tests: []`; a spec whose test entry has
`results: []`; a spec with no `location` (name derivation falls back to the
suite `file`); a deeply nested suite chain (3 levels).

**Verify**: `node -e "JSON.parse(require('fs').readFileSync('apps/api/fixtures/real-report.json','utf8')); JSON.parse(require('fs').readFileSync('apps/api/fixtures/real-report-edge-cases.json','utf8')); console.log('ok')"` → prints `ok`

### Step 2: Fix the zod schema

In `apps/api/src/parsers/playwright.ts`:

1. Add a `TestEntrySchema` matching the real `spec.tests[]` entry shape (all
   fields optional except none — be permissive; Playwright adds fields across
   versions):

```ts
const TestEntrySchema = z.object({
  timeout: z.number().optional(),
  annotations: z.array(z.object({ type: z.string().max(200), description: z.string().max(2000).optional() })).optional(),
  expectedStatus: z.string().optional(),
  projectId: z.string().max(200).optional(),
  projectName: z.string().max(200).optional(),
  results: z.array(TestResultSchema).optional(),
  status: z.string().optional(),
});
```

2. In `TestCaseSchema` (and its `TestCaseType` interface), change
   `tests: z.lazy(() => z.array(TestCaseSchema)).optional()` to
   `tests: z.array(TestEntrySchema).optional()` and update the interface
   accordingly (`tests?: z.infer<typeof TestEntrySchema>[]`). Note: once
   `TestCaseSchema` no longer references itself, the `z.lazy` wrapper and the
   explicit `z.ZodType<TestCaseType>` annotation for it may become removable —
   remove them only if `tsc` stays clean.

3. Add bounds (Step 5's rationale — untrusted 10MB input):
   - `TestErrorSchema` (lines 51–56): `.max(10_000)` on `message`, `stack`,
     `value`, `snippet`.
   - `title` fields in `TestCaseSchema`/`SuiteSchema`/`TestStepSchema`: `.max(1000)`.

**Verify**: `pnpm --filter api exec tsc --noEmit` → exit 0

### Step 3: Parse `spec.tests[].results` (with backward compat)

In `parsePlaywrightReport` (currently lines 272–337), replace the per-spec
logic so that for each extracted spec:

1. Build the list of "executions": if `spec.tests` is a non-empty array, each
   entry with a non-empty `results` array is one execution
   `{ results, projectName }`. Otherwise, if `spec.results` is non-empty
   (legacy/simplified shape), the single execution is
   `{ results: spec.results, projectName: undefined }`. If neither, `continue`
   (unchanged skip behavior).
2. Compute once per report, before the loop: the set of distinct
   `projectName`s across all executions. If there are ≥ 2 distinct names,
   suffix each execution's test name with ` [${projectName}]`
   (e.g. `Login flow › should login [firefox]`); with 0–1 distinct names, no
   suffix (keeps names stable for existing single-project users).
3. For each execution, produce one `ParsedTestResult` exactly as the current
   code does per spec (reuse `determineStatus`, `calculateDuration`,
   `extractErrorMessage`, retryCount = `results.length - 1`, the
   startedAt/finishedAt tracking, and the `testFile` fallback chain
   `spec.location?.file || file || spec.file || ''`).
4. Truncate before returning: `testName` and `testFile` to 500 chars,
   `errorMessage` to 10_000 chars (`schema.ts` columns are varchar(500) /
   varchar(500) / text — over-length varchars currently cause a 500 from
   Postgres). Add a small local helper, e.g.
   `const clamp = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s)`.

Do NOT change the `ParsedTestResult` / `ParsedReport` interfaces.

**Verify**: `pnpm --filter api exec tsc --noEmit` → exit 0

### Step 4: Fix `extractErrorMessage`

Change the early return so the loop keeps scanning when a result's `errors`
entries carry no message:

```ts
function extractErrorMessage(results: TestResult[]): string | null {
  for (const result of results) {
    if (result.error?.message) return result.error.message;
    const withMessage = result.errors?.find((e) => e.message);
    if (withMessage?.message) return withMessage.message;
  }
  return null;
}
```

**Verify**: `pnpm --filter api exec tsc --noEmit` → exit 0

### Step 5: Bound `branch`/`pipeline` query params

In `apps/api/src/routes/reports.ts` lines 20–24, add `.max(255)` to `branch`
and `.max(100)` to `pipeline` (matching `test_runs.branch varchar(255)` and
`pipeline_id varchar(100)` in `apps/api/src/db/schema.ts:19,21`). Over-length
values then get a clean 400 from `zValidator` instead of a 500 from Postgres.

**Verify**: `pnpm --filter api exec tsc --noEmit` → exit 0

### Step 6: Tests

Extend `apps/api/src/parsers/playwright.test.ts` (keep every existing test —
they cover the legacy shape, which must keep working). Model new tests on the
existing ones in that file (plain vitest `describe`/`it`, fixture loaded via
`readFileSync` + `JSON.parse`). Add:

- `parses the real Playwright reporter format` — parse
  `fixtures/real-report.json`; assert `totalTests > 0` and the exact expected
  counts for passed/failed/skipped/flaky given the fixture from Step 1
  (compute them from what you authored; the flaky test must come out
  `status: 'flaky'`, the failed+timedOut one `failed`).
- `derives one result per project entry and suffixes names when multi-project`
  — the chromium+firefox spec yields 2 results named `... [chromium]` and
  `... [firefox]`, with correct per-project statuses.
- `does not suffix names for single-project reports` — for a report where all
  executions share one projectName, assert no `[` in any `testName`.
- `scans past message-less errors entries` — the Step 1 fixture #5 test's
  `errorMessage` equals `"real message"`.
- `handles edge cases without crashing` — parse
  `fixtures/real-report-edge-cases.json`; assert it returns (no throw) and
  specs with no results are skipped.
- `truncates oversized names and error messages` — build an in-memory report
  object with a 600-char title and a 20k-char error message; assert
  `testName.length <= 500` and `errorMessage.length <= 10_000`.
- `rejects strings beyond schema bounds` — an error `message` over 10_000
  chars inside the report makes `parsePlaywrightReport` throw a ZodError.
  (Note: schema bound rejects; the Step 3 clamp is for values under the zod
  cap that still exceed DB columns after name-path joining.)

**Verify**: `pnpm --filter api test` → all pass, including the 7+ new tests; no previously-passing test fails.

## Test plan

Covered by Step 6. Structural pattern: existing `playwright.test.ts`.
Full gate: `pnpm --filter api test` (parser suite runs without a DB) and
`pnpm lint`.

## Done criteria

ALL must hold:

- [ ] `pnpm --filter api exec tsc --noEmit` exits 0
- [ ] `pnpm --filter api test` exits 0; new real-format tests exist and pass
- [ ] `pnpm lint` exits 0
- [ ] `apps/api/fixtures/real-report.json` exists and a test parses it with `totalTests > 0`
- [ ] Existing simplified-shape fixture tests still pass (backward compat intact)
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the "Current state" locations doesn't match the excerpts (drift).
- You have access to a real `npx playwright test --reporter=json` output and it
  contradicts the shape documented in this plan (e.g. no `tests[]` on specs) —
  report the discrepancy; do not guess a third shape.
- Making the multi-project suffix work requires changing the
  `ParsedTestResult` interface or anything in `services/flakiness.ts`.
- Existing tests fail for reasons unrelated to your change, twice in a row.

## Maintenance notes

- Plan 003 (docs) updates the GitLab CI example whose uploads only start
  working end-to-end once this plan lands — verify them together if possible.
- The ` [projectName]` suffix is a naming contract: once real data exists,
  changing it splits test histories. A reviewer should explicitly sign off on
  the suffix format.
- Deferred deliberately: strict caps on total spec/suite counts (the 10MB
  `bodyLimit` in `apps/api/src/index.ts:30-35` is the outer bound today);
  parsing `spec.tests[].annotations`/`tags` into storage is a direction item
  (see the audit's DIR-04), not this plan.
