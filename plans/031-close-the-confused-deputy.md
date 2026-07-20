# Plan 031: Close the confused deputy — the dashboard spends an admin token for anonymous visitors

> **Executor instructions**: Follow the plan, run every verification, honor the STOP
> conditions. Do not update `plans/README.md` — the reviewer maintains it.
>
> **Drift check (run first)**: `git rev-parse --short HEAD` at or after `376ff26`. Confirm
> `apps/dashboard/src/routes/flaky/+page.server.ts` still has a `setStatus` action guarded
> only by `if (!env.ADMIN_TOKEN)`, and that **no `apps/dashboard/src/hooks.server.ts`
> exists**. On a mismatch, STOP and report.

## Status

- **Priority**: P0 — this is a security hole with a downstream blast radius (it can make
  another repo's CI silently stop running tests).
- **Effort**: M
- **Risk**: MED — adds an auth gate in front of the dashboard. Get the "not configured"
  path right or you either lock out concept-stage users or fail to close the hole.
- **Depends on**: none. **Parallel-safe** with plan 032 (disjoint files — 032 is API-side).
- **Category**: security
- **Planned at**: commit `376ff26`, 2026-07-15

## The vulnerability (confirmed, with the full chain)

The dashboard has exactly one mutating action — mute/unmute a flaky test —
`apps/dashboard/src/routes/flaky/+page.server.ts`:

```ts
export const actions = {
  setStatus: async ({ request }) => {
    if (!env.ADMIN_TOKEN) return fail(403, { message: 'Muting is not configured' });
    const form = await request.formData();
    const id = String(form.get('id') ?? '');
    const status = String(form.get('status') ?? '');
    ...
    const res = await fetch(`${apiUrl}/api/v1/tests/flaky/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, ... },
      body: JSON.stringify({ status }),
    });
```

The API endpoint it calls (`apps/api/src/routes/tests.ts:316`,
`testsRouter.patch('/flaky/:id', adminAuth(), ...)`) is correctly protected — the same
`adminAuth()` that guards `DELETE /projects/:id` and `rotate-token`.

**But the dashboard is the confused deputy.** `if (!env.ADMIN_TOKEN)` checks that the
*server* holds the admin token — **not** that the *requester* presented any credential.
There is no `hooks.server.ts`, no session, no cookie, no auth anywhere in
`apps/dashboard/src` (verified: `grep -rn "session|cookie|authenticate" apps/dashboard/src`
returns nothing; no `hooks.server.ts` on disk). So the dashboard holds a privileged
credential and spends it on behalf of **anyone who can POST that form action**.

### Why this is worse than "unauthenticated writes"

Trace where a mute goes. Plan 020's quarantine endpoint (`apps/api/src/routes/projects.ts`)
builds the CI skip-list — and its own load-bearing comment says why it only ever includes
*muted* tests:

```
 * `grepInvert` is built from `muted` ONLY. Auto-skipping a machine-detected
 * test without human sign-off would silently hide a real regression.
