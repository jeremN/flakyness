# Plan 022: Make `.agent/CONTEXT.md` describe the codebase that actually exists

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 1642dc4..HEAD -- .agent/CONTEXT.md docs/GETTING_STARTED.md`
> If either file changed since this plan was written, re-verify the claims in
> "Current state" against the live files before proceeding.

## Status

- **Priority**: P2 (cheap, and it silently misleads every future agent session)
- **Effort**: S
- **Risk**: LOW (documentation only — no code, no schema, no deps)
- **Depends on**: none. Touches no file any other plan touches; safe to run in
  parallel with anything.
- **Category**: docs
- **Planned at**: commit `1642dc4`, 2026-07-13

## Why this matters

`AGENTS.md` — the file every agent and contributor is told to read first —
points at `.agent/CONTEXT.md` as the project's "deep context". That file is
stamped **June 3, 2026** and has not kept up with the nineteen plans that have
landed since. It now actively misinforms: it tells the reader that Prometheus
metrics are still a TODO (they shipped), it describes a parser directory with
one parser (there are two), and it points at a dashboard component that **does
not exist in the repository at all**.

A stale context doc is worse than no context doc, because it is trusted. Every
session that starts by reading it begins with wrong facts, and wrong facts turn
into wrong code. This plan makes the map match the territory.

## Current state

### Verified drift in `.agent/CONTEXT.md`

Each of these was checked against the repo at commit `1642dc4`. The file says
the first thing; the truth is the second.

| `CONTEXT.md` claims | Reality |
|---|---|
| Header: `**Last Updated:** June 3, 2026`, `Phase 6 complete` | 19 plans have landed since; batches 1 and 2 are complete (see `plans/README.md`) |
| Known Issues → `⏳ **Prometheus metrics** endpoint` (still pending) | **Shipped.** `apps/api/src/metrics.ts`, `GET /metrics`, gated by `METRICS_TOKEN` (plan 018, PR #56) |
| Structure → `parsers/` contains only `playwright.ts` | Also `parsers/junit.ts` — JUnit XML ingestion shipped (plan 017, PR #55) |
| Structure → `services/` contains only `flakiness.ts` | Also `services/notifications.ts` — flaky-transition webhooks (plan 016, PR #54) |
| Structure → API `src/` has no `metrics.ts` | `apps/api/src/metrics.ts` exists |
| Structure → dashboard components: `Chart.svelte`, `LoadingSkeleton.svelte`, `ErrorState.svelte` | **`LoadingSkeleton.svelte` does not exist.** Only `Chart.svelte` and `ErrorState.svelte` are in the repo |
| Structure → dashboard routes: `flaky/`, `runs/`, `tests/[testName]/` | Also `analysis/` — the analysis view shipped (plan 014, PR #51) |
| Schema → `projects` columns are `id`, `name`, `token_hash` | Also `flake_threshold`, `window_days`, `min_runs` (plan 013) and `webhook_url` (plan 016) |
| Schema → `test_results` has no metadata columns | Also `tags` and `annotations` (jsonb, plan 015) |
| Flakiness config is a single hardcoded default | Per-project overrides now win over `DEFAULT_CONFIG` via `resolveProjectConfig` (`services/flakiness.ts:29`) |
| No mention of muting | `flaky_tests.status = 'ignored'` + `PATCH /api/v1/tests/flaky/:id` (plan 012). The reconcile upsert deliberately **preserves** `ignored` across ingests |
| Migrations unspecified | `apps/api/drizzle/` holds `0000` … `0005` |

Everything else in the file (the toolchain section, the "Important Patterns"
section, the by-design tradeoffs) was spot-checked and is **still accurate** —
do not rewrite what isn't broken.

### Verified drift in `docs/GETTING_STARTED.md`

`docs/GETTING_STARTED.md:34` still tells a new user to run:

```bash
docker compose up -d
```

Two problems, both confirmed in practice:
1. Bare `docker compose up -d` starts **every** service, not just Postgres, and
   the hard-coded `container_name` values collide with any other checkout of
   this repo on the same machine.
2. `docker compose` refuses to even *parse* its config unless `DB_PASSWORD` and
   `ADMIN_TOKEN` have values (from `.env` or the shell), so a fresh user hits an
   interpolation error rather than a running database.

`AGENTS.md` already documents the safe form, and the batch-1 notes in
`plans/README.md` flagged this touch-up as a candidate follow-up. The safe form
is:

```bash
docker compose up -d postgres && pnpm db:migrate && pnpm dev
```

**Note**: `.env.example` **does** already ship `DB_PASSWORD` — the template is
correct. Do not "fix" `.env.example`; it is not broken.

## Scope

**In scope**:
- `.agent/CONTEXT.md` — bring every claim in the table above in line with reality
- `docs/GETTING_STARTED.md` — the `docker compose up -d` line and its
  surrounding prose only

**Out of scope** (do NOT touch):
- `.env.example` — already correct (see above)
- `AGENTS.md` / `CLAUDE.md` — already accurate; they are the source of truth you
  are reconciling *toward*
- `docs/API.md` — endpoint docs are maintained per-plan and are current
- `IMPLEMENTATION_PLAN.md` — a historical roadmap document; leave it alone
- **Any source file.** This plan changes documentation only. If you find
  yourself editing `.ts` or `.svelte`, you have misread it.

## Git workflow

Branch `advisor/022-refresh-agent-context`; single-line conventional-commit
subject (e.g. `docs: refresh .agent/CONTEXT.md to match the current codebase`);
**no `Co-Authored-By` trailer**; do not push or open a PR unless the operator
instructed it.

## Steps

### Step 1: Re-verify before you write

Do not trust this plan's table blindly — it was written at `1642dc4` and the
repo may have moved. Confirm the current facts yourself:

```bash
git ls-files 'apps/api/src/**' 'apps/dashboard/src/**' | grep -vE '\.(css|png|woff2|svg)$' | sort
git ls-files 'apps/api/drizzle/*.sql'
grep -rhoE "\.(get|post|patch|put|delete)\('[^']*'" apps/api/src/routes/ apps/api/src/index.ts | sort -u
sed -n '/export const projects/,/^}));/p'     apps/api/src/db/schema.ts
sed -n '/export const testResults/,/^}));/p'  apps/api/src/db/schema.ts
```

Where this plan's table and the live repo disagree, **the repo wins** — and say
so in your report.

**Verify**: you can state, from your own reads, the current parser list, service
list, dashboard route list, dashboard component list, and migration count.

### Step 2: Update `.agent/CONTEXT.md`

Correct every row in the drift table. Specifically:

1. Update the header: `**Last Updated:**` to today's date, and replace the
   `Phase 6 complete` status line with a one-line statement of where the project
   actually is (batches 1 and 2 of the improve backlog complete; 19 plans landed
   — cite `plans/README.md` as the authority rather than duplicating the table).
2. Fix the project-structure tree: add `metrics.ts`, `parsers/junit.ts`,
   `services/notifications.ts`, the dashboard `analysis/` route; **delete the
   `LoadingSkeleton.svelte` line** (the component does not exist).
3. Update the schema section: add the new `projects` columns
   (`flake_threshold`, `window_days`, `min_runs`, `webhook_url`) and the
   `test_results` columns (`tags`, `annotations`), and note migrations run
   `0000`–`0005`.
4. Update the flakiness section: `DEFAULT_CONFIG` is the *fallback*;
   per-project overrides resolve over it via `resolveProjectConfig`.
5. Add short subsections for the three capabilities the file doesn't know about:
   **muting** (`status='ignored'`, preserved across ingests by the reconcile
   upsert — this is a non-obvious invariant worth stating), **webhooks**
   (per-project `webhook_url`, fired on flaky transitions, failures isolated
   from the ingest path), and **metrics** (`GET /metrics`, off unless
   `METRICS_TOKEN` is set, project-only label cardinality).
6. In "Known Issues & TODOs": move Prometheus metrics to done. Leave **E2E tests
   (Playwright)** as still-pending — that is accurate; the repo has no
   `playwright.config` and no spec files.
7. Preserve the file's existing voice, structure, and the by-design tradeoffs
   section (unauthenticated read APIs, in-memory rate limiter, in-memory
   flakiness aggregation). Those are still true and deliberately chosen. **This
   is an update, not a rewrite.**

**Verify**: `grep -c "LoadingSkeleton" .agent/CONTEXT.md` → `0`.
`grep -n "Prometheus" .agent/CONTEXT.md` → no longer marked pending.

### Step 3: Fix the GETTING_STARTED dev-start command

Replace the bare `docker compose up -d` at `docs/GETTING_STARTED.md:34` with the
safe form, and add one sentence explaining *why* (starts only Postgres; avoids
the container-name collision with other checkouts; `docker compose` needs
`DB_PASSWORD` and `ADMIN_TOKEN` to be set — copy `.env.example` to `.env` first).

Keep the edit tight: this is one command and a sentence, not a rewrite of the
onboarding doc.

**Verify**: `grep -n "docker compose up -d" docs/GETTING_STARTED.md` shows only
the `postgres`-scoped form.

## Test plan

There is no test suite for documentation. The verification is the greps in the
steps above plus these repo-wide consistency checks — every file `CONTEXT.md`
names must exist:

```bash
# Every source path CONTEXT.md mentions should resolve.
# LoadingSkeleton.svelte is the known offender; after this plan there should be none.
grep -oE '[a-zA-Z0-9_./\[\]-]+\.(ts|svelte|sql|md|yml)' .agent/CONTEXT.md \
  | sort -u | while read -r f; do
      find . -path ./node_modules -prune -o -name "$(basename "$f")" -print -quit \
        | grep -q . || echo "STILL MISSING: $f"
    done
