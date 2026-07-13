# Plan 011: Add a root AGENTS.md + CLAUDE.md so agents auto-load the project context

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f8b0cc..HEAD -- .agent/ package.json pnpm-workspace.yaml .github/workflows/ci.yml`
> The facts baked into the doc below (commands, toolchain pins) come from
> these files at `0f8b0cc`. If they changed, update the corresponding lines
> in the doc you write — do NOT copy stale facts.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (new files only)
- **Depends on**: none (but write it AFTER other plans in this batch land, or
  re-verify the command table against reality when you write it)
- **Category**: dx
- **Planned at**: commit `0f8b0cc`, 2026-07-10

## Why this matters

This repo is maintained largely through coding agents, and its single richest
orientation document lives at `.agent/CONTEXT.md` — a path no agent tooling
auto-loads. Claude Code loads `CLAUDE.md`; most other agents (Codex, Cursor,
Gemini CLI, …) load `AGENTS.md`. Without them, every session re-discovers the
repo's sharp edges (pnpm-11 supply-chain gating, oxlint-not-eslint, Tailwind
v4 CSS-first config, TS-6 deprecation bridge) the hard way. A ~60-line root
doc that front-loads commands + gotchas and points to `.agent/CONTEXT.md` for
depth fixes this permanently.

## Current state

- Repo root has NO `CLAUDE.md` and NO `AGENTS.md` (verify:
  `ls CLAUDE.md AGENTS.md 2>&1` → both "No such file").
- `.agent/CONTEXT.md` — 630-line agent handoff guide (project overview, data
  flow, schema, patterns, known issues). Keep it as the deep reference; the
  new root doc must LINK to it, not duplicate it.
- Verified toolchain facts to encode (from `package.json`,
  `pnpm-workspace.yaml`, `.github/workflows/ci.yml`, `.oxlintrc.json`):
  - pnpm 11.5.1 pinned via `packageManager`; use `corepack enable`.
  - `pnpm-workspace.yaml`: `minimumReleaseAge: 1440` (versions <24h old
    won't install — pin one release back if "latest" fails) and
    `allowBuilds` (dependency build scripts blocked by default; new ones
    must be allowlisted there after auditing).
  - Lint = oxlint (`pnpm lint` → `oxlint --deny-warnings apps/`) — NOT eslint.
  - Typecheck = `pnpm --filter api exec tsc --noEmit` +
    `pnpm --filter dashboard check` (svelte-check).
  - Tests = `pnpm --filter api test` (vitest; route suites self-skip without
    `DATABASE_URL` + `ADMIN_TOKEN`; CI provides real Postgres 16).
    [If plan 007 landed: also `pnpm --filter dashboard test`.]
  - Root `tsconfig.json` carries `"ignoreDeprecations": "6.0"` (TS-6 bridge).
  - Dashboard: Tailwind v4 via `@tailwindcss/vite`, config is CSS-first in
    `src/app.css` (no `tailwind.config.js` — deleted by plan 009 [verify]).
  - Git: `main` is branch-protected (PRs + green CI); conventional-commit
    single-line subjects (see `git log --oneline`).
- User-level convention that must be REPEATED at repo level for other agents:
  commit messages are single-line conventional-commit subjects with NO
  `Co-Authored-By` trailers.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Verify facts | `grep -n "packageManager" package.json` etc. per Current state | matches |
| Lint (unchanged) | `pnpm lint` | exit 0 |

## Scope

**In scope** (create only):
- `AGENTS.md` (repo root — canonical content)
- `CLAUDE.md` (repo root — one-line import of AGENTS.md)

**Out of scope** (do NOT touch):
- `.agent/CONTEXT.md` — stays the deep reference (other plans edit it).
- Any code or config file.

## Git workflow

- Branch: `advisor/011-root-agents-md`
- Conventional-commit, single-line subject only (e.g.
  `docs: add root AGENTS.md and CLAUDE.md`). Do NOT add any `Co-Authored-By`
  trailer. Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write `AGENTS.md`

Create it with this structure (verify every fact against the live files per
the drift check; adjust bracketed items to what has actually landed):

```markdown
# Flackyness — agent guide

