# Phase B — Stryker Nightly Mutation Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate the A1–A3b "every assertion is mutation-provable" property with a nightly Stryker run that reports a broad mutation score per package and fails only when the hardened file set regresses.

**Architecture:** Two per-package Stryker runs (`apps/api`, `apps/dashboard` `$lib` only), each driven by a Stryker-only `vitest.stryker.config.ts` that overrides `pool: 'threads'` (the normal `forks`-based `pnpm test` is untouched). A single root `scripts/mutation-gate.mjs` post-parses each package's `mutation.json` and enforces per-file floors over the hardened set. A nightly `.github/workflows/mutation.yml` (schedule + manual) provisions Postgres for the API run, uploads the HTML reports, and runs the gate.

**Tech Stack:** Stryker (`@stryker-mutator/core` + `@stryker-mutator/vitest-runner`), Vitest 4.1.10 (`pool: 'threads'` for Stryker only), Node built-in test runner (`node --test`) for the gate script, GitHub Actions (scheduled), Postgres 16 (API run).

## Global Constraints

- **Broad run, narrow gate.** Stryker `mutate` covers the whole package (API) / `src/lib/**` (dashboard) for the report; only the **hardened file set** is gated. `thresholds.break` stays `null` in every Stryker config — the gate is `scripts/mutation-gate.mjs`, never Stryker's own break.
- **`pool: 'threads'` lives ONLY in `vitest.stryker.config.ts`.** `pnpm test`, `pnpm --filter … test`, and every existing CI job stay on the default `forks`. Never change the default pool.
- **`coverageAnalysis: 'perTest'`** in both Stryker configs (re-run only covering tests per mutant).
- **Hardened gate set (per-file floors):** API `src/middleware/logger.ts`, `src/middleware/rate-limit.ts`, `src/routes/projects.ts`; dashboard `src/lib/format.ts`, `src/lib/status.ts`, `src/lib/error-page.ts`, `src/lib/href.ts`. `flakiness.ts` + `parsers/**` are broad-reported, NOT gated (promotion deferred; documented).
- **Mutation score formula:** `(Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage) × 100`. `Ignored`/`CompileError`/`RuntimeError` excluded from the denominator.
- **Local Postgres = disposable `docker run` (NEVER compose); `docker rm -f` on every exit.** Reuse the CI env values: `DATABASE_URL=postgres://postgres:test_password@localhost:5432/flackyness_test`, `ADMIN_TOKEN=test-admin-token-for-ci`.
- **`minimumReleaseAge: 1440`** — a `@stryker-mutator/*` version published <24h ago won't install; pin one release back. Adding deps needs `CI=true` and `--no-frozen-lockfile` (no-TTY purge/frozen prompts).
- **RTK garbles `pnpm`/`stryker` stdout** — run `rtk proxy pnpm …` for trustworthy exit codes; avoid `$(...)` command substitution.
- **Never commit mutated/weakened source.** The gate-proof task (Task 6) reverts every deliberate weakening; `git diff` on product source must be empty before its commit.
- **Commits:** single-line conventional-commit subject, NO `Co-Authored-By` trailer, never `--no-verify`. `main` is branch-protected — this work is on branch `test/stryker-nightly-mutation` (base `905843f`); the PR needs green CI + explicit user approval to merge.
- **Reused pinned action SHAs** (from `.github/workflows/ci.yml`, do not change): `actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0`, `pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6`, `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7`, `actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1`; `NODE_VERSION: "24"`.

---

## File Structure

