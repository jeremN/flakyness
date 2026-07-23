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
| E2E (Playwright, real Postgres + built dashboard) | `pnpm --filter dashboard test:e2e` — see `apps/dashboard/e2e/` |
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
- **TypeScript is split across the workspace**: `apps/api` is on **TS 7**;
  `apps/dashboard` is pinned to **TS 6** because `svelte-check` 4.x crashes
  under TS 7 (it reads `ts.default.sys`, which the native rewrite removed).
  Root cause (verified 2026-07-15): TS 7.0 ships no stable *programmatic*
  API, which Svelte's template type-checking needs — so `svelte-check`
  can't run against `tsgo` at all (not just this crash), and Svelte/Vue/
  Astro/MDX are all blocked the same way. Unblocks at **TS 7.1
  (~Oct 2026, upstream estimate)** — stay on TS 6 until then.
  `.github/dependabot.yml` ignores TS majors for the dashboard only; only
  lift that pin once BOTH TS 7.1 has shipped AND a `svelte-check` release
  supports it (latest is still 4.7.2). Track `sveltejs/language-tools#2733`.
- **Dashboard rendered-DOM tests run in Vitest browser mode; the default
  `test` suite stays node-only.** Pure view-logic is extracted to
  `apps/dashboard/src/lib/` (`format.ts`, `status.ts`, `error-page.ts`,
  `href.ts`) and unit-tested in the node env (plain `*.test.ts`, run by
  `pnpm --filter dashboard test`); the `.svelte` components import those
  helpers rather than inlining them. Rendered-DOM tests now run too — but
  via **Vitest browser mode** (isolated
  `apps/dashboard/vitest.browser.config.ts`, `vitest-browser-svelte`,
  headless Chromium), NOT jsdom: `@sveltejs/vite-plugin-svelte@7.2.0` still
  does not apply its `.svelte` transform under **Vitest 4.1.10 + Vite 8.1.4**
  (the jsdom two-project path never compiles the component — `pnpm build`,
  dev, and the Playwright E2E suite all compile `.svelte` fine, the gap is
  Vitest-specific), so browser mode reuses the working dev-server transform
  instead. Run them with `pnpm --filter dashboard test:browser` (files are
  `src/**/*.svelte.test.ts`); they run in the **advisory `component-tests`
  CI job**, while the default `pnpm --filter dashboard test` stays node-only
  / browser-free (`vitest.config.ts` excludes `*.svelte.test.ts`). Route
  render-test files must NOT carry the `+` prefix
  (`page.svelte.test.ts`/`layout.svelte.test.ts`/`error.svelte.test.ts`) —
  SvelteKit's route scanner rejects `+`-prefixed non-reserved files; the
  component imports keep the `+`. Chart pages stub `Chart.svelte`
  (`Chart.stub.svelte`) in these tests, so a rendered assertion still cannot
  catch the chart-registration no-op — that stays guarded by
  `chart-registration.test.ts`. See plans 045 (extraction) and 046 (render
  tests).
- **Tailwind v4 is CSS-first**: config lives in `apps/dashboard/src/app.css`
  (`@import 'tailwindcss'`); do not create a `tailwind.config.js`.
- **Playwright report shape**: real reporter output nests attempts under
  `suites[].specs[].tests[].results[]` — see `apps/api/src/parsers/`.
- **`POST /api/v1/reports` returns `201` before flakiness is recomputed.**
  `routes/reports.ts` fires `updateFlakyTests()` un-awaited, by design, so
  ingest never blocks on recomputation — and `updateFlakyTests` sweeps
  *every* existing `flaky_tests` row for the project (not just names in the
  latest report), so it can resolve an `active` row that has no backing
  `test_results` yet. Any consumer — test, dashboard, or E2E suite — that
  reads `flaky_tests` immediately after an ingest is racing it. This has
  already caused a flaky test in this repo's own suite (plan 027; see its
  `waitFor`-based fix in `apps/api/src/routes/admin.test.ts`). Poll for the
  reconcile to land; never `sleep`.
- **Auto-quarantine lives entirely inside the `ignored` state and is opt-in
  (plan 051).** `reconcileQuarantine()` (`services/quarantine.ts`) runs
  post-ingest **after** `updateFlakyTests`, chained on the same promise in
  `routes/reports.ts` — so the reconcile-race caveat above covers it too;
  under `?wait=true` both are awaited (the quarantine settle bounded by the
  same `withTimeout`). It runs **Promote** only when a project sets
  `auto_quarantine_enabled` (default **false** ⇒ zero behavior change), but
  **Release** (expired auto-mutes → `active`) runs *unconditionally* so
  nothing stays stuck skipped. Provenance is `flaky_tests.mute_source`:
  `'auto'` = machine-quarantined, carries `quarantine_expires_at`,
  auto-released at TTL under a clean-slate rule (re-quarantine needs
  `quarantine_min_runs` runs recorded *after* `quarantine_released_at`);
  `'manual'` / `NULL` = human mute, **indefinite and immune to
  auto-release**. `buildGrepInvert()` still derives from `ignored` (muted)
  rows only — auto-quarantine adds a machine *writer* of `ignored`, it does
  NOT add `active`/`flaky` to `grepInvert`, so the `projects.ts:191-193`
  invariant holds. Threshold comparison is done in JS (fetch active rows,
  compare `Number(flakeRate)`) to dodge Postgres `numeric >= text`.