Self-hosted flaky-test tracker: ingests Playwright JSON reports from CI
(Hono + Drizzle + Postgres API), computes flake rates, shows them in a
SvelteKit dashboard. Deep context: `.agent/CONTEXT.md`. API contract:
`docs/API.md`. Plans/backlog: `plans/README.md`.

## Commands

| Task | Command |
|------|---------|
| Install | `corepack enable && pnpm install` |
| Dev (API :8080 + dashboard :5173) | `docker compose up -d && pnpm db:migrate && pnpm dev` |
| Lint (oxlint, NOT eslint) | `pnpm lint` |
| Typecheck API | `pnpm --filter api exec tsc --noEmit` |
| Typecheck dashboard | `pnpm --filter dashboard check` |
| Tests | `pnpm test` (API route suites need `DATABASE_URL` + `ADMIN_TOKEN`, else they self-skip) |
| Build | `pnpm build` |

## Sharp edges

- **pnpm 11 hardening**: `minimumReleaseAge: 1440` — a version published
  <24h ago won't install; pin one release back. Dependency build scripts are
  blocked unless allowlisted in `pnpm-workspace.yaml` `allowBuilds`.
- **TS 6 bridge**: root tsconfig sets `ignoreDeprecations: "6.0"`; migrate
  the deprecated options before any TS 7 upgrade.
- **Tailwind v4 is CSS-first**: config lives in `apps/dashboard/src/app.css`
  (`@import 'tailwindcss'`); do not create a `tailwind.config.js`.
- **Playwright report shape**: real reporter output nests attempts under
  `suites[].specs[].tests[].results[]` — see `apps/api/src/parsers/`.

## Conventions

- Structured logger (`apps/api/src/middleware/logger.ts`), never `console.log`.
- zod-validate every input; Drizzle query builder only (no raw SQL with input).
- New endpoints: apply rate limiting, update `docs/API.md`, add a route test.
- New `projects` child tables need `onDelete: 'cascade'`.
- Commits: single-line conventional-commit subject. NO `Co-Authored-By`
  trailers. `main` is branch-protected — work on branches, PRs need green CI.
```

**Verify**: `test -f AGENTS.md && head -1 AGENTS.md` → `# Flackyness — agent guide`; every command in the table executes (at minimum run `pnpm lint` and one typecheck to prove the table isn't aspirational).

### Step 2: Write `CLAUDE.md`

Exactly:

```markdown
@AGENTS.md
```

(Claude Code resolves `@`-imports; this keeps one canonical doc.)

**Verify**: `cat CLAUDE.md` → the single import line.

### Step 3: Cross-link from the deep doc

No edit to `.agent/CONTEXT.md` in this plan (out of scope) — instead confirm
the pointer direction is root→deep only, which Step 1 already established.

**Verify**: `grep -n ".agent/CONTEXT.md" AGENTS.md` → ≥ 1 match.

## Test plan

Not applicable (docs). Gate: the command-table execution check in Step 1.

## Done criteria

ALL must hold:

- [ ] `AGENTS.md` exists, ≤ ~80 lines, links `.agent/CONTEXT.md`, `docs/API.md`, `plans/README.md`
- [ ] `CLAUDE.md` exists containing exactly `@AGENTS.md`
- [ ] Every command in the AGENTS.md table verified runnable (or corrected)
- [ ] `git status` shows only the two new files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A `CLAUDE.md` or `AGENTS.md` appears at the root before you start (another
  plan/session created one) — reconcile, don't overwrite.
- A command in the table fails when you verify it — fix the table to reality
  if the cause is obvious (e.g. plan 007 not landed yet → drop the dashboard
  test row), otherwise report.

## Maintenance notes

- This doc rots fastest of anything in the repo: any plan that changes
  commands or toolchain MUST touch AGENTS.md in the same PR (add to reviewer
  checklist).
- If the repo later adopts the `.agents/` cross-agent skills dir for docs
  too, keep AGENTS.md as the entry point.
