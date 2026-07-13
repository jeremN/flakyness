# Plan 026: Give the flaky-test tracker its own Playwright suite — and feed its reports to itself

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 38c1eaf..HEAD -- .github/workflows/ci.yml apps/dashboard/package.json pnpm-lock.yaml`
> On a mismatch with the excerpts below, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED — this plan adds a dependency, a CI job, and (deliberately) a class
  of test that can itself be flaky. Read "The joke, and the discipline" below.
- **Depends on**: none. **Lockfile-serial**: adds `@playwright/test`; if another plan
  in flight also adds a dependency, land one at a time.
- **Category**: direction (finding D5) / tests
- **Planned at**: commit `38c1eaf`, 2026-07-13

## Why this matters

Flackyness has **zero end-to-end tests**. Confirmed: no `playwright.config.*`, no
spec files anywhere outside `node_modules`. `.agent/CONTEXT.md` has listed E2E as
pending since June.

Every dashboard test today is a Vitest unit test against a mocked API client. The
actual product — a browser loading a page that server-side-renders data fetched from
a live API — has never been exercised in CI. Plan 008 found a real SSR crash in
`Chart.svelte` only because a smoke test happened to trip over it; that class of bug
is invisible to the current suite.

And there is a second payoff available for almost free: **run the E2E suite, then
ingest its own Playwright report into Flackyness.** That exercises the full ingest
path (real reporter output → parser → DB → flake computation) against genuinely
real data, and it makes the project its own first user.

## The joke, and the discipline

Adding a Playwright suite to a flaky-test tracker is funny right up until the suite
is flaky, at which point it is a liability and someone disables it.

So this plan holds itself to the standard the product exists to enforce:

- **Zero retries in CI.** `retries: 0`. A test that only passes on retry is a flaky
  test, and this project of all projects does not get to hide that.
- **No arbitrary waits.** No `waitForTimeout`, no `sleep`. Use Playwright's
  web-first assertions (`await expect(locator).toBeVisible()`), which retry the
  *assertion*, not the test.
- **Deterministic data.** The suite seeds its own project and ingests a fixed fixture
  before asserting. It never depends on data left behind by another test.
- **Small.** Four or five specs that cover the pages actually shipping. A large
  brittle suite is worse than a small solid one.

If a spec cannot be made deterministic, **delete it and report** rather than
stabilising it with a sleep. That is a STOP condition, not a judgment call.

## Current state

### There is no E2E anything

```
$ git ls-files | grep -iE "playwright.config|e2e|spec\.ts"
(no matches)
```

`apps/dashboard` devDependencies today: `@sveltejs/adapter-node`, `@sveltejs/kit`,
`@sveltejs/vite-plugin-svelte`, `@tailwindcss/vite`, `@types/node`, `svelte`,
`svelte-check`, `tailwindcss`, `typescript`, `vite`, `vitest`. **No Playwright.**

Its scripts:

```json
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
    "test": "svelte-kit sync && vitest run"
```

`test` is the **unit** suite (Vitest) and must stay that way — the E2E suite gets its
own script (`test:e2e`) so `pnpm test` at the root does not start spawning browsers.

### The CI job you will copy from

`.github/workflows/ci.yml` already stands up a real Postgres for the `test` job —
this is the pattern your `e2e` job mirrors (real code):

```yaml
  test:
    name: Tests
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB: flackyness_test
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: test_password
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres -d flackyness_test"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5
    env:
      DATABASE_URL: postgres://postgres:test_password@localhost:5432/flackyness_test
      ADMIN_TOKEN: test-admin-token-for-ci
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7.0.0
      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271  # v6
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e  # v6
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Run database migrations
        run: |
          touch .env
          pnpm db:migrate
      - name: Run API tests
        run: pnpm --filter api test
```

**Actions are pinned to commit SHAs with a `# vN` comment** (plan 010) — match that
convention exactly for any action you add; do not use a floating tag.

### What the dashboard actually renders

Pages that exist and are worth smoke-testing:
`/` (overview), `/flaky`, `/runs`, `/analysis`, `/tests/[testName]`.
The layout has a project selector; pages take a `?project=<uuid>` search param.

## Design decisions (advisor — do not relitigate)

1. **Playwright lives in `apps/dashboard`** as a devDependency, with
   `playwright.config.ts` and specs under `apps/dashboard/e2e/`. Add:
   `CI=true pnpm --filter dashboard add -D @playwright/test` (then a separate
   `CI=true pnpm install --frozen-lockfile` — `pnpm add --frozen-lockfile` does not
   exist). Commit the lockfile.
2. **`retries: 0`**, `forbidOnly: true` in CI, one browser (chromium). No sharding.
3. **The suite drives the REAL stack**: a real Postgres, the real API, and the built
   dashboard (`vite build` + `adapter-node`, i.e. `node build`) — not `vite dev`.
   Preview-mode SSR is what production runs; dev-mode has different behavior and
   would let the exact class of SSR bug plan 008 found slip through again.
   Use Playwright's `webServer` config to start it.