- **The dashboard `/admin` console spends `ADMIN_TOKEN` server-side (plan
  053).** Reads/writes go through `$lib/server/adminApi.ts` (server-only) and
  SvelteKit form actions — the token never reaches the browser. The console is
  gated by the same `hooks.server.ts` `DASHBOARD_PASSWORD` Basic Auth as every
  other route; the API admin endpoints stay `ADMIN_TOKEN`-gated as the real
  boundary (roadmap #6 owns per-user auth). Delete requires server-side typed
  name confirmation; prune uses the API's two-phase dry-run→confirm.
- **The dashboard needs `ORIGIN` (or `PROTOCOL_HEADER`) set for any admin
  form action to work, found while writing plan 053's E2E spec — the first
  test in the suite to exercise a POST.** `@sveltejs/adapter-node`'s CSRF
  check compares the request's `Origin` header against its own guess at
  `event.url.origin`; without `ORIGIN`/`PROTOCOL_HEADER`, `get_origin()`
  defaults to assuming `https`, so every same-origin POST served over plain
  `http` (the E2E build, and `docker-compose.yml`'s default) 403s as
  `"Cross-site POST form submissions are forbidden"` even though browser and
  server agree on the origin. Fixed by setting `ORIGIN` in both
  `apps/dashboard/playwright.config.ts`'s `webServer.env` (E2E) and
  `docker-compose.yml`'s `dashboard.environment` (real deployments, defaults
  to `http://localhost:3000`) — set it to the externally visible URL, not
  the container's own port, when behind a reverse proxy.

## Conventions

- Structured logger (`apps/api/src/middleware/logger.ts`), never `console.log`.
- zod-validate every input; Drizzle query builder only (no raw SQL with input).
- New endpoints: apply rate limiting, update `docs/API.md`, add a route test.
  New **read** endpoints must also mount `readAuth()` — see plan 041. Guarded
  by `apps/api/src/routes-auth-coverage.test.ts`, which fails CI if a `GET`
  under `/api/v1` has no `readAuth` mounted, and which carries a hard-coded
  route count you must bump deliberately.
- New `projects` child tables need `onDelete: 'cascade'` (project deletion
  relies on FK cascades).
- Any new mute/unmute path must set `flaky_tests.mute_source` and append a
  `quarantine_events` row — the audit trail (auto **and** manual transitions)
  must stay complete (plan 051). Decimal columns (`flake_rate`, `threshold`)
  store strings: write via `.toFixed(4)`, compare via `Number(...)`.
- New dashboard chart types must be registered in `Chart.svelte`'s
  `echarts.use([...])` or they render blank (modular ECharts imports). An
  unregistered series type is a **silent no-op** — no throw, no dev warning
  (compiled out of production builds), axes still paint. Guarded by
  `apps/dashboard/src/lib/components/chart-registration.test.ts` (a static
  scan, not a rendered assertion); the E2E chart spec explicitly cannot
  catch this class of bug.
- **Time-series buckets: no data is `null`, never `0`.** "It didn't run" and
  "it ran and nothing flaked" are different facts — see
  `GET /api/v1/tests/:testName/trend` in `routes/tests.ts`.
- **Mutation testing is automated (Stryker), not just a one-off proof.** A
  nightly `Mutation` GitHub Actions workflow runs Stryker per-package
  (`apps/api` broad; `apps/dashboard` scoped to `$lib`) and gates on
  `scripts/mutation-gate.mjs`, which enforces **per-file floors** over the
  hardened set: `logger.ts`, `rate-limit.ts`, `projects.ts`,
  `$lib/{format,status,error-page,href}.ts`. Floors are baseline-calibrated
  and only bumped deliberately. Run it locally with
  `pnpm --filter <pkg> test:mutation` (API needs a disposable Postgres via
  `docker run`; the dashboard's `$lib` run does not). `pool: 'threads'`
  lives ONLY in `vitest.stryker.config.ts` — never touch the default
  `forks` config used elsewhere. Browser-mode `.svelte` components are NOT
  mutation-tested (Stryker has no browser-mode support) — the A3b render
  tests remain their guard.
- New notification event kinds go through neutral events
  (`services/notifications/events.ts`) + a per-channel formatter, never a new
  bespoke sender. The **`generic` formatter is a frozen backward-compat
  contract** (asserted byte-for-byte); channel is chosen by
  `resolveWebhookKind` (explicit `webhook_kind` overrides host sniff).
  Deep-links come from `DASHBOARD_BASE_URL`, read only at the route edge.
- Commits: single-line conventional-commit subject. NO `Co-Authored-By`
  trailers. `main` is branch-protected — work on branches, PRs need green CI.
