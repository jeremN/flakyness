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
- **`pnpm --filter dashboard check` can, in principle, report phantom errors
  if you exported `.env` in that shell — but no test file currently triggers
  it.** `svelte-kit sync` generates the `$env/dynamic/private` `env` type from
  **the ambient environment at sync time**, declaring every variable it
  happens to find as a *required* `string` (verified 2026-08-15: exporting
  `ADMIN_TOKEN` or `COOKIE_SECURE` still bakes both into
  `.svelte-kit/ambient.d.ts` as non-optional). A `delete privateEnv.X` on a
  key the ambient scan found used to fail as TS2790 *"The operand of a
  'delete' operator must be optional"* — this bit `adminApi.test.ts`'s
  `delete privateEnv.ADMIN_TOKEN` (×3) until plan 059 Task 2 removed that
  import entirely, and the pattern is now further insulated: the tests that
  still `delete` an env var (`login/page.server.test.ts`,
  `change-password/page.server.test.ts`, both on `COOKIE_SECURE`) import a
  dedicated `tests/env-private-stub.ts` (`Record<string, string |
  undefined>`) instead of the real `$env/dynamic/private`, so their types
  never depend on the ambient scan at all. Confirmed 2026-08-15 with both
  `ADMIN_TOKEN` and `COOKIE_SECURE` exported: same 521 files, **0 errors**.
  The underlying mechanism is unchanged, though, so a *future* test file that
  imports `$env/dynamic/private` directly and `delete`s a key present in your
  shell could still trip this — run typechecks in a clean shell (`env -u
  ADMIN_TOKEN pnpm --filter dashboard check`) before trusting a failure that
  looks unrelated to your change.
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
  tests). **Browser-mode tests apply NO Tailwind CSS**, found while writing
  plan 059 Task 8: `vitest.browser.config.ts` registers only `sveltekit()`,
  not the `tailwindcss()` plugin `vite.config.ts` also registers (with a
  comment that the order matters) — so `@import "tailwindcss"` is never
  expanded and no utility classes are generated. Measured: `class="flex"`
  computes `display: block` and `sticky` computes `position: static`, with
  36 CSS rules present versus Tailwind's thousands. Consequence: **no
  browser-mode test can honestly assert a computed style** — the codebase's
  `toHaveClass` convention is a necessity here, not a style preference.
  Whether to register `tailwindcss()` too is an open follow-up (see
  `plans/README.md`); it is not a trivial flip, since real CSS could hide
  elements that `vitest-browser-svelte`'s visibility-checking locators
  currently find.
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
- **The dashboard authenticates users, not a shared password (plan 059).**
  `DASHBOARD_PASSWORD` is **gone**; `hooks.server.ts` validates the `fk_session`
  cookie against `GET /auth/me` and redirects anonymous traffic to `/login`.
  The dashboard **no longer holds `ADMIN_TOKEN`** — `$lib/server/adminApi.ts`
  forwards the signed-in user's session, and the API authorizes per user
  (plan 058). `ADMIN_TOKEN` remains a valid API credential for operators and
  scripts. On upgrade an operator MUST create their first global admin via
  `POST /api/v1/admin/users` with `ADMIN_TOKEN` before they can sign in — see
  `docs/GETTING_STARTED.md`.
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
- **Quarantine promotion is rule-driven once a project has ≥1 enabled
  `quarantine_rules` row (plan 054).** `reconcileQuarantine()` prefers
  `promoteWithRules` over the plan-051 `promoteLegacy` path whenever
  `quarantine_rules` has enabled rows for the project (ordered by
  `position`, first-match-wins on selectors; an `exempt` action stops
  promotion outright); a test that matches no rule falls back to the
  project's legacy `quarantineThreshold` decision, so the two paths never
  diverge. A `consecutive` rule can quarantine a test that is **not yet**
  globally flaky (no `active` `flaky_tests` row) — the promote path
  therefore **upserts** the `flaky_tests` `ignored` row rather than
  updating one in place, widening the candidate set beyond active rows.
  Manual/`NULL` `mute_source` mutes stay immune either way — never
  converted to `auto`, never auto-released. A rule-driven promotion still
  writes `mute_source='auto'` plus a `quarantine_events` row, now carrying
  `rule_id` for provenance. `buildGrepInvert()` and base flakiness
  measurement are untouched — rules only gate the *promote* phase. CRUD +
  reorder for rules is live on the API (`/api/v1/admin/projects/:id/rules`,
  `routes/admin.ts`); a dashboard console UI to manage them is a deferred
  fast-follow (see `plans/README.md`).
