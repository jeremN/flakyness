# Flackyness — agent guide

Self-hosted flaky-test tracker: ingests Playwright JSON reports from CI
(Hono + Drizzle + Postgres API), computes flake rates, shows them in a
SvelteKit dashboard. Deep context: `.agent/CONTEXT.md`. API contract:
`docs/API.md`. Plans/backlog: `plans/README.md`.

## Commands

| Task | Command |
|------|---------|
| Install | `corepack enable && pnpm install` |
| Dev (API :8080 + dashboard :5173) | `docker compose up -d postgres && pnpm db:migrate && pnpm dev` |
| Lint (oxlint, NOT eslint) | `pnpm lint` |
| Typecheck API | `pnpm --filter api exec tsc --noEmit` |
| Typecheck dashboard | `pnpm --filter dashboard check` |
| Tests | `pnpm test` (API route suites need `DATABASE_URL` + `ADMIN_TOKEN`, else they self-skip; dashboard suite always runs) |
| Build | `pnpm build` |

## Sharp edges

- **pnpm 11 hardening**: `minimumReleaseAge: 1440` — a version published
  <24h ago won't install; pin one release back. Dependency build scripts are
  blocked unless allowlisted in `pnpm-workspace.yaml` `allowBuilds`.
- **`pnpm db:migrate` needs a root `.env` to exist** (it runs
  `tsx --env-file=../../.env`, which hard-fails on a missing file) —
  `touch .env` on a fresh clone; the actual values can come from the
  environment. `docker compose` also refuses to even parse its config
  unless `DB_PASSWORD` and `ADMIN_TOKEN` have values (from `.env` or the
  shell).
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
- New `projects` child tables need `onDelete: 'cascade'` (project deletion
  relies on FK cascades).
- New dashboard chart types must be registered in `Chart.svelte`'s
  `echarts.use([...])` or they render blank (modular ECharts imports).
- Commits: single-line conventional-commit subject. NO `Co-Authored-By`
  trailers. `main` is branch-protected — work on branches, PRs need green CI.
