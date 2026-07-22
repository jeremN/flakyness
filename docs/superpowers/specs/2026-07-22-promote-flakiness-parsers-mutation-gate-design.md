# Promote `flakiness.ts` + parsers into the mutation gate (design)

**Status:** approved 2026-07-22. Closes backlog follow-up **#14**
(`plans/README.md`). Base `ea89f23` (main after #13/plan 048). Plan lands as
`plans/049-*`.

## Purpose

The mutation-testing effort (A1→A3b→Phase B, plans 042–047) stood up a nightly
Stryker gate; plan 048 (#13) hardened the two coarse route/middleware files.
Three high-value API files are still **report-only** — the broad `apps/api`
Stryker run mutates them, but `scripts/mutation-gate.mjs`'s `HARDENED` set does
not enforce a floor on them:

- `apps/api/src/services/flakiness.ts` (350 LOC) — **the core flake-rate
  algorithm** (`updateFlakyTests`, windowed flake computation, resolve/quarantine
  logic). A regression here silently corrupts every flake verdict the product
  makes. Existing test: `flakiness.test.ts` (577 lines, **DB-dependent** — needs
  `DATABASE_URL`, no admin token; self-skips without a DB).
- `apps/api/src/parsers/junit.ts` (295 LOC) and
  `apps/api/src/parsers/playwright.ts` (527 LOC) — parse **untrusted CI input**
  (JUnit XML, Playwright JSON) at the ingest boundary. Existing tests
  (`junit.test.ts` 311 lines, `playwright.test.ts` 602 lines) are **pure — no DB,
  fully deterministic**.

This pass measures those three files, raises their true mutation score where
cheap killable survivors exist, then promotes them into the gate with
baseline-calibrated floors. This is the honest completion of the effort's
coverage story: the two files that most deserve a regression floor (core
algorithm + untrusted-input parsers) get one.

## Decisions (locked)

1. **Test-only, zero product-source changes.** No edits to `flakiness.ts` /
   `junit.ts` / `playwright.ts`, and **no `// Stryker disable` annotations** in
   product code (those are product changes and would launder equivalent mutants
   instead of documenting them). True equivalent/defensive mutants are left
   surviving; the floor reflects that reality.
2. **Survivor-driven triage, not blanket new tests.** All three files already
   have substantial suites; this is not "write the missing tests." Task 1
   measures, then partitions survivors into **killable** (a real assertion or
   coverage gap) vs **accepted** (equivalent or defensive-branch mutants not
   worth contorting a test to kill). Only killable survivors get work. A file
   that already scores high with only equivalent survivors is gated **as-is**.
3. **Measure-first, re-measure-last.** Floors are set from post-hardening
   re-measurement (≥2 reproducible runs), never promised up front.
   `floor = floor(reliableLow of ≥2 runs) − 5`.
4. **Postgres only where the tests need it.** The parser suites are pure and are
   measured **without** Postgres (deterministic → floor reproduces exactly).
   `flakiness.ts` needs a disposable Postgres (via `docker run`, never
   `docker compose`; `docker rm -f` on every exit). If `flakiness.ts` wobbles
   run-to-run, its floor is calibrated off the **reliable low**, like
   `projects.ts` — and the wobble's cause is recorded, not papered over.
5. **All three files, one plan/branch.** Each file is hardened in its own task so
   a reviewer can gate them independently.

## Approach

A single implementation plan, executed subagent-driven. Shape:
**measure & triage → harden each file (only its killable survivors) → re-measure
& promote into the gate**, test-only throughout.

Alternatives considered and rejected:

- *Measure-and-gate-as-is (no hardening).* Rejected as the default — it locks in
  whatever coverage exists today. But it is the correct outcome *per file* when
  Task 1's triage finds only equivalent survivors; decision 2 already folds that
  in.
- *Fold in fixing the projects.ts reconcile race* (which would let that floor
  tighten, per #15). Rejected as scope creep — #14 is about gating these three
  files; the race is a separate lever tracked by #15.
- *Chase 100% (kill every survivor incl. equivalents).* Rejected as un-YAGNI —
  the floor policy (`floor(reliableLow) − 5`) already absorbs equivalents;
  document them, don't fight them.

## Flow & structure (task shapes)

1. **Measure & triage.** Run Stryker scoped to the three files (parsers
   Postgres-free; `flakiness.ts` against a disposable Postgres, ≥2 runs to check
   for wobble). Produce a **killable-vs-accepted** triage table (survivor →
   verdict → reason) and record the pre-hardening baselines. No source or test
   changes yet — this is the plan's map.
2. **Harden `flakiness.ts`.** For each killable survivor, strengthen or add a
   race-safe, mutation-proven test assertion. (Race-safe = seed via direct
   `db.insert(...)` and assert on the awaited service return / resulting rows;
   never depend on the un-awaited reconcile.)
3. **Harden `parsers/junit.ts`.** Same, for its killable survivors (pure tests).
4. **Harden `parsers/playwright.ts`.** Same, for its killable survivors (pure
   tests).
5. **Re-measure & promote.** Re-run Stryker on the three files (≥2 runs for any
   that wobble), record the new reproducible scores, add three entries to the
   `HARDENED` array in `scripts/mutation-gate.mjs` with
   `floor = floor(reliableLow) − 5` + calibration comments, mark #14 resolved in
   `plans/README.md` with the durable triage summary. Prove the gate is
   **green-on-clean** across all 10 entries end-to-end (exit 0).

Tasks 2–4 collapse to a no-op-plus-gate for any file whose Task-1 triage is
"only equivalents" — that file skips straight to being gated at its measured
baseline in Task 5.

## Constraints (non-negotiables the plan inherits)

- **Test-only, no product-source changes; no `// Stryker disable` in product
  code.** (Decision 1.)
- **Race-safe `flakiness` tests.** Seed with direct
  `db.insert(...).values(...)`; assert on the **awaited** `updateFlakyTests()`
  return value or the resulting `flaky_tests`/`test_results` rows. Never rely on
  the documented un-awaited reconcile (AGENTS.md — poll, never `sleep`). New
  tests must not add non-determinism.
- **Every added assertion mutation-proven.** Break the covered line → the new
  assertion goes red → revert byte-clean → record it. Never commit mutated or
  weakened source.
- **Disposable Postgres, parsers excepted.** `flakiness.test.ts` self-skips
  without `DATABASE_URL`; measure it against a throwaway Postgres via
  `docker run` (never `docker compose`), `docker rm -f` on every exit even on
  failure. Parser suites need no DB. The api Stryker config's timeout knobs
  (`timeoutMS`, `timeoutFactor`) stay — they prevent false-Timeout inflation
  (the artifact that once inflated `logger.ts`, plans/README.md #15).
- **Floor policy = reliable-low.** `floor = floor(reliableLow of ≥2
  post-hardening runs) − 5`. Do not over-tighten off a lucky-high run.
- **`HARDENED` array + README #14 bumped deliberately.** The gate comment records
  the new baselines; #14 flips to resolved with the killed-vs-accepted summary.
- **RTK shell quirk:** the rtk hook garbles `pnpm`/`stryker` stdout in this repo;
  run those prefixed with `rtk proxy` for trustworthy output/exit codes.
- **No new endpoints, no product behavior change.** Coverage only. Existing
  suites stay green (API 362+, dashboard 89, `check` 0-err, oxlint clean).

## Success criteria

1. `flakiness.ts`, `junit.ts`, `playwright.ts` added to `HARDENED` with floors set
   **honestly** from re-measured, reproduced baselines (`floor(reliableLow) − 5`).
2. The gate is proven **green-on-clean** across all 10 entries, end-to-end
   (exit 0).
3. Every added/strengthened assertion carries a recorded mutation proof.
4. The triage's durable summary (in `plans/README.md` #14 + the gate comment)
   records **killed vs accepted** survivors and *why* — so a future pass knows
   the ceiling and doesn't re-audit equivalents.
5. Zero product-source changes; no `// Stryker disable` annotations; existing
   suites and CI jobs unchanged and green.
6. `scripts/mutation-gate.mjs` (floors + calibration comment) and
   `plans/README.md` (#14 → resolved) updated deliberately.