- `apps/api/vitest.stryker.config.ts` — **Create.** Stryker-only Vitest config: `pool: 'threads'`, node env, include `src/**/*.test.ts`. (The API has no other vitest config.)
- `apps/api/stryker.conf.json` — **Create.** Broad API mutation config (vitest runner, perTest, whole-package mutate).
- `apps/dashboard/vitest.stryker.config.ts` — **Create.** Extends `vitest.config.ts`, overrides `pool: 'threads'`.
- `apps/dashboard/stryker.conf.json` — **Create.** Dashboard `$lib` mutation config.
- `scripts/mutation-gate.mjs` — **Create.** Post-parse gate: per-file floors over the hardened set. Exports `evaluate()` (pure) + a main guard.
- `scripts/mutation-gate.test.mjs` — **Create.** `node --test` unit tests for `evaluate()` against fixture reports.
- `.github/workflows/mutation.yml` — **Create.** Nightly schedule + `workflow_dispatch`.
- `.gitignore` — **Modify.** Ignore `reports/` and `.stryker-tmp/`.
- `apps/api/package.json`, `apps/dashboard/package.json` — **Modify.** Add Stryker devDeps + a `test:mutation` script each.
- `AGENTS.md`, `plans/README.md` — **Modify.** Document the mutation-testing setup + index plan 047.

---

## Task 1: De-risk — prove Stryker runs on the API (no Postgres)

**Goal:** Settle the one real unknown — does `@stryker-mutator/vitest-runner` drive the API's Vitest 4.1.10 suite under `pool: 'threads'` on TS 7, killing mutants — before building anything broad. Mutate only `logger.ts` (covered by the DB-independent `logger.test.ts`); the DB route suites self-skip without `DATABASE_URL`, so **no Postgres is needed** here.

**Files:**
- Create: `apps/api/vitest.stryker.config.ts`, `apps/api/stryker.conf.json`
- Modify: `apps/api/package.json` (devDeps + script), `.gitignore`

**Interfaces:**
- Produces: `apps/api/vitest.stryker.config.ts` (default export, Vitest config with `pool:'threads'`); `apps/api/stryker.conf.json` (the broad config is finalized in Task 2 — Task 1 commits it with a **temporary** narrow `mutate` and flips to broad in Task 2). The `stryker` binary is invoked as `pnpm --filter api exec stryker run`.

- [ ] **Step 1: Add Stryker devDeps to `apps/api`**

```bash
cd /Users/jeremienehlil/Documents/Code/Personal/flackyness
CI=true rtk proxy pnpm --filter api add -D --no-frozen-lockfile @stryker-mutator/core @stryker-mutator/vitest-runner
```
Expected: both packages resolve and install. If either fails with a `minimumReleaseAge` error (published <24h ago), append `@<one-minor-back>` to that package and retry. Record the installed versions.

- [ ] **Step 2: Create the Stryker-only Vitest config**

`apps/api/vitest.stryker.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

// Stryker-ONLY Vitest config. @stryker-mutator/vitest-runner requires
// pool:'threads'. The normal `pnpm --filter api test` has NO vitest config and
// uses Vitest's default 'forks' pool — that stays untouched. This file is
// referenced only from stryker.conf.json (vitest.configFile).
export default defineConfig({
  test: {
    pool: 'threads',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Create a temporary narrow Stryker config (logger only)**

`apps/api/stryker.conf.json` (Task 2 widens `mutate`):
```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "packageManager": "pnpm",
  "testRunner": "vitest",
  "vitest": { "configFile": "vitest.stryker.config.ts" },
  "coverageAnalysis": "perTest",
  "concurrency": 2,
  "mutate": ["src/middleware/logger.ts"],
  "reporters": ["html", "json", "clear-text", "progress"],
  "thresholds": { "high": 90, "low": 70, "break": null }
}
```

- [ ] **Step 4: Ignore Stryker output**

Append to `.gitignore`:
```
# Stryker mutation-testing output
reports/
.stryker-tmp/
```

- [ ] **Step 5: Run the Stryker dry-run + mutation (no Postgres)**

```bash
rtk proxy pnpm --filter api exec stryker run
```
Expected: the initial dry-run passes (route suites self-skip without `DATABASE_URL`; `logger.test.ts` and other DB-independent suites run under threads), Stryker generates mutants for `logger.ts`, and reports a mutation score with most/all killed. A `reports/mutation/mutation.json` and HTML report are written under `apps/api/reports/mutation/`.
**If the `vitest` runner option key or `configFile` shape is rejected**, read the installed `@stryker-mutator/vitest-runner` schema/README and correct `stryker.conf.json` accordingly, then re-run — this is the empirical unknown this task exists to settle. Record the exact working config.
**If threads surface a thread-unsafe global** in the DB-independent suites, note it; fall back to documenting the failure as a BLOCKER (do not silently switch the default pool).

- [ ] **Step 6: Add a package script**

In `apps/api/package.json` `scripts`, add:
```json
"test:mutation": "stryker run"
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/vitest.stryker.config.ts apps/api/stryker.conf.json apps/api/package.json pnpm-lock.yaml .gitignore
git commit -m "test(api): stand up Stryker vitest-runner (threads pool), logger.ts dry-run (Phase B)"
```
Report the installed Stryker versions, the `logger.ts` mutation score, and any config-key corrections.

---

## Task 2: Broad API config + hardened baselines (with Postgres)

**Goal:** Widen the API `mutate` glob to the whole package (broad run) and measure the baseline mutation score for each hardened API file (`logger.ts`, `rate-limit.ts`, `projects.ts`) against a real Postgres — the numbers Task 4's per-file floors are calibrated from.

**Files:**
- Modify: `apps/api/stryker.conf.json`

**Interfaces:**
- Consumes: Task 1's `vitest.stryker.config.ts` + working Stryker config.
- Produces: the broad `mutate` glob; recorded baseline scores for `src/middleware/logger.ts`, `src/middleware/rate-limit.ts`, `src/routes/projects.ts` (handed to Task 4).

- [ ] **Step 1: Widen the `mutate` glob**

In `apps/api/stryker.conf.json`, replace `"mutate": ["src/middleware/logger.ts"]` with:
```json
  "mutate": [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "!src/db/schema.ts",
    "!src/db/seed.ts",
    "!src/index.ts"
  ],