```

Expected: no `STILL MISSING` lines for files under `apps/`.

## Done criteria

- [ ] `grep -c "LoadingSkeleton" .agent/CONTEXT.md` returns `0`
- [ ] `.agent/CONTEXT.md` names `metrics.ts`, `parsers/junit.ts`, `services/notifications.ts`, and the dashboard `analysis/` route
- [ ] The schema section lists the `projects` override columns + `webhook_url`, and `test_results.tags` / `.annotations`
- [ ] Prometheus metrics is no longer listed as pending; E2E tests still is
- [ ] `docs/GETTING_STARTED.md` no longer tells a new user to run bare `docker compose up -d`
- [ ] The consistency check in the test plan prints no `STILL MISSING` lines for `apps/` paths
- [ ] `git status`: ONLY `.agent/CONTEXT.md` and `docs/GETTING_STARTED.md` modified — **no source files**

## STOP conditions

Stop and report (do not improvise) if:

- Step 1's re-verification contradicts this plan's drift table in a way that
  changes what should be written (e.g. `LoadingSkeleton.svelte` now exists, or a
  parser was removed). Report the discrepancy; do not silently write either
  version.
- You find yourself needing to change source code to make a documented claim
  true. The doc follows the code here, never the reverse — if the code looks
  wrong, that is a finding to report, not to fix in this plan.
- The by-design tradeoffs section looks wrong to you. Those are deliberate,
  maintainer-owned decisions (see `plans/README.md` → "Findings considered and
  rejected"). Report; do not rewrite.

## Maintenance notes

- This file drifts *because nothing forces it to keep up*. The durable fix is a
  habit, not a document: any plan that adds a route, a table column, a parser,
  or a service should update `.agent/CONTEXT.md` in the same PR. Consider adding
  that line to `AGENTS.md`'s conventions list in a future pass — this plan
  deliberately does not, to keep its diff to documentation it was asked to fix.
- The `LoadingSkeleton.svelte` entry is the tell to watch for: it survived
  because nobody cross-checked the structure tree against `git ls-files`. The
  consistency check in the test plan is cheap enough to re-run any time someone
  edits the file.
