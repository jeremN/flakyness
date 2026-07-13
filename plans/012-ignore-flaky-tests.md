# Plan 012: Let operators mute a flaky test (ignore/unignore route + dashboard action)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7609d55..HEAD -- apps/api/src/routes/tests.ts apps/api/src/middleware/auth.ts apps/dashboard/src/routes/flaky/ apps/dashboard/src/lib/api.ts docs/API.md`
> On a mismatch with the excerpts below, re-read the live code; contradictions are a STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW–MED (first write path in the dashboard; new admin-authed mutation)
- **Depends on**: none (plan 006's `ignored`-preservation semantics are already on main)
- **Category**: feature (direction D1)
- **Planned at**: commit `7609d55`, 2026-07-10

## Why this matters

The mute feature is 90% built and 0% usable. `flaky_tests.status` models
`'ignored'` (`apps/api/src/db/schema.ts:68`), the reconcile service
deliberately preserves `ignored` across ingests and never auto-resolves it
(`apps/api/src/services/flakiness.ts` — the `CASE WHEN ... = 'ignored'`
conflict expression; contract pinned by the two DB-gated tests in
`flakiness.test.ts`: "preserves ignored status…" and "leaves an ignored row
ignored…"), the read API accepts `?status=ignored`
(`apps/api/src/routes/projects.ts`), and the dashboard styles an `ignored`
badge (`flaky/+page.svelte:23`). But **no route sets the status and no UI
triggers it** — an operator staring at a known-flaky test cannot silence it.

## Current state

- `apps/api/src/routes/tests.ts` — GET-only router (`/:testName/history`,
  `/flaky/:id`), `apiRateLimit` on `'*'`, local `uuidSchema`. The
  `GET /flaky/:id` handler (lines 100–117) selects one row by id, 404s when
  absent — the PATCH goes right below it, same style.
- `apps/api/src/middleware/auth.ts` — `adminAuth()` (global `ADMIN_TOKEN`
  Bearer) and `projectAuth()` (per-project token). Mute is a management
  action → `adminAuth()`.
- `apps/dashboard/src/lib/api.ts` — GET-only fetchers through `fetchJson`
  (which maps failures to kit `error()`s). `API_URL` from
  `$env/dynamic/public`. There is NO write fetcher and NO private env usage
  anywhere in the dashboard yet.
- `apps/dashboard/src/routes/flaky/+page.server.ts` — loads
  `getFlakyTests(selectedProject.id, status)`; status from
  `url.searchParams`, default `'active'`. No form actions exist in the app.
- `apps/dashboard/src/routes/flaky/+page.svelte` — filter pills Active /
  Resolved / All (lines 50–69); table rows show a status badge (line 134);
  `getStatusBadgeClass` already handles `'ignored'`.
- Status semantics: `'resolved'` is SYSTEM-managed (set by reconcile);
  `'ignored'`/`'active'` are the only operator-settable values.

## Design decisions (made by the advisor — do not relitigate)

1. Route: `PATCH /api/v1/tests/flaky/:id` with JSON body
   `{ "status": "ignored" | "active" }` (zod enum — `resolved` deliberately
   NOT accepted), guarded by `adminAuth()`. Returns `{ flakyTest }` (updated
   row), 404 if the id doesn't exist.
2. Dashboard writes go through a SvelteKit **form action** (server-side), so
   the admin token never reaches the browser. The dashboard reads
   `ADMIN_TOKEN` from `$env/dynamic/private`. When unset, the mute buttons
   are hidden (read-only mode preserved).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck API / dashboard | `pnpm --filter api exec tsc --noEmit` / `pnpm --filter dashboard check` | exit 0 / 0 errors 0 warnings |
| Tests | `pnpm --filter api test` (DB-gated suites need `DATABASE_URL`+`ADMIN_TOKEN`) / `pnpm --filter dashboard test` | pass |
| Disposable DB | `docker run -d --name flackyness-test-pg-012 -e POSTGRES_PASSWORD=test_password -e POSTGRES_DB=flackyness_test -p 5433:5432 postgres:16-alpine` then `touch .env` at repo root, then `DATABASE_URL=postgres://postgres:test_password@localhost:5433/flackyness_test pnpm db:migrate` | migrated |
| Lint | `pnpm lint` (if output is garbled by a shell wrapper: `rtk proxy pnpm lint`) | exit 0 |

Do NOT use `docker compose up` (operator's dev stack may be running).
ALWAYS clean up: `docker rm -f flackyness-test-pg-012`, delete the temp `.env`.

## Scope

**In scope**:
- `apps/api/src/routes/tests.ts` (PATCH handler)
- `apps/api/src/routes/tests.test.ts` (route tests)
- `apps/dashboard/src/routes/flaky/+page.server.ts` (form action + Ignored filter passthrough)
- `apps/dashboard/src/routes/flaky/+page.svelte` (mute/unmute buttons + Ignored filter pill)
- `docs/API.md` (document the PATCH)
- `AGENTS.md` maintenance note ONLY if a command changes (none expected)

**Out of scope**: `services/flakiness.ts` (semantics already correct);
`middleware/auth.ts`; any other route; per-project thresholds (plan 013);
dashboard auth/login (the private-env pattern IS the v1 answer).

## Git workflow

- Branch: `advisor/012-ignore-flaky-tests`
- Conventional commits, single-line subjects (e.g.
  `feat(api): PATCH /tests/flaky/:id to ignore/unignore`). NO
  `Co-Authored-By` trailers. Do not push/PR unless the operator instructed it.

## Steps

### Step 1: API route

In `apps/api/src/routes/tests.ts`, add below the `GET /flaky/:id` handler:

```ts
const flakyStatusPatchSchema = z.object({
  status: z.enum(['ignored', 'active']),
});

/**
 * PATCH /api/v1/tests/flaky/:id
 *
 * Set a flaky test's status to 'ignored' (mute) or 'active' (unmute).
 * 'resolved' is system-managed and not accepted here.
 */
testsRouter.patch('/flaky/:id', adminAuth(), async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return c.json({ error: 'Invalid flaky test ID format' }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsedBody = flakyStatusPatchSchema.safeParse(body);
  if (!parsedBody.success) {
    return c.json({ error: "status must be 'ignored' or 'active'" }, 400);
  }

  const [flakyTest] = await db
    .update(flakyTests)
    .set({ status: parsedBody.data.status })
    .where(eq(flakyTests.id, parsed.data))
    .returning();

  if (!flakyTest) {
    return c.json({ error: 'Flaky test not found' }, 404);
  }

  return c.json({ flakyTest });
});
```

Import `adminAuth` from `../middleware/auth`. Match the file's existing
style exactly (see the GET handlers).

**Verify**: `pnpm --filter api exec tsc --noEmit` → exit 0.

### Step 2: API route tests

In `apps/api/src/routes/tests.test.ts` (existing DB-gated suite that seeds a
project + ingests `fixtures/sample-report.json` in `beforeAll`), add a
`describe('PATCH /api/v1/tests/flaky/:id')` block. To obtain a real flaky
row, upload the report twice more with different `commit` values if needed,
or insert a `flaky_tests` row directly via drizzle (both patterns exist in
the repo's tests — direct insert is simpler; see
`flakiness.test.ts` seed helpers). Cases:

1. No auth header → 401. Wrong token → 401.
2. Valid admin token + `{status:'ignored'}` → 200, `flakyTest.status === 'ignored'`; re-GET via `/tests/flaky/:id` confirms persistence.
3. `{status:'active'}` flips it back → 200.
4. `{status:'resolved'}` → 400. `{status:'bogus'}` → 400. Non-JSON body → 400.
5. Valid body, unknown UUID → 404; malformed id → 400.
6. (Integration with plan 006 semantics) after setting `ignored`, run
   `updateFlakyTests(projectId)` (import from `../services/flakiness`) and
   assert status is STILL `ignored`.

**Verify**: with DB env, `pnpm --filter api test` → all pass (baseline 105 + new cases); without DB env → exit 0 with skips.

### Step 3: Dashboard form action

In `apps/dashboard/src/routes/flaky/+page.server.ts`:

- Import `env` from `$env/dynamic/private` and `fail` from `@sveltejs/kit`.
- Extend the load return with `canMute: Boolean(env.ADMIN_TOKEN)`.
- Add an `actions` export:

```ts
export const actions = {
  setStatus: async ({ request }) => {
    if (!env.ADMIN_TOKEN) return fail(403, { message: 'Muting is not configured' });
    const form = await request.formData();
    const id = String(form.get('id') ?? '');
    const status = String(form.get('status') ?? '');
    if (!id || (status !== 'ignored' && status !== 'active')) {
      return fail(400, { message: 'Invalid request' });
    }
    const apiUrl = publicEnv.PUBLIC_API_URL || 'http://localhost:8080';
    const res = await fetch(`${apiUrl}/api/v1/tests/flaky/${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) return fail(res.status === 404 ? 404 : 502, { message: 'Failed to update status' });
    return { success: true };
  },
} satisfies Actions;
```

(`publicEnv` = `$env/dynamic/public`; import `Actions` type from `./$types` —
if that widens types under svelte-check, type locally like
`+page.server.ts` on the overview does.) Note the deliberate direct `fetch`
here instead of `lib/api.ts` — `fetchJson` throws kit errors for LOADS;
actions want `fail()`.

**Verify**: `pnpm --filter dashboard check` → 0 errors, 0 warnings.

### Step 4: Dashboard UI

In `apps/dashboard/src/routes/flaky/+page.svelte`:

1. Add an `Ignored` filter pill between `Resolved` and `All` (same
   `getFilterHref('ignored')` pattern — the API already supports it).
2. Add an Actions column to the table. Per row, when `data.canMute`, render
   a small form (`method="POST" action="?/setStatus"` with
   `use:enhance` from `$app/forms`): hidden `id` input, hidden `status`
   input = `ignored` when `test.status === 'active'` (button label "Mute"),
   `active` when `test.status === 'ignored'` (label "Unmute"). Rows with
   status `resolved` get no button. Match existing button/pill classes.
3. `use:enhance` default behavior re-runs load after the action — the row
   moves out of the current filter automatically.

**Verify**: `pnpm --filter dashboard check` → 0 errors; `pnpm --filter dashboard test` → all pass (existing suites unaffected).

### Step 5: Document + e2e smoke

- `docs/API.md`: add the PATCH endpoint in the Tests section (match the
  file's endpoint format; note admin Bearer auth and the two accepted
  statuses).
- E2E (isolated stack): disposable pg (Commands table), migrate, API on
  :8083 with `ADMIN_TOKEN=test-admin-token`, seed project + upload
  `apps/api/fixtures/real-report.json` twice (different commits), dashboard
  dev on :5174 with `PUBLIC_API_URL=http://localhost:8083 ADMIN_TOKEN=test-admin-token`.
  With curl: PATCH a flaky row to `ignored` → 200; `GET .../flaky-tests?status=ignored`
  contains it; `status=active` doesn't. In the dashboard SSR HTML
  (`curl -s http://localhost:5174/flaky?...`), confirm the Ignored pill and
  Mute buttons render. Clean up (kill servers, rm container, rm temp .env).

**Verify**: the curl assertions above; cleanup confirmed.

## Done criteria

- [ ] PATCH route exists, admin-authed, accepts only `ignored`/`active`
- [ ] Route tests pass with DB env (auth matrix, flip both ways, 400/404, reconcile-preserves-ignored)
- [ ] Dashboard shows Ignored filter + Mute/Unmute buttons when `ADMIN_TOKEN` is configured; hides them when not
- [ ] `docs/API.md` documents the endpoint
- [ ] All four gates green: api tsc + tests, dashboard check + tests, root lint
- [ ] `git status` clean outside the in-scope list

## STOP conditions

- `adminAuth()` cannot be applied per-route on the tests router (middleware
  composition issue) — report; do not switch the whole router to admin auth
  (its GETs must stay public).
- SvelteKit form actions conflict with the existing load/error architecture
  in a way `use:enhance` doesn't solve — report with the exact error.
- The `Actions`/`./$types` import breaks svelte-check and local typing
  doesn't fix it — report.

## Maintenance notes

- This creates the dashboard's first write path and the
  private-`ADMIN_TOKEN`-in-dashboard pattern; plans 013+ reuse it. Keep all
  mutations in form actions (server-side) — never expose the token via
  `PUBLIC_*`.
- `docker-compose.yml` passes env to the dashboard service — deployment docs
  should mention `ADMIN_TOKEN` is optional for the dashboard (read-only
  without it). Check compose during review; add the var commented-out if a
  natural slot exists.
- The reconcile contract (`ignored` survives ingests and disappearance) is
  pinned in `flakiness.test.ts` — any change there breaks THIS feature.