```

- [ ] **Step 2: Start a disposable Postgres**

```bash
docker run -d --name flacky-stryker-pg -e POSTGRES_DB=flackyness_test -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=test_password -p 5432:5432 postgres:16-alpine
```
Wait for readiness (poll `docker exec flacky-stryker-pg pg_isready -U postgres -d flackyness_test` until it reports accepting connections — never `sleep`-guess).

- [ ] **Step 3: Migrate**

```bash
touch .env
DATABASE_URL=postgres://postgres:test_password@localhost:5432/flackyness_test ADMIN_TOKEN=test-admin-token-for-ci rtk proxy pnpm db:migrate
```
Expected: migrations apply cleanly.

- [ ] **Step 4: Measure the hardened baselines (scoped `--mutate`, fast)**

Run Stryker scoped to just the three hardened API files so the baseline is quick (the committed config stays broad):
```bash
DATABASE_URL=postgres://postgres:test_password@localhost:5432/flackyness_test ADMIN_TOKEN=test-admin-token-for-ci \
  rtk proxy pnpm --filter api exec stryker run --mutate "src/middleware/logger.ts,src/middleware/rate-limit.ts,src/routes/projects.ts"
```
Expected: dry-run passes WITH the DB tests running (no self-skip now); Stryker reports a per-file mutation score for all three. **Record each file's score** (from the clear-text report or `apps/api/reports/mutation/mutation.json`) — these feed Task 4. If the dry-run flakes on DB contention at `concurrency: 2`, lower to `1` in the config and re-run; record which concurrency was needed.

- [ ] **Step 5: Tear down Postgres**

```bash
docker rm -f flacky-stryker-pg
```
(Run this even if Step 4 failed.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/stryker.conf.json
git commit -m "test(api): broaden Stryker mutate to whole package (Phase B)"
```
Report the three baseline scores and the concurrency used.

---

## Task 3: Dashboard `$lib` Stryker config + baselines

**Goal:** Mutation-test the dashboard's pure `$lib` helpers via the node Vitest config, and record the baseline score for each of the four hardened `$lib` files.

**Files:**
- Create: `apps/dashboard/vitest.stryker.config.ts`, `apps/dashboard/stryker.conf.json`
- Modify: `apps/dashboard/package.json` (devDeps + script)

**Interfaces:**
- Produces: recorded baseline scores for `src/lib/format.ts`, `src/lib/status.ts`, `src/lib/error-page.ts`, `src/lib/href.ts` (handed to Task 4).