```

The entire safety design of the quarantine feature rests on **"a human explicitly muted
this."** But the only "human sign-off" UI is this unauthenticated form POST. So the real
chain is:

**anonymous HTTP POST → status set to `ignored` → test enters `grepInvert` → consuming CI
runs `--grep-invert` → that test stops executing.**

An anonymous visitor to an exposed dashboard can make a *downstream* pipeline silently stop
running a test — which is the exact outcome this product exists to prevent. `SvelteKit
2.69`'s default CSRF `checkOrigin` blocks *cross-site* form submissions, but does nothing
against a direct authenticated POST from anyone who can load the page. And
`docs/GETTING_STARTED.md`'s production section walks the operator through exposing the
dashboard behind nginx — the "trusted network" assumption in `.agent/CONTEXT.md` is not
what the docs actually lead people to do.

## Design decision (advisor — the shape is decided; do not relitigate)

> **NOTE TO EXECUTOR**: The specific auth mechanism below (HTTP Basic Auth via a
> `hooks.server.ts` gate, keyed on a `DASHBOARD_PASSWORD` env var) is a deliberate choice by
> the advisor and is confirmed. Implement exactly this. Do not substitute a full
> session/login system, an OAuth flow, or a third-party auth library — those are heavier than
> this deployment needs today, and the maintenance note explains when to revisit.

**Gate the whole dashboard behind HTTP Basic Auth in `hooks.server.ts`, controlled by a new
`DASHBOARD_PASSWORD` env var:**

1. **If `DASHBOARD_PASSWORD` is set**: every request to the dashboard must present matching
   HTTP Basic credentials, or it gets `401` with a `WWW-Authenticate: Basic` challenge. This
   closes the hole: the privileged mute action can no longer be invoked by an anonymous
   party, because *no* dashboard route is reachable without the password.
2. **If `DASHBOARD_PASSWORD` is NOT set**: the dashboard behaves exactly as today (no gate) —
   **but** if `ADMIN_TOKEN` *is* set (i.e. the mute action is live and privileged) while
   `DASHBOARD_PASSWORD` is not, log a single, loud startup/first-request `warn` explaining
   that the dashboard is exposing a privileged write path with no authentication. Do not hard
   fail — a genuinely single-operator, network-isolated deployment is still valid, and
   breaking it on upgrade would be worse than a warning. But the warning must be impossible
   to miss.

**Why Basic Auth and not a login page**: it is stateless (no session store, no new
dependency, works behind the documented nginx proxy), it protects *every* route including
future write actions automatically, and it is proportionate to a self-hosted single-team
tool. The honest heavier alternative (per-user sessions + scoped tokens) is recorded in the
maintenance note for when there's a real multi-user requirement.

**Constant-time comparison**: compare the presented password against `DASHBOARD_PASSWORD`
with `crypto.timingSafeEqual` over SHA-256 digests — the API already does exactly this for
its admin token (`apps/api/src/middleware/auth.ts`, `tokensMatch`). Read that and mirror it.
A plain `===` on a secret is a timing-oracle; do not use it.

## Scope

**In scope**:
- `apps/dashboard/src/hooks.server.ts` (NEW) — the Basic Auth gate
- A co-located unit test for the gate's logic (the pure credential-check function must be
  testable without a running server — factor it out so it is)
- `docs/GETTING_STARTED.md` — document `DASHBOARD_PASSWORD` in the production-deployment and
  env sections; state plainly that without it an exposed dashboard has an unauthenticated
  privileged write path
- `.env.example` and/or `docker-compose*.yml` env plumbing **only if** `DASHBOARD_PASSWORD`
  needs wiring there for the documented deployment to work — check first; if the dashboard
  reads `$env/dynamic/private` at runtime, a compose env entry may be needed. Keep this
  minimal.

**Out of scope** (do NOT touch):
- `apps/api/**` — the API's `adminAuth` is correct; the bug is entirely dashboard-side. Do
  not "also" add auth there.
- `apps/dashboard/src/routes/**` — do **not** move the auth check into individual routes; a
  per-route check is exactly the mistake that created this hole. The gate belongs in
  `hooks.server.ts` so it covers everything by construction.
- `docs/API.md` — plan 032 owns it this wave; leave it alone.
- `.agent/CONTEXT.md`, `AGENTS.md` — a follow-up will refresh them; not here.
- Do **not** add a login form, session cookies, a user table, or any auth dependency.

## Steps

### Step 1: The credential check (pure, tested)

Write a pure function — e.g. `checkBasicAuth(authHeader: string | null, expected: string):
boolean` — that parses the `Authorization: Basic <base64>` header, extracts the password
(the scheme can be `user:password`; decide whether the username is checked or ignored and
document it), and compares against `expected` with `crypto.timingSafeEqual` over SHA-256
digests. Returns false for a missing/malformed header. Unit-test it directly: valid creds
pass, wrong password fails, missing header fails, malformed base64 fails, empty expected is
never matched.

### Step 2: The hook

`hooks.server.ts` `handle`: read `DASHBOARD_PASSWORD` from `$env/dynamic/private`. If unset,
`resolve(event)` unchanged (and emit the one-time warning if `ADMIN_TOKEN` is set — see
design decision 2). If set, run `checkBasicAuth`; on failure return a `401` `Response` with
`WWW-Authenticate: Basic realm="Flackyness"`; on success `resolve(event)`.

**Verify**: `pnpm --filter dashboard check` → 0 errors.

### Step 3: Prove it actually closes the hole

This is the done criterion that matters. With `DASHBOARD_PASSWORD` and `ADMIN_TOKEN` both
set, against a built dashboard:
- `GET /` with no credentials → **401**
- `POST` to the `flaky` form action (`?/setStatus`) with no credentials → **401**, and — the
  load-bearing part — **the API's `flaky_tests` row is unchanged** (query the DB before and
  after; the mute must NOT have happened). A 401 that still performed the write would be a
  fake fix.
- the same `POST` **with** correct Basic creds → reaches the API (200 or a normal
  validation error, not 401).

Paste the before/after DB state for the no-credentials POST.

### Step 4: Docs

Document `DASHBOARD_PASSWORD` in `GETTING_STARTED.md`. Be explicit: if you expose the
dashboard (the nginx section) and have set `ADMIN_TOKEN`, you **must** set
`DASHBOARD_PASSWORD` or anyone who can reach the page can mute tests — and muted tests feed
the CI quarantine list.

## Done criteria

- [ ] `hooks.server.ts` gates **all** routes when `DASHBOARD_PASSWORD` is set; no per-route checks added
- [ ] With the password set: unauthenticated `GET /` and the `setStatus` POST both return **401**, and the POST leaves `flaky_tests` **unchanged** (before/after DB state pasted)
- [ ] With correct Basic creds: the mute reaches the API and succeeds
- [ ] With the password **unset**: dashboard behaves as before (no regression), and a loud `warn` fires when `ADMIN_TOKEN` is set but `DASHBOARD_PASSWORD` is not
- [ ] Credential comparison uses `crypto.timingSafeEqual`, not `===`; the pure check is unit-tested (valid/wrong/missing/malformed)
- [ ] `pnpm --filter dashboard check` 0 errors; `pnpm test` green; `rtk proxy pnpm lint` exit 0
- [ ] `pnpm --filter dashboard test:e2e` — **the E2E suite still passes** (it drives the dashboard; if you gated it, the suite's requests now need credentials — see STOP conditions)
- [ ] `git diff --name-only main` shows nothing under `apps/api/`, `docs/API.md`, or the doc-context files

## Test/verification setup

Disposable Postgres — **never `docker compose up`**, always clean up even on failure:
```bash
docker run -d --name flackyness-test-pg-031 -e POSTGRES_PASSWORD=test_password \
  -e POSTGRES_DB=flackyness_test -p 5460:5432 postgres:16-alpine
touch .env
DATABASE_URL=postgres://postgres:test_password@localhost:5460/flackyness_test pnpm db:migrate
docker rm -f flackyness-test-pg-031   # ALWAYS, even on failure
```
API reads `API_PORT` (not `PORT`), default 8080. Kill any `node build` before an E2E run
(stale-server trap). Never echo `DASHBOARD_PASSWORD`/`ADMIN_TOKEN` into output or a file.

## STOP conditions

- **The E2E suite can't authenticate against your gate.** The E2E suite runs with a built
  dashboard; if you gate it, its own requests need to present Basic creds. The correct fix is
  to have the E2E run set `DASHBOARD_PASSWORD` and the specs/`webServer` present it (or leave
  `DASHBOARD_PASSWORD` unset for the E2E run, which is a valid choice since the gate's
  unset-path is unchanged behavior — but then you have NOT exercised the gate in E2E, so add
  at least a unit/integration test that does). Decide, implement, and **explain which you
  chose and why** in your report. Do NOT weaken the gate to make the suite pass.
- **Closing the hole requires an API change.** It does not — the API is already correct.
  If you think it does, STOP and report.
- You cannot make the no-credentials POST both return 401 **and** leave the DB unchanged.
  That means the gate isn't actually in front of the action — STOP and report rather than
  shipping a 401 that still mutates.

## Maintenance notes

- **This is the write-side of the auth story.** Read APIs are still unauthenticated by design
  (documented, deliberate). If the product goes multi-tenant, the honest next step is
  per-user sessions + scoped tokens that separate "can mute for project X" from "can
  delete/rotate/prune" — Basic Auth is one shared password and does not model per-user
  identity or per-project scope. This plan buys correctness now without that weight; it does
  not pretend to be an identity system.
- The gate protects **every** current and future dashboard route by construction. Anyone
  adding a new write action gets protection for free — which is precisely why the check lives
  in `hooks.server.ts` and not in the route.