4. **Seed deterministically inside a global setup**: create a project via the admin
   API, ingest `apps/api/fixtures/real-report.json` **three times** (so tests cross
   `minRuns: 3` and a flaky test actually appears), and hand the project id to the
   specs. Do not let specs share mutable state with each other.
5. **The dogfood step is a separate CI step, and it must NOT gate the build.** After
   the E2E run, POST the suite's own `results.json` to the API that CI just stood up,
   and assert a **201**. If that step fails, the E2E job still reports its own
   verdict — dogfooding is a bonus, not a gate. (It is, however, a genuinely strong
   end-to-end test of the ingest path, because the input is real reporter output
   rather than a fixture someone hand-wrote.)
6. **`json` reporter, written to a known path**, plus `html` only on failure. The
   JSON is what gets ingested.
7. **The E2E job runs in CI but is NOT wired into `pnpm test`.** Root `pnpm test`
   must stay fast and browser-free.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Add dep | `CI=true pnpm --filter dashboard add -D @playwright/test` | manifest + lockfile |
| Frozen install | `CI=true pnpm install --frozen-lockfile` | exit 0 |
| Install browsers | `pnpm --filter dashboard exec playwright install --with-deps chromium` | exit 0 |
| Run E2E | `pnpm --filter dashboard test:e2e` | all specs pass, 0 retries |
| Unit tests (unchanged) | `pnpm test` | still green, still browser-free |
| Typecheck dashboard | `pnpm --filter dashboard check` | 0 errors |
| Lint | `rtk proxy pnpm lint` | exit 0 |

**Disposable Postgres** for local runs:

```bash
docker run -d --name flackyness-test-pg-026 \
  -e POSTGRES_PASSWORD=test_password -e POSTGRES_DB=flackyness_test \
  -p 5453:5432 postgres:16-alpine
touch .env
DATABASE_URL=postgres://postgres:test_password@localhost:5453/flackyness_test pnpm db:migrate
```

**ALWAYS** clean up the container, temp `.env`, and any servers. **NEVER**
`docker compose up`. Admin routes are rate-limited **5/min** — pace project creation.

## Scope

**In scope**:
- `apps/dashboard/package.json` + `pnpm-lock.yaml` — `@playwright/test`, `test:e2e` script
- `apps/dashboard/playwright.config.ts` (NEW)
- `apps/dashboard/e2e/**` (NEW) — global setup + specs
- `.github/workflows/ci.yml` — a new `e2e` job (+ the dogfood step)
- `.gitignore` — ignore `playwright-report/`, `test-results/`, and the E2E artifacts
- `AGENTS.md` — one line in the commands table for `test:e2e`

**Out of scope** (do NOT touch):
- Any file under `apps/api/src/**` — if an E2E test fails because of a real API bug,
  **STOP and report it**. Do not fix product code inside a testing plan; that hides
  a real finding inside an unrelated diff.
- `apps/dashboard/src/**` — same rule. A failing E2E test is a *finding*.
- The existing Vitest suites and the root `test` script.
- `action.yml` / the GitHub Action (that is plan 024 — do not touch it or `README.md`).

## Git workflow

Branch `advisor/026-dogfood-e2e-suite`; single-line conventional-commit subject
(e.g. `test(dashboard): add Playwright E2E suite and dogfood its report`); **no
`Co-Authored-By`**; do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Dependency + config

Add `@playwright/test` to `apps/dashboard`. Write `playwright.config.ts`:
`retries: 0`, `forbidOnly: !!process.env.CI`, chromium only, `reporter` = `json`
(to a known path, e.g. `playwright-report/report.json`) + `html` on failure, and a
`webServer` block that builds and serves the dashboard (`node build`) with
`PUBLIC_API_URL` pointed at the API under test. Add the script:

```json
    "test:e2e": "playwright test"
```

**Verify**: `pnpm --filter dashboard check` → 0 errors;
`CI=true pnpm install --frozen-lockfile` → exit 0.

### Step 2: Deterministic seed (global setup)

A Playwright `globalSetup` that: creates a project via the admin API, ingests
`apps/api/fixtures/real-report.json` **three times** (`?branch=main&commit=<40-char
sha>&pipeline=N` — branch/commit/pipeline are **query params**, not body fields), and
exposes the project id to specs (write it to a file, or `process.env`).

Three ingests is not arbitrary: `DEFAULT_CONFIG.minRuns` is 3, so fewer means no test
ever becomes flaky and the `/flaky` page has nothing to assert.

**Verify**: run the setup alone against the disposable Postgres and confirm via
`curl` that the project has runs and at least one `active` flaky test.

### Step 3: The specs (keep them few and solid)

Under `apps/dashboard/e2e/`. Suggested coverage — adjust to what the pages actually
render, and assert on **user-visible text/roles**, not CSS classes:

1. `overview.spec.ts` — `/` renders the seeded project's stats (SSR: assert content
   is present in the initial HTML response, not just after hydration).
2. `flaky.spec.ts` — `/flaky` lists the flaky test the seed produced.
3. `analysis.spec.ts` — `/analysis` renders (this page is the newest and the least
   exercised).
4. `runs.spec.ts` — `/runs` lists the three ingested runs.
5. `chart.spec.ts` — a page containing a chart renders **without a client-side
   console error**. (This is the class of bug plan 008 found: ECharts types must be
   registered in `Chart.svelte`'s `echarts.use([...])` or the chart silently renders
   blank.) Fail the spec on any `pageerror`.

**No `waitForTimeout` anywhere.** Web-first assertions only.

**Verify**: `pnpm --filter dashboard test:e2e` → all pass with **0 retries**. Then run
it **three times in a row** and confirm it passes all three. A suite that passes
once is not yet known to be deterministic.

### Step 4: CI job + dogfood step

Add an `e2e` job to `.github/workflows/ci.yml`, mirroring the `test` job's Postgres
service and env. Steps: install → `playwright install --with-deps chromium` →
migrate → start the API → `pnpm --filter dashboard test:e2e` → **then** the dogfood
step: POST `playwright-report/report.json` to `POST /api/v1/reports?branch=…&commit=…&pipeline=…`
with the seeded project's token, and assert **201**.

The dogfood step must **not** fail the job if it errors (design decision 5) — but it
must print clearly what happened. Upload the HTML report as an artifact on failure.

Pin any new action to a commit SHA with a `# vN` comment, per plan 010.

**Verify**: the workflow YAML parses. You cannot run GitHub Actions locally — so
verify the *job's commands* by running the identical sequence locally against the
disposable Postgres, and say so explicitly in your report.

### Step 5: gitignore + AGENTS.md

Add `playwright-report/`, `test-results/`, and `apps/dashboard/e2e/.artifacts/` (or
whatever paths you actually produce) to `.gitignore`. Add one row to AGENTS.md's
command table for `test:e2e`.

**Verify**: `git status` shows no report/artifact files as untracked.

## Test plan

The specs *are* the test plan. What must hold:

- `pnpm --filter dashboard test:e2e` passes **three consecutive times** with
  `retries: 0`. Paste all three results.
- `pnpm test` (root) is **unchanged**: still green, still fast, still spawns no
  browser.
- The dogfood upload returns **201** and the run is visible afterwards via
  `GET /api/v1/projects/:id/runs`.
- `grep -rn "waitForTimeout\|sleep(" apps/dashboard/e2e/` returns **nothing**.

## Done criteria

- [ ] `@playwright/test` added to `apps/dashboard`; lockfile committed; `CI=true pnpm install --frozen-lockfile` clean
- [ ] `playwright.config.ts` has `retries: 0` and serves the **built** app (not `vite dev`)
- [ ] E2E suite passes **3/3 consecutive local runs**, zero retries, output pasted
- [ ] `grep -rn "waitForTimeout" apps/dashboard/e2e/` → no matches
- [ ] Dogfood: the suite's own `report.json` ingests into the API with **201**
- [ ] Root `pnpm test` unchanged and browser-free; `pnpm --filter dashboard check` 0 errors; `rtk proxy pnpm lint` exit 0
- [ ] `ci.yml` has an `e2e` job; new actions pinned to SHAs with `# vN` comments; YAML parses
- [ ] Report/artifact paths are gitignored; `git status` clean outside scope
- [ ] **No file under `apps/api/src/**` or `apps/dashboard/src/**` modified**

## STOP conditions

- **An E2E test fails because of a real bug in the product.** STOP and report it.
  Do not fix `src/` inside this plan — a real finding buried in a test PR is how bugs
  get lost. (This is a *good* outcome for the plan; it means the suite works.)
- A spec cannot be made deterministic without a `waitForTimeout` or a retry. Delete
  the spec and report it. Do not stabilise it with a sleep.
- Playwright's browser download is blocked in your environment. STOP and report —
  do not switch to a headless-shell hack or a different framework.
- The suite passes once but not three times in a row. That is a flaky test in the
  flaky-test tracker; STOP and report rather than papering over it.

## Maintenance notes

- **`retries: 0` is the point.** Any future pressure to add retries to "stabilise CI"
  is exactly the pathology this product exists to surface. If a spec becomes flaky,
  fix or delete it — and note that Flackyness itself will now be tracking it.
- The dogfood step means the project's own flake data is real data. Whoever operates
  the reference instance gets a live example dataset for free.
- The seed ingests three times because `DEFAULT_CONFIG.minRuns = 3`. If that default
  ever changes, the seed must change with it or `/flaky` will render empty and the
  specs will fail for a confusing reason.
- Deferred: multi-browser coverage, visual regression, and sharding. All premature
  until this suite has been green for a while.