- [ ] **Step 1: Add Stryker devDeps to `apps/dashboard`**

```bash
CI=true rtk proxy pnpm --filter dashboard add -D --no-frozen-lockfile @stryker-mutator/core @stryker-mutator/vitest-runner
```
Use the SAME versions Task 1 installed for the API (keep them in lockstep).

- [ ] **Step 2: Create the Stryker-only Vitest config**

`apps/dashboard/vitest.stryker.config.ts`:
```ts
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

// Stryker-ONLY: extend the node config (keeps the $lib alias + $env stubs),
// override pool -> 'threads' (@stryker-mutator/vitest-runner requirement).
// `pnpm --filter dashboard test` keeps using vitest.config.ts on 'forks'.
export default mergeConfig(base, defineConfig({ test: { pool: 'threads' } }));
```

- [ ] **Step 3: Create the dashboard Stryker config**

`apps/dashboard/stryker.conf.json`:
```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "packageManager": "pnpm",
  "testRunner": "vitest",
  "vitest": { "configFile": "vitest.stryker.config.ts" },
  "coverageAnalysis": "perTest",
  "concurrency": 2,
  "mutate": ["src/lib/**/*.ts", "!src/lib/**/*.test.ts"],
  "reporters": ["html", "json", "clear-text", "progress"],
  "thresholds": { "high": 90, "low": 70, "break": null }
}
```

- [ ] **Step 4: Add a package script**

In `apps/dashboard/package.json` `scripts`, add:
```json
"test:mutation": "svelte-kit sync && stryker run"
```
(`svelte-kit sync` first so generated types exist, matching the other dashboard test scripts.)

- [ ] **Step 5: Run the dashboard mutation + record baselines**

```bash
rtk proxy pnpm --filter dashboard exec stryker run
```
Expected: dry-run passes (the node `$lib` suite is DB-independent), mutants generated for all four `$lib` files, per-file scores reported, `apps/dashboard/reports/mutation/mutation.json` written. **Record each `$lib` file's score** for Task 4. (The `.svelte.test.ts` browser tests are excluded by the node config's `exclude`, so they do not run here — expected.)

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/vitest.stryker.config.ts apps/dashboard/stryker.conf.json apps/dashboard/package.json pnpm-lock.yaml
git commit -m "test(dashboard): Stryker mutation config for \$lib helpers (Phase B)"
```
Report the four baseline scores.

---

## Task 4: The narrow gate (`scripts/mutation-gate.mjs`)

**Goal:** A root script that reads both packages' `mutation.json`, computes each hardened file's mutation score, and fails (exit 1) if any file is below its baseline-calibrated floor. Pure scoring logic is unit-tested against fixtures.

**Files:**
- Create: `scripts/mutation-gate.mjs`, `scripts/mutation-gate.test.mjs`

**Interfaces:**
- Consumes: baseline scores from Tasks 2 & 3.
- Produces: `evaluate(hardened, readJson) -> { ok, results: [{ file, score, detected, valid, floor, pass }] }`; a main guard run as `node scripts/mutation-gate.mjs`.

- [ ] **Step 1: Write the failing gate-logic test**

`scripts/mutation-gate.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './mutation-gate.mjs';

// A fake report: logger fully killed, projects has one survivor.
const reports = {
  'r-api.json': { files: {
    'src/middleware/logger.ts': { mutants: [{ status: 'Killed' }, { status: 'Killed' }, { status: 'Timeout' }] },
    'src/routes/projects.ts':   { mutants: [{ status: 'Killed' }, { status: 'Survived' }, { status: 'Ignored' }] },
  } },
};
const readJson = (p) => reports[p];

test('scores a fully-killed file at 100 and passes its floor', () => {
  const { results } = evaluate([{ report: 'r-api.json', file: 'src/middleware/logger.ts', floor: 90 }], readJson);
  assert.equal(results[0].score, 100);
  assert.equal(results[0].pass, true);
});

test('excludes Ignored from the denominator; one survivor of two valid = 50%', () => {
  const { results } = evaluate([{ report: 'r-api.json', file: 'src/routes/projects.ts', floor: 80 }], readJson);
  assert.equal(results[0].score, 50);   // 1 Killed / (1 Killed + 1 Survived); Ignored dropped
  assert.equal(results[0].pass, false); // 50 < 80
});

