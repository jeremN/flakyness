# Harden `projects.ts` + `rate-limit.ts` mutation coverage (design)

**Status:** approved 2026-07-21. Closes backlog follow-up **#13**
(`plans/README.md`). Base `6016ddf` (main after Phase B #102 + quick-wins
#103). Plan lands as `plans/048-*`.

## Purpose

Phase B stood up the Stryker nightly gate; the gate's floors are honest but
**coarse** for the two API route/middleware files that were only partially
hardened during A2:

- `apps/api/src/routes/projects.ts` — 298 mutants, ~17% land as `NoCoverage`
  (mostly zod `enum([...])` / query-param string-literal rejections nothing
  asserts against). Only the `/analysis` slice was hardened in A2b (plan 044).
  Current floor **48**, baseline reliable-low **~53.7%** (race-wobbly, ~54–58%
  run-to-run).
- `apps/api/src/middleware/rate-limit.ts` — 50 mutants, ~7 `NoCoverage`; a
  smaller but analogous gap. Current floor **57**, baseline **62.00%**
  (reproduces exactly run-to-run).

This pass raises the **true** mutation score of both files by killing
meaningful survivors and covering the untested validation branches, then
ratchets their floors up to the new reproduced baselines. It is the honest way
to lift the floors that #13/#15 both point at — coverage, not a stricter number
over the same tests.

## Decisions (locked)

1. **Test-only, zero product-source changes.** No edits to `projects.ts` /
   `rate-limit.ts`, and **no `// Stryker disable` annotations** anywhere in
   product code (those are product changes and would launder equivalent
   mutants instead of documenting them). True equivalent/defensive mutants are
   left surviving; the floor reflects that reality.
2. **Survivor-driven triage, not blanket new tests.** Every endpoint in
   `projects.ts` already has a test (`projects.test.ts`, 762 lines); this is not
   "write the missing tests." Task 1 measures, then partitions survivors into
   **killable** (a real assertion/coverage gap) vs **accepted** (equivalent or
   defensive-branch mutants not worth contorting a test to kill). Only killable
   survivors get work.
3. **Measure-first, re-measure-last.** The floors are set from post-hardening
   re-measurement (≥2 reproducible runs), never promised up front. `projects.ts`
   wobbles ~1pp from the reconcile race, so its floor is calibrated off the
   **reliable low**, not the mean.
4. **Both files, one plan.** `projects.ts` and `rate-limit.ts` are hardened in
   the same branch/plan (pragmatic scope), each in its own task so a reviewer
   can gate them independently.

## Approach

A single implementation plan, ~4 tasks, executed subagent-driven. The shape is
**measure → harden A → harden B → re-measure & ratchet**, test-only throughout.
Alternatives considered and rejected:

- *Two separate plans (one per file).* Rejected — the measurement harness
  (disposable Postgres + Stryker scoped to a file) and the floor-update step are
  identical for both; splitting doubles the setup for no added signal.
- *Chase 100% (kill every survivor incl. equivalents).* Rejected as un-YAGNI —
  equivalent mutants are unkillable by definition; the floor policy
  (`floor(reliable-low) − 5`) already absorbs them. Document them in the triage,
  don't fight them.

## Flow & structure (task shapes)

1. **Measure & triage.** Run Stryker scoped to `projects.ts` and
   `rate-limit.ts` against a disposable Postgres; produce a
   **killable-vs-accepted** triage table (survivor → verdict → reason). This is
   the plan's map; no source or test changes yet. The full per-survivor table is
   a Task-1 working artifact (captured in the plan's progress notes); its
   **durable summary** — killed-vs-accepted counts and the notable accepted
   equivalents — lands in `plans/README.md` #13 (mirroring #15's resolution
   bullet) and the `mutation-gate.mjs` calibration comment in Task 4. Also
   records the two pre-hardening baseline scores.
2. **Harden `projects.ts`.** For each *killable* survivor from Task 1, strengthen
   or add a test assertion (and cover the untested zod query-param validation
   branches — the `NoCoverage` bulk). Every added/strengthened assertion is
   mutation-proven (red on the specific mutation, revert byte-clean).
3. **Harden `rate-limit.ts`.** Same, for its killable survivors — primarily the
   ~7 `NoCoverage` branches (limiter window/threshold edges, `getClientIp`
   fallbacks that are actually reachable).
4. **Re-measure & ratchet.** Re-run Stryker on both files (≥2 runs for
   `projects.ts`), record the new reproducible scores, set
   `floor = floor(reliable-low) − 5`, update the `HARDENED` array + calibration
   comment in `scripts/mutation-gate.mjs`, mark #13 resolved in
   `plans/README.md`. Prove the gate is **green-on-clean** at the new floors
   end-to-end (exit 0).

## Constraints (non-negotiables the plan inherits)

- **Test-only, no product-source changes; no `// Stryker disable` in product
  code.** (Decision 1.)
- **Race-safe tests.** New/changed `projects` tests stay race-safe exactly like
  the existing suite — direct `db.insert(flakyTests).values(...)` and compute
  expectations from the in-response `allTests`, **never** ingest-then-read
  `flaky_tests` (the documented un-awaited `updateFlakyTests()` reconcile race,
  AGENTS.md). If a case genuinely must ingest, use `?wait=true` or poll for the
  reconcile — **never `sleep`**. New tests must not *add* to the ~12-mutant
  Killed↔Survived wobble.
- **Every added assertion mutation-proven.** The effort's standard: break the
  covered line → the new assertion goes red → revert byte-clean → record it.
  Never commit mutated or weakened source.
- **Postgres-dependent, disposable.** These route tests self-skip without
  `DATABASE_URL` + `ADMIN_TOKEN`. Measurement uses a throwaway Postgres via
  `docker run` (never `docker compose`), `docker rm -f` on every exit. The
  Phase B Stryker timeout config (`timeoutMS: 15000`, `timeoutFactor: 2`) stays.
- **Floor policy = reliable-low.** `floor = floor(reliable-low of ≥2
  post-hardening runs) − 5`. Do not over-tighten off a lucky-high run.
- **Gate `HARDENED` array + README #13 bumped deliberately**, like the
  route-count guard — the comment block records the new baselines and the
  `NoCoverage`-now-covered delta.
- **No new endpoints, no `readAuth` changes.** Coverage only; all `projects`
  routes already mount `readAuth()`. Existing suites stay green (api 343+,
  dashboard 89, `check` 0-err, oxlint clean).

## Success criteria

1. Both files' floors raised **honestly** from re-measured, reproduced
   baselines (`projects.ts` up from 48, `rate-limit.ts` up from 57; final
   numbers set by Task 4, not promised here).
2. The gate is proven **green-on-clean** at the new floors, end-to-end (exit 0).
3. Every added/strengthened assertion carries a recorded mutation proof.
4. The triage's durable summary (in `plans/README.md` #13 + the gate comment)
   records **killed vs accepted** survivors and *why* — so a future pass knows
   the ceiling and doesn't re-audit equivalents.
5. Zero product-source changes; no `// Stryker disable` annotations; existing
   suites and CI jobs unchanged and green.
6. `scripts/mutation-gate.mjs` (floors + calibration comment) and
   `plans/README.md` (#13 → resolved) updated deliberately.