- **Every read route needs BOTH `readAuth()` and `resolveAccess()`, sharing one
  resolver (plan 058).** `readAuth` decides *whether* the caller may read
  (`READ_TOKEN` posture, plan 041); `resolveAccess` decides *which projects*
  (team membership) and 404s — never 403s — on a cross-team read. Both are
  enforced by `routes-auth-coverage.test.ts`, which carries a hard-coded route
  count you must bump deliberately. **Anonymous callers stay unscoped**: teams
  scope identified callers only, so an install that left `READ_TOKEN` unset
  behaves exactly as it did before teams existed. Two routes
  (`GET/PATCH /tests/flaky/:id`) resolve their project from a row rather than
  the request, so they mount `resolveAccess()` without a resolver and check via
  `assertProjectReadable()` in the handler — the static guard cannot see those,
  `access-scope.test.ts` covers them.
- **A Drizzle column interpolated into a raw `sql` correlated subquery binds
  to the wrong table.** On a single-table select with no joins, Drizzle
  treats an interpolated column's table qualifier as redundant and drops it
  — `${projects.id}` inside a `sql` template renders as bare `"id"`. Fine at
  the top level (only one table in scope), but inside a nested `select ...
  from other_table where ...` subquery that bare `"id"` binds to
  `other_table.id`, not the outer row — e.g. `test_runs.project_id =
  ${projects.id}` silently became `test_runs.project_id = test_runs.id`
  (`GET /api/v1/admin/projects`'s stats, essentially never true, pinned at 0
  since these fields shipped — caught because `typeof x === 'number'` can't
  fail on `0`; fixed by asserting seeded values). Write the outer column as
  raw SQL text instead (`where test_runs.project_id = projects.id`, no
  `${}`) — Postgres case-folds the unquoted identifier to lowercase, which
  matches Drizzle's quoted lowercase table name. Always verify with
  `.toSQL().sql` on both sides; don't assume.
- **`mustChangePassword` is enforced in TWO places, and the gate's mount
  position is load-bearing.** `passwordChangeGate()`
  (`middleware/password-change.ts`) is mounted `use('*')` inside **each** of
  the seven `/api/v1` routers, immediately **after** that router's rate
  limiter — never as a global `app.use()`. A denial returns without calling
  `next()`, so a global mount would run ahead of every per-router limiter and
  starve it: a mid-reset session could then hammer any non-allowlisted path
  unthrottled, each request still paying the session DB lookup that already
  runs globally in `sessionAuth` (`middleware/session.ts:45,49`). The one
  `/api/v1` endpoint that belongs to no router — `GET /api/v1`, the version
  stub in `index.ts` — takes the gate as **route-level** middleware
  (`app.get('/api/v1', passwordChangeGate(), handler)`), never
  `app.use('/api/v1', ...)`, which would match the whole subtree from the root
  app and starve all seven limiters. Guarded by
  `password-change-coverage.test.ts`: named mounts in the right order, the
  auth-route decision list, and — the assertion that actually catches a NEW
  ungated router — a completeness check that derives the `/api/v1` surface
  from `app.routes` and demands every route be covered by some mount. The
  named-inventory assertions cannot do that job: a router with no gate
  contributes nothing to the set they compare, so both sides stay equal and
  they pass. `routes-auth-coverage.test.ts` cannot either — it filters on
  `method === 'GET'`, so a write-only router is invisible to it. A 429
  regression test covers the mount-order hazard. The gate must `return c.json(...)`, **not**
  throw `HTTPException` — the global error handler (`index.ts:44-51`) renders
  exceptions as `c.json({ error: err.message }, err.status)`, which drops the
  `code` field entirely. Layer 1 (short-circuits in `services/auth/access.ts`'s
  four predicates — `canReadProject`, `canWriteProject`, `canAdministerTeams`,
  `canEnterAdminApi`) is the backstop for a router that forgets to mount the
  gate, but it is **not** a second copy of the gate's contract: each predicate
  just returns `false`, so the caller falls through to whatever that route
  already does on a normal denial. That is **three** outcomes, not two —
  `404` existence-hiding for the two project-scoped predicates on a
  single-project route; a *different*, code-less `403` (e.g. `'Global admin
  required'`) for the two team/admin-scoped ones; and **`200` with an empty
  list** on the two LIST routes (`GET /api/v1/projects`,
  `GET /api/v1/admin/projects`), which filter rather than refuse. Only the
  gate guarantees the uniform `403 password_change_required` contract, which
  is why it — not the predicates — owns it. The list routes reach layer 1
  through a **fifth** predicate, `scopesProjectList`, whose polarity is
  inverted from the other four: it returns "should this list be filtered", so
  `true` is the safe answer and `false` skips `canReadProject` entirely.
  It therefore checks `requiresPasswordChange` **first**, ahead of its
  `isGlobalAdmin` shortcut — without that, a mid-reset *global admin* took the
  unfiltered branch and layer 1 never ran at all for the highest-privilege
  caller on the instance.