test('ok is false if ANY file fails its floor', () => {
  const { ok } = evaluate([
    { report: 'r-api.json', file: 'src/middleware/logger.ts', floor: 90 },
    { report: 'r-api.json', file: 'src/routes/projects.ts', floor: 80 },
  ], readJson);
  assert.equal(ok, false);
});

test('a missing file entry is a hard error (ok false, error set)', () => {
  const { ok, error } = evaluate([{ report: 'r-api.json', file: 'src/nope.ts', floor: 90 }], readJson);
  assert.equal(ok, false);
  assert.match(error, /src\/nope\.ts/);
});
```

- [ ] **Step 2: Run it — verify it fails**

```bash
node --test scripts/mutation-gate.test.mjs
```
Expected: FAIL — `Cannot find module './mutation-gate.mjs'` / `evaluate is not exported`.

- [ ] **Step 3: Write `scripts/mutation-gate.mjs`**

Set each `floor` to `Math.floor(baseline) - 5` (min 0) using the scores recorded in Tasks 2 & 3; write the recorded baseline beside each entry in a comment so a later drop is distinguishable from calibration noise.
```js
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Per-file floors over the A1–A3b hardened set. floor = floor(baseline) - 5.
// Baselines recorded 2026-07-21 (Tasks 2 & 3). Bump deliberately, like the
// route-count guard. Broad-run scores for non-hardened files are report-only.
export const HARDENED = [
  // { report, file, floor }  // baseline: <score>%
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/middleware/logger.ts',    floor: 0 }, // baseline: <fill>
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/middleware/rate-limit.ts', floor: 0 }, // baseline: <fill>
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/routes/projects.ts',       floor: 0 }, // baseline: <fill>
  { report: 'apps/dashboard/reports/mutation/mutation.json', file: 'src/lib/format.ts',            floor: 0 }, // baseline: <fill>
  { report: 'apps/dashboard/reports/mutation/mutation.json', file: 'src/lib/status.ts',            floor: 0 }, // baseline: <fill>
  { report: 'apps/dashboard/reports/mutation/mutation.json', file: 'src/lib/error-page.ts',        floor: 0 }, // baseline: <fill>
  { report: 'apps/dashboard/reports/mutation/mutation.json', file: 'src/lib/href.ts',              floor: 0 }, // baseline: <fill>
];

// Stryker mutation score: (Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage).
// Ignored / CompileError / RuntimeError are excluded from the denominator.
export function evaluate(hardened, readJson) {
  const results = [];
  for (const h of hardened) {
    let json;
    try { json = readJson(h.report); } catch { return { ok: false, error: `cannot read ${h.report}`, results }; }
    const entry = json?.files?.[h.file];
    if (!entry) return { ok: false, error: `no entry for ${h.file} in ${h.report}`, results };
    let detected = 0, valid = 0;
    for (const m of entry.mutants) {
      if (m.status === 'Killed' || m.status === 'Timeout') { detected++; valid++; }
      else if (m.status === 'Survived' || m.status === 'NoCoverage') { valid++; }
    }
    const score = valid ? (detected / valid) * 100 : 100;
    results.push({ file: h.file, score, detected, valid, floor: h.floor, pass: score >= h.floor });
  }
  return { ok: results.every((r) => r.pass), results };
}

// Main guard — only runs when executed directly, not when imported by the test.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const { ok, error, results } = evaluate(HARDENED, readJson);
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.score.toFixed(1)}%  (floor ${r.floor}%)  ${r.file}  [${r.detected}/${r.valid}]`);
  }
  if (error) { console.error(`\nGATE ERROR: ${error}`); process.exit(2); }
  if (!ok) { console.error('\nGATE FAILED: a hardened file dropped below its floor.'); process.exit(1); }
  console.log('\nGATE PASSED: hardened set holds.');
}
```

- [ ] **Step 4: Run the test — verify it passes**

```bash
node --test scripts/mutation-gate.test.mjs
```
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Fill the real floors**

