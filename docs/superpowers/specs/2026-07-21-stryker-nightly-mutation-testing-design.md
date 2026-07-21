# Phase B — Stryker nightly mutation testing (design)

**Status:** approved 2026-07-21. Branch `test/stryker-nightly-mutation`, base `905843f` (main after A3b/#101).

## Purpose

Phases A1–A3b hardened the test suites by hand: every assertion was made
*provable by a source mutation*, each proof recorded manually (break covered
code → watch a specific test go red → revert). Phase B **automates that
verification** with [Stryker](https://stryker-mutator.io/) so the property is
re-checked continuously instead of only at authoring time, and so a future
change that silently re-weakens an assertion is caught.

## Decisions (locked)

1. **Broad run, narrow gate.** Stryker mutates whole packages for *visibility*
   (a full report), but the enforced score threshold — the thing that can turn
   the job red — applies only to the A1–A3b **hardened file set**.
2. **API: Postgres + limited concurrency.** The nightly provisions a real
   Postgres so the DB-dependent hardened code (the `/analysis` handlers in
   `projects.ts`) is actually scored. Stryker uses `coverageAnalysis: perTest`
   (re-runs only the tests covering each mutant, not the whole suite) with
   constrained concurrency against one shared DB.
3. **Dashboard: `$lib` node suite only.** Stryker mutates the pure `$lib`
   helpers via the node vitest config. The browser-mode `.svelte` components are
   **excluded** and documented as a known limitation — Stryker's Vitest runner
   has no browser-mode support, and A3b's render tests remain their guard.

## Architecture

Two independent Stryker runs, one per package, plus a shared gate script and a
nightly workflow.

```
apps/api/
  stryker.conf.json          # mutate whole package; vitest runner; perTest
  vitest.stryker.config.ts   # extends default; pool: 'threads' (Stryker-only)
apps/dashboard/
  stryker.conf.json          # mutate src/lib/**; node vitest runner; perTest
  vitest.stryker.config.ts   # extends vitest.config.ts; pool: 'threads'
scripts/
  mutation-gate.mjs          # reads each mutation.json; gates the hardened set
.github/workflows/
  mutation.yml               # nightly schedule + workflow_dispatch
```

### The `pool` wrinkle (isolated, no blast radius)

Stryker's Vitest runner requires `pool: 'threads'`. Today `apps/api` has **no**
vitest config (Vitest defaults to `pool: 'forks'`) and the dashboard node config
is `forks`-implicit. Changing the default pool project-wide is out of scope and
risky (the suites are validated on `forks`).

Instead, each package gets a dedicated `vitest.stryker.config.ts` that extends
its normal config and overrides **only** `pool: 'threads'`. Stryker's
`vitest.configFile` points at it. `pnpm test`, `pnpm --filter … test`, and every
CI job stay on `forks`, untouched — the thread pool exists solely inside the
mutation run. For the API, the Stryker vitest config also carries the same env
expectations as the normal run (`DATABASE_URL`, `ADMIN_TOKEN`) so the route
suites do not self-skip.

### Broad run + narrow gate (one run, post-parse gate)

Each package runs Stryker **once**: `mutate` covers the whole package (API) or
`src/lib/**` (dashboard), with the **json** reporter (`reports/mutation/mutation.json`)
and the **html** reporter (uploaded as a CI artifact). Stryker's own
`thresholds.break` is left unset (or `null`) so the broad numbers never fail the
job on their own.

A single Node script, `scripts/mutation-gate.mjs`, then enforces the narrow
gate. It:

- reads each package's `mutation.json`,
- restricts to the **hardened file list** (below),
- computes the mutation score over just those files as
  `(killed + timeout) / (killed + timeout + survived + no_coverage)` — i.e.
  Stryker's *whole* mutation score, **including** no-coverage mutants in the
  denominator, so an uncovered hardened mutant counts *against* the gate (a
  hand-hardened module should have none). Equivalent (`Ignored`) mutants are
  excluded, as Stryker excludes them everywhere,
- compares against the per-file-set **threshold**,
- exits non-zero (failing the job) if the hardened score is below threshold,
  printing which files/mutants regressed.

This yields both the broad report and the narrow gate from a single expensive
run (DRY). *Alternative considered and rejected:* two Stryker configs per
package (one broad report-only, one gated over just the hardened files with a
native `thresholds.break`) — cleaner separation but doubles the mutation
runtime for no added signal.

### Nightly CI job (`.github/workflows/mutation.yml`)

- **Triggers:** `schedule` (cron `0 3 * * *`, ~03:00 UTC) + `workflow_dispatch`
  (manual). **Not** `pull_request` / `push` — it is never a PR check, so it
  cannot block merges (advisory by construction).
- **Permissions:** `contents: read` (least privilege), matching `ci.yml`.
- **Setup:** reuse `ci.yml`'s pinned action SHAs (checkout, pnpm/action-setup,
  setup-node) and `NODE_VERSION`. Provision `postgres:16-alpine` as a service
  with the same env the `test`/`e2e` jobs use (`DATABASE_URL`,
  `ADMIN_TOKEN`), run migrations (`touch .env && pnpm db:migrate`).
- **Run:** `pnpm --filter api exec stryker run` and
  `pnpm --filter dashboard exec stryker run`, each with
  `--concurrency 2` (tunable; fall back to 1 if the dry-run flakes on DB
  contention).
- **Report:** upload each package's `reports/mutation/mutation-report.html` as a
  build artifact (7-day retention).
- **Gate:** a final step runs `node scripts/mutation-gate.mjs`, which fails the
  job (→ GitHub failed-workflow notification) if the hardened set regressed.
  The broad numbers are report-only.

## Gated file set + threshold

The gate covers exactly the A1–A3b hardened modules that Stryker can score:

**API** (`apps/api/src/`):
- `middleware/logger.ts` (A2b — status routing, prod stack-omission)
- `middleware/rate-limit.ts` (A2a — admin brute-force limiter)
- `routes/projects.ts` — the `/analysis` clamp + flaky-subset invariants
  (A2b); DB-dependent, hence Postgres in the job
- `services/flakiness.ts` and the `parsers/**` — included **iff** they carry a
  real unit suite that Stryker can drive (verified during planning; if a module
  has no biting unit test it is *reported* but not *gated*, to avoid a
  false-red gate).

**Dashboard** (`apps/dashboard/src/lib/`):
- `format.ts`, `status.ts`, `error-page.ts`, `href.ts` (A3 — 11 recorded
  mutation proofs).

The exact list lives in one place — `scripts/mutation-gate.mjs` (a
`HARDENED` array) — so it is greppable and bumped deliberately, mirroring the
route-count guard convention.

**Threshold:** calibrated on the **first baseline run**. Hand-proven code will
not score exactly 100% — Stryker emits some equivalent/uncoverable mutants
(e.g. string mutations inside log messages, arithmetic on values no assertion
observes). The plan's first task records the baseline, then pins
`MUTATION_GATE_THRESHOLD` a small margin below it (rounded), documented inline
so any later drop is a real regression, not calibration noise.

## Scope boundaries (YAGNI)

Excluded from mutation and/or from the gate, documented in the configs:

- Dashboard `.svelte` components (browser-mode; Stryker cannot drive them yet).
- Config, generated (`.svelte-kit/`, `drizzle/` migrations), build output,
  seed/CLI scripts, and test files themselves.
- Any source with no biting test: *reported* in the broad run, never *gated*.

## Proving B itself bites

The mutation-testing effort's own standard applies to B. As the final
verification task: deliberately weaken one hardened assertion (e.g. make a
`logger.ts` status-routing assertion vacuous), run `stryker run` +
`mutation-gate.mjs`, and confirm the hardened score drops **below threshold and
reds the gate**; then revert. This is the recorded proof that the gate catches
the exact class of regression B exists to catch. (Never commit the weakened
source.)

## Known risks (settle in the plan, not blockers)

- **Stryker + TS 7 on the API.** Stryker mutates source text and drives vitest,
  which transpiles TS via esbuild — it does **not** need TypeScript's
  programmatic API (the thing TS 7 dropped that blocks `svelte-check`). Expected
  to work; the first planning task verifies a Stryker dry-run on the API before
  building the rest.
- **`minimumReleaseAge: 1440`.** A `@stryker-mutator/*` version published <24h
  ago won't install; pin one release back if needed. Add `@stryker-mutator/core`
  + `@stryker-mutator/vitest-runner` as root or per-package devDeps.
- **DB contention under concurrency.** The API suites share one Postgres and
  isolate by unique data; two concurrent Stryker workers multiply write
  pressure. Start at `--concurrency 2`; if the initial (unmutated) dry-run is
  not green, drop to 1.
- **Runtime.** A nightly is cheap wall-clock, but if the API run is
  unreasonably long even with `perTest`, narrow the API `mutate` glob toward the
  gated modules (keeping "broad" as broad-as-feasible) rather than abandoning
  DB coverage.

## Success criteria

1. `stryker run` completes green (dry-run + mutation run) for both packages in
   the nightly, against a real Postgres for the API.
2. The broad HTML report is produced and uploaded for both packages.
3. `mutation-gate.mjs` computes the hardened-set score and passes at the
   calibrated threshold on a clean tree.
4. The recorded proof shows a weakened hardened assertion drops the score below
   threshold and reds the gate.
5. `pnpm test` and all existing CI jobs are unchanged and still `forks`-based
   (no blast radius from the Stryker-only thread pool).
6. Docs updated: `AGENTS.md` (a "mutation testing" sharp-edge/convention note),
   `plans/README.md` (047 row, Phase-B status).