- **The E2E suite needs `TRUSTED_PROXY_IPS` set on the API process, or every
  Playwright worker shares one rate-limit bucket again (plan 059 Task 8 fix
  round 1).** `hooks.server.ts` calls `GET /api/v1/auth/me` on every
  server-rendered page view, and the dashboard's `webServer.env` in
  `playwright.config.ts` sets `ADDRESS_HEADER=x-forwarded-for` plus
  `apps/dashboard/e2e/fixtures.ts` gives every worker its own
  `X-Forwarded-For` value — but the API only *trusts* that header from a
  socket address listed in `TRUSTED_PROXY_IPS`. Without it, `getClientIp`
  falls back to the (identical, loopback) socket address for every worker,
  and the whole suite's traffic goes back to sharing one `apiRateLimit`
  bucket (100/fixed-60s-window), intermittently 429ing `GET /auth/me` and
  spuriously signing out whichever request lost the race — reproduced and
  root-caused during this fix round (see the Task 8 report). CI sets it in
  `.github/workflows/ci.yml`'s `e2e` job env; running the suite locally
  needs it set wherever the API process is started (`TRUSTED_PROXY_IPS=127.0.0.1`
  when both processes are on localhost, which is the normal case — see
  `docs/GETTING_STARTED.md`'s explanation of the same variable for real
  deployments). **A missing `ADDRESS_HEADER`-supplied header 500s**: verified
  directly against a built dashboard that a request with no
  `x-forwarded-for` fails once `ADDRESS_HEADER` is set, so this is not a
  silent degrade for the dashboard's OWN requests — only for the API's trust
  decision, which fails silently back to one shared bucket. Every browser
  context this suite creates (every Playwright worker, and
  `global-setup.ts`'s own seeding login) must send the header for this
  reason — both already do.
  **`ADDRESS_HEADER` is a test-harness setting here — do NOT carry it into a
  deployment just because this sharp edge presents it as the fix.** The
  shared-rate-limit-bucket symptom above reappears in production the moment
  the dashboard sits behind a reverse proxy, so the trail is tempting.
  `ADDRESS_HEADER` makes adapter-node trust whatever `X-Forwarded-For` it is
  handed, and it is safe in production **only** behind a proxy that
  *overwrites* that header (nginx `proxy_set_header X-Forwarded-For
  $remote_addr`) — never one that *appends* to a client-supplied value. Set it
  on a dashboard that is directly reachable and every client picks its own
  `authRateLimit` bucket by choosing its own address, which defeats the login
  brute-force throttle outright. It is deliberately absent from
  `docker-compose.yml`, `.env.example` and `docs/`; shipping it needs the
  proxy guidance shipped with it (recorded as a follow-up in
  `plans/README.md`).

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
  `docker run` **and `ADMIN_TOKEN` exported** — `routes/projects.test.ts`
  gates on `hasDatabase && hasAdminToken`, so without the token that suite
  self-skips, its ~245 mutants report `NoCoverage`, and `projects.ts` scores
  ~4% against its floor of 61: a fake regression that is really an unrun
  suite. The dashboard's `$lib` run needs neither.) `pool: 'threads'`
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