Edit the `HARDENED` array: set each `floor` to `Math.floor(baseline) - 5` (min 0) and each `// baseline:` comment to the recorded score from Tasks 2 & 3.

- [ ] **Step 6: Commit**

```bash
git add scripts/mutation-gate.mjs scripts/mutation-gate.test.mjs
git commit -m "test: mutation-gate script enforcing per-file floors on the hardened set (Phase B)"
```

---

## Task 5: Nightly workflow (`.github/workflows/mutation.yml`)

**Goal:** A scheduled (+ manual) job that runs both Stryker configs against a real Postgres (API), uploads the HTML reports, and runs the gate — never a PR check.

**Files:**
- Create: `.github/workflows/mutation.yml`

**Interfaces:**
- Consumes: `apps/*/stryker.conf.json`, `scripts/mutation-gate.mjs`.

- [ ] **Step 1: Write the workflow**

`.github/workflows/mutation.yml`:
```yaml
name: Mutation

# Nightly only + manual. NOT on pull_request/push, so it is never a PR check.
on:
  schedule:
    - cron: "0 3 * * *"
  workflow_dispatch:

permissions:
  contents: read

env:
  NODE_VERSION: "24"

jobs:
  mutation:
    name: Mutation Testing
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

      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020  # v7
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Run database migrations
        run: |
          touch .env
          pnpm db:migrate

      - name: Mutation test API (Stryker + Postgres)
        run: pnpm --filter api exec stryker run

      - name: Mutation test dashboard $lib (Stryker)
        run: pnpm --filter dashboard exec stryker run

      - name: Upload mutation HTML reports
        if: always()
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a  # v7.0.1
        with:
          name: mutation-reports
          path: |
            apps/api/reports/mutation
            apps/dashboard/reports/mutation
          retention-days: 7

      - name: Enforce the hardened-set gate
        run: node scripts/mutation-gate.mjs
```

- [ ] **Step 2: Validate the YAML**

