# Plan 030: Make the agent-facing docs true again

> **Executor instructions**: Follow the plan, verify every claim you write against the
> actual code, honor the STOP conditions. Do not update `plans/README.md` — the reviewer
> maintains it.
>
> **Drift check**: `git rev-parse --short HEAD` should be at or after `b92fb3f`.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW — documentation only. But see "the one real risk" below.
- **Depends on**: none. **Parallel-safe**: sole owner of `.agent/CONTEXT.md` and
  `AGENTS.md`. Plans 028 and 029 run alongside and touch neither.
- **Category**: docs
- **Planned at**: commit `b92fb3f`, 2026-07-13

## Why this matters

`.agent/CONTEXT.md` and `AGENTS.md` are the **first files every agent and new contributor
reads**. When they're wrong they don't merely fail to help — they actively mislead, and
they're trusted precisely because they're the designated source of truth.

They are wrong right now. `.agent/CONTEXT.md` still says, under "Known Issues & TODOs":

```
- ⏳ E2E tests (Playwright) — no `playwright.config` or spec files in the repo yet
```

A full Playwright E2E suite landed **today** (plan 026, PR #69): `apps/dashboard/playwright.config.ts`,
five specs under `apps/dashboard/e2e/`, a dedicated `e2e` job in CI, and a dogfood step
that ingests the suite's own report back into the API. The doc asserts the opposite of
reality.

This is the second time these docs have gone stale in a fortnight (plan 022 was the last
refresh). The fix is not just to patch this line — it is to bring the whole file back in
line with what shipped, and to be *sceptical of every other claim in it while you're there*.

## What actually shipped since the last refresh

Verify each of these against the code (do not take this list on faith — it is a lead, not a
citation):

- **Quarantine list for CI** — `GET /api/v1/projects/:id/quarantine` (`routes/projects.ts`),
  incl. `?format=playwright` returning a `grepInvert` pattern built from **muted tests only**.
- **Per-project data retention + admin prune** — `POST /api/v1/admin/projects/:id/prune`
  (`routes/admin.ts`), `projects.retention_days` (migration `0006`), dry-run by default
  (`?confirm=true` required to delete).
- **TypeScript split** — `apps/api` on TS 7, `apps/dashboard` pinned to TS 6 because
  `svelte-check` 4.x crashes under TS 7. Fenced in `.github/dependabot.yml`.
- **Per-test flake trend** — `GET /api/v1/tests/:testName/trend` (`routes/tests.ts`), derived
  on demand from `test_results` (**no table, no migration**). A day with no runs is
  `flakeRate: null`, never `0`.
- **GitHub Action** — `action.yml` at repo root + `.github/action-scripts/`, documented in
  `docs/GITHUB_ACTION.md`. It *reports*; it never skips, retries, or alters exit codes, and
  it degrades quietly if the API is unreachable.
- **Playwright E2E suite + dogfooding** — `apps/dashboard/e2e/`, `retries: 0`, plus an `e2e`
  CI job that ingests the suite's own report (confirmed working: "Dogfood ingest succeeded (201)").
- **Two flaky-test fixes in our own suite** (plans 027, 029) — caused by the un-awaited
  background reconcile on the ingest path.

## The sharp edge that deserves its own entry

The single most repeat-offending gotcha in this codebase, and it is **not** currently
documented in either file:

> **`POST /api/v1/reports` returns `201` *before* flakiness is recomputed.**
> `routes/reports.ts` fires `updateFlakyTests()` **un-awaited**, by design, so ingest does
> not block on recomputation. Any consumer that reads `flaky_tests` immediately after an
> ingest is **racing** it — and `updateFlakyTests` sweeps *every* existing row for the
> project, not just names in the latest report, so it will resolve an `active` row that has
> no backing `test_results`. This has now caused **two** flaky tests (plans 027, 029). Poll
> for the reconcile to land; never `sleep`.

Add it to `AGENTS.md`'s "Sharp edges" and expand on it in `CONTEXT.md`. It has bitten three
times and it will bite again.

Also worth capturing in AGENTS.md conventions (both were enforced in review this batch):

- **Time series: a bucket with no data is `null`, never `0`.** "It didn't run" and "it ran
  and nothing flaked" are different facts; collapsing them makes a chart lie.
- **New ECharts series types must be registered in `Chart.svelte`'s `echarts.use([...])`.**
  An unregistered type is a **silent no-op** — no throw, no console warning (the dev warning
  is compiled out of production builds), and the axes still paint, so the canvas isn't even
  blank. `apps/dashboard/src/lib/components/chart-registration.test.ts` now guards this;
  the E2E chart spec explicitly does **not** (it can't).

## The one real risk

**Do not write anything you have not verified.** A confidently wrong doc is worse than a
stale one, because the staleness at least eventually becomes obvious. Every claim you add or
keep must be checked against the code *now*.

In particular, **audit the existing file for other false claims** — the E2E line is the one
we caught, not necessarily the only one. Check the "Known Issues & TODOs", "Ops / scaling
notes", and any command examples. Report anything you find that you're unsure about rather
than guessing.

## Specific known-false or suspect content to check

1. `⏳ E2E tests (Playwright) — no playwright.config or spec files in the repo yet` — **false**.
2. Any bare **`docker compose up -d`** without the `postgres` service scoped. Plan 022 already
   corrected some of these; a bare form can port-clash with the operator's stack. The safe
   form is in `AGENTS.md`'s command table. **Check both files.**
3. The CI job list — CONTEXT.md describes CI's jobs; there is now an **`e2e`** job too.
4. Test-count baselines, if any are quoted — they've changed. Either update them from a real
   run or **delete them**; a stale number is worse than no number.
5. `IMPLEMENTATION_PLAN.md` is referenced at the end of CONTEXT.md — confirm it still exists.
   If it doesn't, remove the dangling pointer.

## Scope

**In scope** (this plan owns these exclusively):
- `.agent/CONTEXT.md`
- `AGENTS.md`

**Out of scope** (do NOT touch — parallel plans own these, and any edit will conflict):
- `apps/**` — **all** application code and tests. This plan changes **zero** code.
- `.github/workflows/ci.yml` — plan 029
- `docs/API.md`, `docs/GITHUB_ACTION.md`, `README.md`
- `plans/**`

## Done criteria

- [ ] The false E2E claim is gone, replaced by an accurate description of the suite (incl. `retries: 0` and the dogfood step)
- [ ] The un-awaited-reconcile sharp edge is documented in **both** files
- [ ] The null-not-zero and ECharts-registration conventions are in `AGENTS.md`
- [ ] Every command in `AGENTS.md`'s table has been **run** and works (paste the output for `pnpm lint`, `pnpm test`, and the typechecks)
- [ ] `grep -rn "docker compose up" AGENTS.md .agent/CONTEXT.md` — every hit is scoped to `postgres`, or justified in your report
- [ ] Any other false claim you found is either fixed or explicitly reported
- [ ] `git diff --name-only main` shows **only** `.agent/CONTEXT.md` and `AGENTS.md`

## STOP conditions

- **You find a claim you cannot verify either way.** Do not guess and do not quietly delete
  it — report it, and say what you'd need in order to check.
- **Fixing a doc claim would require a code change.** STOP and report. This plan changes no
  code; a code bug found here is a *finding*, and burying it in a docs PR is how it gets lost.

## Maintenance notes

- These docs have now gone stale twice in two weeks (plans 022, 030). The pattern is that a
  feature batch lands and the docs lag. Consider whether the *plan template* should require a
  CONTEXT.md check as a done criterion — that would fix the cause instead of the symptom.
  Raise it; don't implement it here.