```bash
python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/mutation.yml')); assert list(d['jobs'])==['mutation']; assert 'pull_request' not in d[True] and 'push' not in d[True]; print('OK: nightly-only, single mutation job')"
```
Expected: `OK: nightly-only, single mutation job`. (`d[True]` is PyYAML parsing the `on:` key — YAML coerces bare `on` to boolean `True`; assert neither PR nor push triggers exist.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/mutation.yml
git commit -m "ci: nightly Stryker mutation workflow with hardened-set gate (Phase B)"
```

---

## Task 6: Prove the gate bites + docs + final gate

**Goal:** Record the mutation proof that the gate catches a real regression, update docs, and run the full local gate.

**Files:**
- Modify: `AGENTS.md`, `plans/README.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Recorded proof — weaken a hardened assertion, watch the gate red**

Pick a `logger.test.ts` assertion that pins a `logger.ts` behavior (e.g. the status→console routing). Weaken it (make it vacuous — e.g. assert a tautology instead of the routed level). Then run the API Stryker scoped to `logger.ts` (no Postgres needed for logger) and the gate:
```bash
rtk proxy pnpm --filter api exec stryker run --mutate "src/middleware/logger.ts"
node scripts/mutation-gate.mjs || echo "GATE REDDED AS EXPECTED (exit $?)"
```
Expected: `logger.ts`'s score drops (mutants that the real assertion killed now survive), and `mutation-gate.mjs` prints `FAIL` for `src/middleware/logger.ts` and exits 1. This is the recorded proof.

- [ ] **Step 2: Revert the weakening — confirm clean**

```bash
git checkout -- apps/api/src/middleware/logger.test.ts
git diff --stat apps/api/src/middleware/logger.test.ts   # MUST be empty
```
Re-run the scoped Stryker + gate to confirm `logger.ts` is back above its floor and the gate passes. (Never commit the weakened test.)

- [ ] **Step 3: Update `AGENTS.md`**

Add a Conventions bullet (near the mutation-proof discipline): the repo now has **automated** mutation testing (Stryker, nightly `Mutation` workflow). Note: `pnpm --filter <pkg> test:mutation` runs it locally (API needs a disposable Postgres via `docker run`; the dashboard's `$lib` run does not). The gate (`scripts/mutation-gate.mjs`) enforces **per-file floors** on the hardened set (`logger.ts`, `rate-limit.ts`, `projects.ts`, `$lib/{format,status,error-page,href}.ts`); the floors are baseline-calibrated and bumped deliberately. `pool: 'threads'` lives ONLY in `vitest.stryker.config.ts` — never change the default `forks`. Browser-mode `.svelte` components are NOT mutation-tested (Stryker has no browser-mode support); A3b render tests remain their guard.

- [ ] **Step 4: Update `plans/README.md`**

In the batch-9 table (after the 046 row), add:
```
| 047 | Phase B of the mutation-testing effort: nightly Stryker mutation testing — broad per-package run (apps/api + dashboard $lib), narrow per-file gate over the A1–A3b hardened set, isolated `pool:'threads'` Stryker vitest config, advisory nightly `Mutation` workflow | P3 | M | A1–A3b (plans 042–046) | OPEN (PR pending) |
```
And, if the Task-1/Task-2 exploration confirmed `flakiness.ts`/`parsers/**` score cleanly, add an "Open follow-ups" entry proposing their promotion into the gated set (else note they remain broad-reported only).

- [ ] **Step 5: Full local gate**

```bash
# Existing suites unchanged & still forks-based:
rtk proxy pnpm --filter api test           # API suite (needs Postgres — reuse the disposable one)
rtk proxy pnpm --filter dashboard test     # 89 node tests, browser-free
rtk proxy pnpm --filter dashboard check    # svelte-check 0 errors
rtk proxy pnpm lint                        # oxlint clean
node --test scripts/mutation-gate.test.mjs # gate logic 4/4
```
Record counts. Confirm no existing test count changed (the Stryker configs must not perturb the normal runs). Tear down any disposable Postgres with `docker rm -f`.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md plans/README.md
git commit -m "docs: document Stryker nightly mutation testing + gate (Phase B)"
```
Report the gate-proof result (logger score before/after weakening), the doc updates, and the full-gate counts.

---

## Self-Review

**1. Spec coverage:**
- Broad run / narrow gate → Tasks 2/3 (broad `mutate`) + Task 4 (gate). ✓
- API Postgres + limited concurrency + perTest → Task 2 (Postgres, `--concurrency` fallback) + configs (`coverageAnalysis: perTest`). ✓
- Dashboard `$lib` only → Task 3. ✓
- `pool: 'threads'` isolation → Tasks 1/3 configs + Task 6 doc + Task 6 Step 5 "still forks-based" check. ✓
- One-run + post-parse gate → Task 4 (`evaluate`), Task 5 (gate step after the runs). ✓
- Per-file floors + baseline calibration → Task 4 Steps 3/5. ✓
- Nightly, not a PR check → Task 5 (`schedule`/`workflow_dispatch` only) + YAML assertion. ✓
- HTML artifact → Task 5 upload step. ✓
- Prove B bites → Task 6 Steps 1–2. ✓
- Scope boundaries (components excluded, flakiness/parsers reported-not-gated) → Global Constraints + Task 6 doc. ✓
- Known risks (TS7, minimumReleaseAge, DB contention, runtime) → Task 1 Step 5, Task 1 Step 1, Task 2 Step 4. ✓

**2. Placeholder scan:** The only deferred values are the empirical baseline scores/floors — these carry an exact derivation rule (`floor(baseline) − 5`) and a recording step, not a "TBD". No `add error handling`/`similar to Task N` placeholders; every code step shows complete code.

**3. Type/name consistency:** `evaluate(hardened, readJson)` signature and the `{ report, file, floor }` entry shape are identical in the test (Task 4 Step 1), the implementation (Step 3), and the main guard. `mutation.json` paths (`apps/api/reports/mutation/mutation.json`, `apps/dashboard/reports/mutation/mutation.json`) match between the gate script and the Stryker output dirs. `vitest.stryker.config.ts` / `stryker.conf.json` names are consistent across tasks. Reused action SHAs match `ci.yml` verbatim.
