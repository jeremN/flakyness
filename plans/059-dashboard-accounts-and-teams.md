# Dashboard Accounts & Teams (Phase D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's single shared `DASHBOARD_PASSWORD` with real accounts — a `/login` page, a forced first-login password reset, team-scoped views with a switcher for multi-team users, and a global-admin console for teams and users — with the user's session, not an ambient `ADMIN_TOKEN`, authorizing every call.

**Architecture:** `hooks.server.ts` becomes the single gate: it reads the `fk_session` cookie, validates it against `GET /auth/me`, populates `event.locals.user`, and redirects unauthenticated traffic to `/login`. Both server-only API clients (`$lib/server/api.ts`, `$lib/server/adminApi.ts`) are converted from module-level functions into per-request factories that carry the caller's session cookie — so the compiler forces every call site to supply an identity, and the dashboard stops holding `ADMIN_TOKEN` at all. Pure `$lib` helpers carry the view-logic and are node-unit-tested to be mutation-provable.

**Tech Stack:** SvelteKit (Svelte 5 runes), TypeScript, Vitest (node + browser mode via `vitest-browser-svelte`), Playwright (E2E), Tailwind v4, Stryker.

**Spec:** `docs/superpowers/specs/2026-07-25-teams-identity-access-control-design.md` (Phase D),
amended by `docs/superpowers/specs/2026-08-15-dashboard-accounts-delta-design.md`
(what plan 058b changed underneath this plan — adds **Task 0** and amends Tasks
1, 2, 3, 6 and 7).

## Global Constraints

Every task's requirements implicitly include this section.

- **Rate limits must key per browser, not per dashboard container (delta §D1).**
  Making the dashboard a confidential client routes every API call through one
  socket, collapsing `apiRateLimit` (100/min) and `authRateLimit` (10/min) into a
  single shared bucket for the whole installation. Task 0 makes the API able to
  trust `X-Forwarded-For` from a pinned proxy address; Tasks 2 and 3 make the
  dashboard send it. `adminRateLimit` is already immune (`hasAdminStanding`
  exempts any signed-in session) and `reportRateLimit` is CI ingest only.
- **Depends hard on plans 056–058, and on 058b (PR #133, `e689af0`).** The API must already accept global-admin **sessions** on the admin API (plan 058, Task 5) — otherwise the console cannot work without `ADMIN_TOKEN`.
- **Global admins must see an explicit "Unassigned" grouping in the dashboard's project list (plan 058 pre-flight ruling).** `POST /admin/projects` intentionally leaves `teamId` optional, so a project created without one stays `team_id IS NULL` — and, by `canReadProject`'s design (plan 058), invisible to every non-global-admin. That ruling was made **conditional on this plan surfacing the state**: without it, a project created without a team becomes silently invisible to the very team that created it, and 1,529 of 2,952 projects on the dev database are already in that state. Task 6's team-scoped project list must render an explicit **"Unassigned"** group for `teamId === null` projects, shown only when `locals.user.isGlobalAdmin` (the only caller who can read them at all) — a silent gap is the trap this bullet exists to close.
- **THE ONE BREAKING CHANGE IN THIS WHOLE FEATURE: `DASHBOARD_PASSWORD` is removed.** After this plan, an operator who upgrades without creating a user account cannot sign in. The upgrade note in `docs/GETTING_STARTED.md` (plan 057, Task 8, Step 3) is what prevents that being a surprise; Task 8 here makes it prominent. Do not leave a fallback path — a dual gate is two things to get wrong, and the account system supersedes the password by design (spec §Dashboard).
- **`ADMIN_TOKEN` leaves the dashboard entirely.** Today `$lib/server/adminApi.ts` spends a server-held token on behalf of whoever submits a form (plan 053). That was the correct shape when there were no users; it is ambient authority now that there are. The console acts **as the signed-in user**. `ADMIN_TOKEN` stays a valid API credential for operators and scripts — the dashboard simply stops holding one.
- **No token or session value ever reaches the browser.** The session cookie is `HttpOnly`; all API calls are server-side; every mutation is a named SvelteKit form action. Same contract as plan 053.
- **`ORIGIN` must be set for form actions to work.** `@sveltejs/adapter-node`'s CSRF check assumes `https` without it, so every same-origin POST over plain HTTP 403s (`AGENTS.md` sharp edge, found in plan 053). Already set in `playwright.config.ts` and `docker-compose.yml` — do not remove it; the login POST is now the *first* request a user makes.
- **Pure `$lib` helpers are node-unit-tested and mutation-provable.** `.svelte` render tests run in **Vitest browser mode** (`*.svelte.test.ts`, `pnpm --filter dashboard test:browser`); the default `pnpm --filter dashboard test` stays node-only. Route render-test files must NOT carry the `+` prefix (`page.svelte.test.ts`); the component import keeps `+page.svelte`.
- **Commits:** single-line conventional-commit subject; **no `Co-Authored-By` trailers**; never `--no-verify`.

## File Structure

**Create:**
- `apps/dashboard/src/lib/session.ts` — `SESSION_COOKIE`, `parseSessionCookie(setCookieHeader)`, `redirectTargetFor(user, pathname)`.
- `apps/dashboard/src/lib/session.test.ts` — node unit tests.
- `apps/dashboard/src/lib/server/session.ts` — server-only `fetchMe(sessionToken, clientIp)`.
- `apps/dashboard/src/routes/login/+page.server.ts` / `+page.svelte` / `page.svelte.test.ts`
- `apps/dashboard/src/routes/change-password/+page.server.ts` / `+page.svelte` / `page.svelte.test.ts`
- `apps/dashboard/src/routes/admin/teams/+page.server.ts` / `+page.svelte` / `page.svelte.test.ts`
- `apps/dashboard/src/routes/admin/users/+page.server.ts` / `+page.svelte` / `page.svelte.test.ts`
- `apps/dashboard/src/lib/components/TeamSwitcher.svelte` (+ its browser-mode test)
- `apps/dashboard/e2e/auth.spec.ts` — login, forced reset, logout, team scoping, show-once temp password.

**Modify:**
- `apps/dashboard/src/hooks.server.ts` — session gate replaces Basic Auth.
- `apps/dashboard/src/hooks.server.test.ts` — rewritten for the new gate.
- `apps/dashboard/src/app.d.ts` — `Locals`, `SessionUser`, `TeamSummary`, `AdminUser`, `AdminTeam`.
- `apps/dashboard/src/lib/server/api.ts` — factory taking the session token.
- `apps/dashboard/src/lib/server/adminApi.ts` — factory taking the session token; `ADMIN_TOKEN` removed.
- All 9 `+page.server.ts` / `+layout.server.ts` load functions — pass the session through.
- `apps/dashboard/src/routes/+layout.svelte` — user menu, sign-out, team switcher.
- `apps/dashboard/src/lib/server/basicAuth.ts` + its test — **deleted**.
- `docker-compose.yml`, `.env.example`, `docs/GETTING_STARTED.md`, `AGENTS.md`, `plans/README.md`.

---

### Task 0: per-user rate-limit keys behind the dashboard (API side)

**Delta task — added 2026-08-15.** See
`docs/superpowers/specs/2026-08-15-dashboard-accounts-delta-design.md` §D1.

**Files:**
- Modify: `apps/api/src/middleware/rate-limit.ts` (`getClientIp`, ~:39-55)
- Modify: `apps/api/src/middleware/rate-limit.test.ts`
- Modify: `apps/api/src/index.ts` (boot warnings, after the `isCookieSecure()` block at :144-154)
- Modify: `docker-compose.yml`, `.env.example`, `docs/GETTING_STARTED.md`

**Interfaces:**
- Produces:
  - `getClientIp(c: Context): string` — unchanged signature, now matching
    `TRUSTED_PROXY_IPS` against IPv4-mapped socket addresses.
  - `trustedProxyWarning(trustedProxyIps: string | undefined): string | null` —
    the boot-warning text, or null when configured.

**Why this task exists, and why it is first:** plan 059 makes the dashboard a
confidential client, so every API request in the installation arrives from one
socket — the dashboard container. `apiRateLimit` (100/min) and `authRateLimit`
(10/min) are both keyed per-IP by `getClientIp`, so both collapse into a single
shared bucket: roughly twenty page views a minute for the whole install, and ten
sign-ins. `adminRateLimit` is already immune (`hasAdminStanding` exempts any
signed-in session) and `reportRateLimit` is CI ingest only. Without this task the
login page ships unusable for a team of any size, so it lands before the login
page exists.

- [ ] **Step 1: Write the failing normalization tests**

Add to `apps/api/src/middleware/rate-limit.test.ts`, inside `describe('getClientIp')`.
Note every existing test in this file uses a bare IPv4 socket address, which is
exactly why this gap survived — these MUST use the `::ffff:` form:

> **Corrected 2026-08-15 (final fix wave): the mandated comment below overclaims,
> and the shipped code says something different on purpose.** "Silently failing in
> every real deployment" is **false**. A raw-Node experiment confirmed
> `listen(port, '0.0.0.0')` yields a **bare** IPv4 `remoteAddress`; only Node's
> no-host dual-stack default yields the `::ffff:` form. This app sets
> `API_HOST='0.0.0.0'` in the code default (`apps/api/src/index.ts`) and in
> `docker-compose.yml`, so no documented deployment ever presents that form and
> the pre-existing exact-match code already worked. The normalization is
> **forward-compatible hardening** — load-bearing only if `API_HOST` is ever unset
> or set to `::`. The tests and the code below are correct and were kept; only the
> claim was wrong. Do not re-copy the wording from this block.

```ts
  it('matches a trusted proxy when the socket reports an IPv4-mapped address', () => {
    // MEASURED, not assumed: Node reports an IPv4 connection on a dual-stack
    // listener as '::ffff:127.0.0.1'. Every other test here uses a bare IPv4
    // address, so the exact-string match in getClientIp passes them while
    // silently failing in every real deployment — the operator sets
    // TRUSTED_PROXY_IPS=172.28.0.10, the socket says '::ffff:172.28.0.10',
    // the trust check fails, and the shared bucket returns with no error.
    process.env.TRUSTED_PROXY_IPS = '172.28.0.10';
    expect(getClientIp(fakeCtx({ socketIp: '::ffff:172.28.0.10', xff: '9.9.9.9' }))).toBe('9.9.9.9');
  });

  it('matches when TRUSTED_PROXY_IPS itself is written in the IPv4-mapped form', () => {
    // Normalize BOTH sides: an operator who copies the address out of a log
    // will paste the ::ffff: form, and that must work too.
    process.env.TRUSTED_PROXY_IPS = '::ffff:172.28.0.10';
    expect(getClientIp(fakeCtx({ socketIp: '172.28.0.10', xff: '9.9.9.9' }))).toBe('9.9.9.9');
  });

  it('still ignores a spoofed X-Forwarded-For from an untrusted IPv4-mapped socket', () => {
    // The normalization must not become a bypass: '::ffff:9.9.9.9' is still
    // not the trusted proxy, so its XFF stays ignored.
    process.env.TRUSTED_PROXY_IPS = '172.28.0.10';
    expect(getClientIp(fakeCtx({ socketIp: '::ffff:9.9.9.9', xff: '1.1.1.1' }))).toBe('9.9.9.9');
  });

  it('returns the socket IP normalized, so one client occupies one bucket', () => {
    // Without normalizing the RETURN value, the same client could be keyed as
    // both '::ffff:9.9.9.9' and '9.9.9.9' depending on the listener, splitting
    // its bucket and doubling its effective limit.
    delete process.env.TRUSTED_PROXY_IPS;
    expect(getClientIp(fakeCtx({ socketIp: '::ffff:9.9.9.9' }))).toBe('9.9.9.9');
  });
```

- [ ] **Step 2: Write the failing boot-warning tests**

Add a new `describe` block to the same file:

```ts
import { getClientIp, trustedProxyWarning } from './rate-limit';

describe('trustedProxyWarning', () => {
  it('warns when TRUSTED_PROXY_IPS is unset', () => {
    const msg = trustedProxyWarning(undefined);
    expect(msg).toContain('TRUSTED_PROXY_IPS');
    expect(msg).toContain('X-Forwarded-For');
  });

  it('warns when TRUSTED_PROXY_IPS is set but empty or blank', () => {
    // `TRUSTED_PROXY_IPS=` in a .env file yields '' — configured in name only.
    expect(trustedProxyWarning('')).not.toBeNull();
    expect(trustedProxyWarning('   ')).not.toBeNull();
  });

  it('stays silent when a proxy is genuinely configured', () => {
    expect(trustedProxyWarning('172.28.0.10')).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify both fail**

```bash
cd apps/api && pnpm exec vitest run src/middleware/rate-limit.test.ts
```
Expected: FAIL — `trustedProxyWarning` is not exported, and the `::ffff:` cases
return the socket IP instead of the forwarded one.

- [ ] **Step 4: Implement**

In `apps/api/src/middleware/rate-limit.ts`, add above `getClientIp`:

```ts
/**
 * Strip the IPv4-mapped IPv6 prefix so a socket address and a configured one
 * compare equal.
 *
 * Node reports an IPv4 connection on a dual-stack listener as
 * '::ffff:172.28.0.10' (measured on this Node version, not assumed). Without
 * this, TRUSTED_PROXY_IPS can never be set to a value that matches, the trust
 * check silently fails, and every caller behind the proxy shares one bucket.
 */
function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}
```

Then rewrite the tail of `getClientIp` so both sides are normalized:

```ts
  const normalizedSocketIp = socketIp ? normalizeIp(socketIp) : undefined;

  if (trustedProxies && normalizedSocketIp) {
    const trusted = trustedProxies.map(normalizeIp);
    if (trusted.includes(normalizedSocketIp)) {
      const forwarded = c.req.header('x-forwarded-for')?.split(',')[0].trim();
      if (forwarded) return normalizeIp(forwarded);
    }
  }

  return normalizedSocketIp || 'unknown';
```

Add the warning helper at the end of the file:

```ts
/**
 * The boot warning for an unconfigured trusted proxy, or null when configured.
 *
 * A pure function rather than an inline `if` in index.ts so it is unit-testable
 * and mutation-provable — the same extraction the dashboard's $lib helpers use.
 * Without TRUSTED_PROXY_IPS the API ignores X-Forwarded-For (correctly — it is
 * spoofable from an untrusted socket), which means a server-mediated dashboard
 * puts every user in one rate-limit bucket. That degrades at a threshold rather
 * than failing outright, so it must be announced rather than discovered.
 */
export function trustedProxyWarning(trustedProxyIps: string | undefined): string | null {
  if (trustedProxyIps && trustedProxyIps.trim() !== '') return null;
  return (
    'TRUSTED_PROXY_IPS is not set — X-Forwarded-For is ignored and every ' +
    'request is rate-limited by its socket address. If the dashboard reaches ' +
    'this API server-side (the default docker-compose deployment), ALL users ' +
    'share one bucket: ~100 API calls and 10 sign-ins per minute for the whole ' +
    'installation, regardless of how many people are using it. Set ' +
    'TRUSTED_PROXY_IPS to the dashboard container\'s address so each browser ' +
    'gets its own bucket. See docs/GETTING_STARTED.md.'
  );
}
```

- [ ] **Step 5: Wire the warning into boot**

In `apps/api/src/index.ts`, import `trustedProxyWarning` alongside the existing
rate-limit imports and add this immediately after the `isCookieSecure()` block
(`:144-154`), matching the fires-once-at-module-evaluation shape of its two
neighbours:

```ts
// Same fires-once-at-boot shape as the two warnings above (plan 059 Task 0).
const proxyWarning = trustedProxyWarning(process.env.TRUSTED_PROXY_IPS);
if (proxyWarning) logger.warn(proxyWarning);
```

- [ ] **Step 6: Run to verify it passes**

```bash
cd apps/api && pnpm exec vitest run src/middleware/rate-limit.test.ts && pnpm exec tsc --noEmit
```
Expected: PASS, exit 0.

- [ ] **Step 7: Pin the dashboard's address in compose**

In `docker-compose.yml`, give the network an explicit subnet (it currently has
none, so no static address can be assigned):

```yaml
networks:
  flackyness:
    driver: bridge
    ipam:
      config:
        - subnet: 172.28.0.0/16
```

Give the dashboard service a fixed address by replacing its short-form
`networks:` list:

```yaml
    networks:
      flackyness:
        ipv4_address: 172.28.0.10
```

And add to the **api** service's `environment:` block:

```yaml
      TRUSTED_PROXY_IPS: ${TRUSTED_PROXY_IPS:-172.28.0.10}
```

Trust exactly that one address — **never the `172.28.0.0/16` range**. With
published ports, Docker's userland proxy can present external traffic as a
bridge address, so trusting the range would let an internet client spoof
`X-Forwarded-For` and evade the login throttle entirely. `getClientIp` does an
exact match precisely so this stays a single, operator-controlled address.

- [ ] **Step 8: Document it**

- `.env.example` — add `TRUSTED_PROXY_IPS=` with a comment: set it to the
  address of whatever reaches the API on a browser's behalf (the dashboard
  container, or your reverse proxy), or all users share one rate-limit bucket.
- `docs/GETTING_STARTED.md` — a short subsection under the deployment notes
  explaining the same, and stating that the compose file sets it automatically.

- [ ] **Step 9: Verify and commit**

```bash
cd apps/api && pnpm exec vitest run && pnpm exec tsc --noEmit
cd ../.. && pnpm run lint
docker compose config >/dev/null && echo "compose parses"
git add apps/api/src/middleware/rate-limit.ts apps/api/src/middleware/rate-limit.test.ts \
        apps/api/src/index.ts docker-compose.yml .env.example docs/GETTING_STARTED.md
git commit -m "fix(api): key rate limits per browser behind a trusted proxy"
```

---

### Task 1: session helpers + types

**Files:**
- Create: `apps/dashboard/src/lib/session.ts`, `apps/dashboard/src/lib/session.test.ts`
- Modify: `apps/dashboard/src/app.d.ts`

**Interfaces:**
- Produces:
  - `SESSION_COOKIE = 'fk_session'`
  - `parseSessionCookie(setCookieHeader: string | null): string | null`
  - `redirectTargetFor(user: SessionUser | null, pathname: string): string | null`
  - `app.d.ts`: `SessionUser`, `TeamSummary`, `AdminUser`, `AdminTeam`, and `App.Locals`.

**Why `parseSessionCookie` exists:** the dashboard server calls the API's `/auth/login`; the API answers with a `Set-Cookie` scoped to the **API's** origin, which the browser never sees. The dashboard must lift the token out of that header and set its **own** cookie on its own origin. This is the seam that makes the dashboard a confidential client rather than a proxy, and it is exactly the kind of string-handling that deserves unit tests rather than a hopeful regex inline.

- [ ] **Step 1: Write the failing tests**

Create `apps/dashboard/src/lib/session.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SESSION_COOKIE, parseSessionCookie, redirectTargetFor } from './session';

describe('parseSessionCookie', () => {
  it('extracts the token from a realistic API Set-Cookie header', () => {
    const header = `${SESSION_COOKIE}=abc123; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax`;
    expect(parseSessionCookie(header)).toBe('abc123');
  });

  it('finds it when other cookies precede it', () => {
    const header = `other=1; Path=/, ${SESSION_COOKIE}=xyz; Path=/; HttpOnly`;
    expect(parseSessionCookie(header)).toBe('xyz');
  });

  it('returns null when the header is absent', () => {
    expect(parseSessionCookie(null)).toBeNull();
  });

  it('returns null when the header carries no session cookie', () => {
    expect(parseSessionCookie('other=1; Path=/')).toBeNull();
  });

  it('returns null for an empty value rather than an empty-string token', () => {
    expect(parseSessionCookie(`${SESSION_COOKIE}=; Path=/`)).toBeNull();
  });

  it('does not match a cookie whose name merely ends with ours', () => {
    expect(parseSessionCookie(`not_${SESSION_COOKIE}=nope; Path=/`)).toBeNull();
  });
});

describe('redirectTargetFor', () => {
  const user = { id: 'u1', email: 'a@b.c', displayName: null, isGlobalAdmin: false, mustChangePassword: false };

  it('sends an anonymous visitor to /login', () => {
    expect(redirectTargetFor(null, '/flaky')).toBe('/login');
  });

  it('leaves an anonymous visitor already on /login alone (no redirect loop)', () => {
    expect(redirectTargetFor(null, '/login')).toBeNull();
  });

  it('sends a signed-in user away from /login', () => {
    expect(redirectTargetFor(user, '/login')).toBe('/');
  });

  it('lets a signed-in user through anywhere else', () => {
    expect(redirectTargetFor(user, '/flaky')).toBeNull();
  });

  it('forces a must-change-password user to /change-password from any page', () => {
    const forced = { ...user, mustChangePassword: true };
    expect(redirectTargetFor(forced, '/flaky')).toBe('/change-password');
    expect(redirectTargetFor(forced, '/admin')).toBe('/change-password');
  });

  it('does not trap a must-change-password user on /change-password itself', () => {
    const forced = { ...user, mustChangePassword: true };
    expect(redirectTargetFor(forced, '/change-password')).toBeNull();
  });

  it('lets a must-change-password user reach /logout — they must be able to leave', () => {
    const forced = { ...user, mustChangePassword: true };
    expect(redirectTargetFor(forced, '/logout')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dashboard exec vitest run src/lib/session.test.ts`
Expected: FAIL — cannot resolve `./session`.

- [ ] **Step 3: Implement**

Create `apps/dashboard/src/lib/session.ts`:

```ts
import type { SessionUser } from '../app.d';

/** Must match the API's SESSION_COOKIE (apps/api/src/services/auth/session.ts). */
export const SESSION_COOKIE = 'fk_session';

/**
 * Lift the session token out of the API's `Set-Cookie` response header.
 *
 * The API's cookie is scoped to the API's origin and never reaches the
 * browser — the dashboard sets its own cookie on its own origin. The word
 * boundary in the pattern matters: without it, a cookie named
 * `not_fk_session` would match.
 */
export function parseSessionCookie(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(new RegExp(`(?:^|[;,\\s])${SESSION_COOKIE}=([^;,\\s]+)`));
  return match?.[1] ?? null;
}

/** Pages reachable without a completed password change. */
const ESCAPE_HATCHES = ['/change-password', '/logout'];

/**
 * Where should this request be redirected, or null to let it through?
 *
 * Extracted from hooks.server.ts so the routing rules are unit-testable
 * without a running server — the same reasoning that made `checkBasicAuth`
 * a pure module in plan 031.
 */
export function redirectTargetFor(user: SessionUser | null, pathname: string): string | null {
  if (!user) return pathname === '/login' ? null : '/login';
  if (pathname === '/login') return '/';
  if (user.mustChangePassword && !ESCAPE_HATCHES.includes(pathname)) return '/change-password';
  return null;
}
```

- [ ] **Step 4: Add the types**

In `apps/dashboard/src/app.d.ts`, add:

```ts
export interface TeamSummary {
  id: string;
  name: string;
  role: 'team_admin' | 'member';
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  isGlobalAdmin: boolean;
  mustChangePassword: boolean;
}

export interface AdminUser extends SessionUser {
  createdAt: string;
  lastLoginAt: string | null;
  teams: TeamSummary[];
}

export interface AdminTeam {
  id: string;
  name: string;
  createdAt: string;
  memberCount: number;
  projectCount: number;
}

declare global {
  namespace App {
    interface Locals {
      user: SessionUser | null;
      teams: TeamSummary[];
      sessionToken: string | null;
      // The browser's address, forwarded to the API as X-Forwarded-For so its
      // rate limiters key per user instead of per dashboard container
      // (Task 0). Populated in Task 3 from event.getClientAddress().
      clientIp: string | null;
    }
  }
}
```

Add `teamId: string | null` to **both** the existing `Project` interface (plan 058 returns it on `GET /api/v1/projects`, and the team switcher in Task 6 filters on it) and the existing `AdminProject` interface (plan 057 returns it on the admin list).

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm --filter dashboard exec vitest run src/lib/session.test.ts
pnpm --filter dashboard check
```
Expected: tests PASS, svelte-check clean.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/lib/session.ts apps/dashboard/src/lib/session.test.ts apps/dashboard/src/app.d.ts
git commit -m "feat(dashboard): session cookie helpers and account types"
```

---

### Task 2: session-carrying API clients

**Files:**
- Create: `apps/dashboard/src/lib/server/session.ts`
- Modify: `apps/dashboard/src/lib/server/api.ts`, `apps/dashboard/src/lib/server/adminApi.ts` (+ their tests)

**Interfaces:**
- Produces:
  - `fetchMe(sessionToken: string, clientIp: string | null): Promise<{ user: SessionUser; teams: TeamSummary[] } | null>`
  - `createApi(sessionToken: string | null, clientIp: string | null)` — returns `{ getProjects, getProjectStats, getFlakyTests, getProjectRuns, getRunDetail, getTestHistory, getFlakeTrend, getTestTrend, getAnalysis }`, same signatures as today.
  - `createAdminApi(sessionToken: string | null, clientIp: string | null)` — returns the existing admin functions plus `listTeams`, `createTeam`, `patchTeam`, `deleteTeam`, `listTeamMembers`, `addTeamMember`, `patchTeamMember`, `removeTeamMember`, `listUsers`, `createUser`, `patchUser`, `resetUserPassword`, `deleteUser`.

**Delta (2026-08-15, §D1.2):** all three take `clientIp` as a second parameter
and send it as `X-Forwarded-For`. It belongs here, in the shared fetch layer,
rather than on individual call sites — the same argument that makes these
factories rather than optional parameters: a call site that forgets would keep
compiling and quietly put its user back in the shared bucket. Adding it as a
**required** positional parameter means the compiler names every call site,
exactly as the session-token conversion does.

**Why a factory and not an extra parameter:** converting to a factory **deletes** the module-level exports, so every existing call site stops compiling until it supplies an identity. An optional parameter would let a forgotten call site keep compiling and silently make an unauthenticated request — the same "remember to do it" failure class this repo has been bitten by three times.

- [ ] **Step 1: Write the failing client tests**

Extend `apps/dashboard/src/lib/server/adminApi.test.ts` (and create the equivalent for `api.ts` if absent):

```ts
  it('forwards the caller\'s session cookie, not an ADMIN_TOKEN', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ projects: [] }));
    await createAdminApi('sess-abc', null).listProjects();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Cookie).toBe('fk_session=sess-abc');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('refuses to call the admin API with no session rather than calling it anonymously', async () => {
    await expect(createAdminApi(null, null).listProjects()).rejects.toBeInstanceOf(NotAuthenticatedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a 403 from the API as an AdminApiError carrying the status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Global admin required' }, 403));
    await expect(createAdminApi('s', null).listTeams()).rejects.toMatchObject({ statusCode: 403 });
  });

  // Delta 2026-08-15 (§D1.2): without these the dashboard puts every user in
  // one rate-limit bucket. Task 0 made the API able to trust the header; these
  // prove the dashboard actually sends it.
  it('forwards the browser IP as X-Forwarded-For so the API keys per user', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ projects: [] }));
    await createAdminApi('sess-abc', '203.0.113.7').listProjects();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['X-Forwarded-For']).toBe('203.0.113.7');
  });

  it('omits X-Forwarded-For entirely when there is no client IP', async () => {
    // An empty header is worse than none: getClientIp takes the first
    // comma-separated hop, so '' would key every such request to the same
    // empty-string bucket rather than falling back to the socket address.
    fetchMock.mockResolvedValue(jsonResponse({ projects: [] }));
    await createAdminApi('sess-abc', null).listProjects();
    const [, init] = fetchMock.mock.calls[0];
    expect('X-Forwarded-For' in init.headers).toBe(false);
  });
```

Write the equivalent two assertions for `createApi` and for `fetchMe`. All three
share the seam, so all three need the proof — a passing `createAdminApi` says
nothing about the read client that serves every page load.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dashboard exec vitest run src/lib/server/adminApi.test.ts`
Expected: FAIL — `createAdminApi` does not exist.

- [ ] **Step 3: Convert `adminApi.ts`**

Rewrite the module around a factory. Keep `AdminApiError` exactly as it is (routes already map its `statusCode`); replace `MissingAdminTokenError` with `NotAuthenticatedError` and delete `adminConfigured()`:

```ts
import { env } from '$env/dynamic/public';
import { SESSION_COOKIE } from '../session';
import type { /* …existing… */, AdminTeam, AdminUser, TeamSummary } from '../../app.d';

const API_URL = env.PUBLIC_API_URL || 'http://localhost:8080';

export class AdminApiError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'AdminApiError';
  }
}

/**
 * The request carries no session, so there is nobody to act as.
 *
 * Replaces plan 053's MissingAdminTokenError: the dashboard no longer holds an
 * ADMIN_TOKEN to be missing. Actions convert this to a 403 fail; it must never
 * become an unauthenticated request to the API.
 */
export class NotAuthenticatedError extends Error {
  constructor() {
    super('Not signed in.');
    this.name = 'NotAuthenticatedError';
  }
}

export function createAdminApi(sessionToken: string | null, clientIp: string | null) {
  async function adminFetch<T>(
    path: string,
    init: { method: string; body?: unknown } = { method: 'GET' }
  ): Promise<T> {
    if (!sessionToken) throw new NotAuthenticatedError();

    const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${sessionToken}` };
    // Delta §D1.2. Set only when present: an empty X-Forwarded-For would key
    // every such request into one bucket instead of falling back to the socket
    // address, which is the opposite of the intent.
    if (clientIp) headers['X-Forwarded-For'] = clientIp;
    const hasBody = init.body !== undefined;
    if (hasBody) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${API_URL}${path}`, {
      method: init.method,
      headers,
      body: hasBody ? JSON.stringify(init.body) : undefined,
    });

    if (!res.ok) {
      let message = `API request failed (${res.status})`;
      try {
        const errBody = (await res.clone().json()) as { error?: unknown };
        if (errBody && typeof errBody.error === 'string') message = errBody.error;
      } catch {
        // keep the generic message
      }
      throw new AdminApiError(res.status, message);
    }

    return res.clone().json() as Promise<T>;
  }

  return {
    // …every existing function, unchanged in shape, now closing over adminFetch…
    listProjects: () => adminFetch<{ projects: AdminProject[] }>('/api/v1/admin/projects'),
    // …

    // New in this plan:
    listTeams: () => adminFetch<{ teams: AdminTeam[] }>('/api/v1/admin/teams'),
    createTeam: (name: string) =>
      adminFetch<{ team: AdminTeam }>('/api/v1/admin/teams', { method: 'POST', body: { name } }),
    patchTeam: (teamId: string, name: string) =>
      adminFetch<{ team: AdminTeam }>(`/api/v1/admin/teams/${teamId}`, { method: 'PATCH', body: { name } }),
    deleteTeam: (teamId: string) =>
      adminFetch<{ success: boolean; orphanedProjects: number }>(`/api/v1/admin/teams/${teamId}`, { method: 'DELETE' }),
    listTeamMembers: (teamId: string) =>
      adminFetch<{ members: { userId: string; email: string; displayName: string | null; role: TeamSummary['role'] }[] }>(
        `/api/v1/admin/teams/${teamId}/members`
      ),
    addTeamMember: (teamId: string, userId: string, role: TeamSummary['role']) =>
      adminFetch(`/api/v1/admin/teams/${teamId}/members`, { method: 'POST', body: { userId, role } }),
    patchTeamMember: (teamId: string, userId: string, role: TeamSummary['role']) =>
      adminFetch(`/api/v1/admin/teams/${teamId}/members/${userId}`, { method: 'PATCH', body: { role } }),
    removeTeamMember: (teamId: string, userId: string) =>
      adminFetch(`/api/v1/admin/teams/${teamId}/members/${userId}`, { method: 'DELETE' }),

    listUsers: () => adminFetch<{ users: AdminUser[] }>('/api/v1/admin/users'),
    createUser: (body: { email: string; displayName?: string; isGlobalAdmin?: boolean }) =>
      adminFetch<{ user: AdminUser; temporaryPassword: string; warning: string }>('/api/v1/admin/users', {
        method: 'POST',
        body,
      }),
    patchUser: (userId: string, body: { displayName?: string | null; isGlobalAdmin?: boolean }) =>
      adminFetch<{ user: AdminUser }>(`/api/v1/admin/users/${userId}`, { method: 'PATCH', body }),
    resetUserPassword: (userId: string) =>
      adminFetch<{ temporaryPassword: string; warning: string }>(`/api/v1/admin/users/${userId}/reset-password`, {
        method: 'POST',
      }),
    deleteUser: (userId: string) =>
      adminFetch<{ success: boolean }>(`/api/v1/admin/users/${userId}`, { method: 'DELETE' }),
  };
}
```

- [ ] **Step 4: Convert `api.ts` the same way**

Wrap the existing nine read functions in `createApi(sessionToken, clientIp)`. Replace the `READ_TOKEN` Authorization header with the session cookie, but **keep the `READ_TOKEN` fallback** for the token itself: a deployment may run the dashboard against an API that has `READ_TOKEN` set, and SSR requests made before login (there are none once the gate lands, but the 401 message is still the operator's best diagnostic) should keep the existing explanatory error at `api.ts:41-49`. Concretely:

```ts
    const headers: Record<string, string> = {};
    if (sessionToken) headers.Cookie = `${SESSION_COOKIE}=${sessionToken}`;
    else if (privateEnv.READ_TOKEN) headers.Authorization = `Bearer ${privateEnv.READ_TOKEN}`;
```

Preserve the existing 401 and 503 handling verbatim — those messages were written to diagnose real misconfigurations and their tests assert on them.

- [ ] **Step 5: Create `fetchMe`**

Create `apps/dashboard/src/lib/server/session.ts`:

```ts
import { env } from '$env/dynamic/public';
import { SESSION_COOKIE } from '../session';
import type { SessionUser, TeamSummary } from '../../app.d';

const API_URL = env.PUBLIC_API_URL || 'http://localhost:8080';

/**
 * Validate a session token against the API and return who it belongs to.
 *
 * Returns null for an invalid/expired session AND for an unreachable API. The
 * dashboard is not the security boundary — when it cannot confirm an identity
 * it must fail closed, and the caller redirects to /login. A five-second
 * timeout keeps a hung API from hanging every page load.
 */
export async function fetchMe(
  sessionToken: string,
  clientIp: string | null
): Promise<{ user: SessionUser; teams: TeamSummary[] } | null> {
  try {
    const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${sessionToken}` };
    // Delta §D1.2. This call runs in hooks.server.ts on EVERY request, so it is
    // the single largest contributor to the shared-bucket problem Task 0 fixes.
    if (clientIp) headers['X-Forwarded-For'] = clientIp;

    const res = await fetch(`${API_URL}/api/v1/auth/me`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { user: SessionUser; teams: TeamSummary[] };
  } catch {
    return null;
  }
}
```

- [ ] **Step 6: Fix every call site the compiler names**

Run: `pnpm --filter dashboard check`

It will list every `+page.server.ts` importing the old module-level functions. Update each to build a client from the request's session:

```ts
import { createApi } from '$lib/server/api';

export async function load({ locals, url }: ServerLoadEvent) {
  const api = createApi(locals.sessionToken, locals.clientIp);
  // …existing body, calling api.getProjectStats(...) etc.
}
```

`locals.sessionToken` is populated in Task 3. Write these edits now; the type is already declared.

- [ ] **Step 7: Run to verify it passes**

```bash
pnpm --filter dashboard exec vitest run
pnpm --filter dashboard check
```
Expected: PASS and clean. Existing `page.server.test.ts` files mock the API module — update their mocks to the factory shape.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/lib/server apps/dashboard/src/routes
git commit -m "refactor(dashboard): carry the caller's session through the API clients"
```

---

### Task 2b: take the flaky-test mute action off `ADMIN_TOKEN`

**Added 2026-08-15, during execution.** Task 2's implementer found the one
`ADMIN_TOKEN` consumer no compiler could name: `routes/flaky/+page.server.ts`
never imported `adminApi.ts` at all — its `setStatus` action reads
`$env/dynamic/private` and does its own raw `fetch` with
`Authorization: Bearer ${env.ADMIN_TOKEN}`. Task 2 converted only its
`getFlakyTests` read, because the factory conversion cannot reach code that was
never a caller. No existing task owned it, yet Task 8's Definition of done
requires `grep -rn "ADMIN_TOKEN" apps/dashboard/src` to return nothing. This
task closes that gap.

It is also the one place in the dashboard that must decide **whether to offer**
a privileged action, which is why it introduces the permission helper rather
than Task 6 inventing one later.

**Files:**
- Create: `apps/dashboard/src/lib/permissions.ts`, `apps/dashboard/src/lib/permissions.test.ts`
- Modify: `apps/dashboard/src/lib/server/api.ts` (+ `api.test.ts`)
- Modify: `apps/dashboard/src/routes/flaky/+page.server.ts`, `apps/dashboard/src/routes/flaky/page.svelte.test.ts`

**Interfaces:**
- Consumes: `createApi` (Task 2), `SessionUser`/`TeamSummary` (Task 1).
- Produces:
  - `canMuteTests(user: SessionUser | null, teams: TeamSummary[], project: { teamId: string | null } | null): boolean`
  - `createApi(...).setFlakyStatus(id: string, status: 'ignored' | 'active'): Promise<void>`

- [ ] **Step 1: Write the failing permission tests**

Create `apps/dashboard/src/lib/permissions.test.ts`. These mirror the API's
`canWriteProject` for the `user` access kind
(`apps/api/src/services/auth/access.ts:161-176`) plus the route's own extra
narrowing — muting is a management action, so a project token never qualifies
(`apps/api/src/routes/tests.ts:375-381`); the dashboard has no project token, so
that case cannot arise here.

```ts
import { describe, it, expect } from 'vitest';
import { canMuteTests } from './permissions';
import type { SessionUser, TeamSummary } from '../app.d';

const user = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: 'u1',
  email: 'a@b.c',
  displayName: null,
  isGlobalAdmin: false,
  mustChangePassword: false,
  ...over,
});

const TEAMS: TeamSummary[] = [
  { id: 't-admin', name: 'Owned', role: 'team_admin' },
  { id: 't-member', name: 'Joined', role: 'member' },
];

describe('canMuteTests', () => {
  it('lets a team_admin mute tests in that team\'s project', () => {
    expect(canMuteTests(user(), TEAMS, { teamId: 't-admin' })).toBe(true);
  });

  it('refuses a plain member of the owning team', () => {
    expect(canMuteTests(user(), TEAMS, { teamId: 't-member' })).toBe(false);
  });

  it('refuses a team_admin of a DIFFERENT team', () => {
    expect(canMuteTests(user(), TEAMS, { teamId: 't-other' })).toBe(false);
  });

  it('lets a global admin mute regardless of membership', () => {
    expect(canMuteTests(user({ isGlobalAdmin: true }), [], { teamId: 't-other' })).toBe(true);
  });

  it('refuses an unassigned project even for a team_admin', () => {
    // Mirrors canWriteProject: `project.teamId !== null` is a precondition, so
    // a team_admin has no path to a project that belongs to no team.
    expect(canMuteTests(user(), TEAMS, { teamId: null })).toBe(false);
  });

  it('lets a global admin mute an unassigned project', () => {
    expect(canMuteTests(user({ isGlobalAdmin: true }), [], { teamId: null })).toBe(true);
  });

  it('refuses an anonymous caller', () => {
    expect(canMuteTests(null, TEAMS, { teamId: 't-admin' })).toBe(false);
  });

  it('refuses when there is no selected project', () => {
    expect(canMuteTests(user({ isGlobalAdmin: true }), TEAMS, null)).toBe(false);
  });

  it('refuses a mid-reset user even when they are a global admin', () => {
    // Mirrors requiresPasswordChange()'s short-circuit, which is the FIRST
    // check in every API predicate (plan 058b). Without this the console would
    // offer a button the API answers with 403 password_change_required.
    expect(
      canMuteTests(user({ isGlobalAdmin: true, mustChangePassword: true }), TEAMS, {
        teamId: 't-admin',
      })
    ).toBe(false);
  });

  it('refuses a mid-reset team_admin', () => {
    expect(
      canMuteTests(user({ mustChangePassword: true }), TEAMS, { teamId: 't-admin' })
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dashboard exec vitest run src/lib/permissions.test.ts`
Expected: FAIL — `Cannot find module './permissions'`.

- [ ] **Step 3: Write the permission helper**

Create `apps/dashboard/src/lib/permissions.ts`:

```ts
import type { SessionUser, TeamSummary } from '../app.d';

/**
 * May this user mute/unmute flaky tests in this project?
 *
 * This is a UI affordance, NOT the security boundary. The API decides, in
 * `canWriteProject` plus PATCH /tests/flaky/:id's own narrowing; this function
 * only decides whether to render a button the API would honour. Keep the two in
 * agreement: a mismatch shows a control that always fails (annoying) or hides
 * one the user is entitled to (worse — it looks like a permissions bug).
 *
 * Deliberately mirrors the API's ordering, including the mustChangePassword
 * short-circuit first (plan 058b), so the shapes stay comparable when either
 * side changes.
 */
export function canMuteTests(
  user: SessionUser | null,
  teams: TeamSummary[],
  project: { teamId: string | null } | null
): boolean {
  if (!user) return false;
  if (user.mustChangePassword) return false;
  if (user.isGlobalAdmin) return project !== null;
  if (!project || project.teamId === null) return false;
  return teams.some((t) => t.id === project.teamId && t.role === 'team_admin');
}
```

- [ ] **Step 4: Write the failing client test**

Add to `apps/dashboard/src/lib/server/api.test.ts`:

```ts
  it('sends the mute as a PATCH carrying the session cookie, never an ADMIN_TOKEN', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await createApi('sess-abc', '203.0.113.7').setFlakyStatus('ft-1', 'ignored');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/tests/flaky/ft-1');
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ status: 'ignored' }));
    expect(init.headers.Cookie).toBe('fk_session=sess-abc');
    expect(init.headers['X-Forwarded-For']).toBe('203.0.113.7');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('surfaces a mute rejection as an APIError carrying the status', async () => {
    // The action maps this to fail(); it must NOT become a thrown error page,
    // which would replace the form with a 500 screen instead of an inline message.
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(createApi('s', null).setFlakyStatus('ft-1', 'ignored')).rejects.toMatchObject({
      name: 'APIError',
      statusCode: 403,
    });
  });
```

- [ ] **Step 5: Add `setFlakyStatus` to the factory**

In `apps/dashboard/src/lib/server/api.ts`, first extract the header
construction so `fetchJson` and the new method share one copy — duplicating the
`if (clientIp)` line is precisely how the empty-`X-Forwarded-For` bug returns:

```ts
  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (sessionToken) {
      headers.Cookie = `${SESSION_COOKIE}=${sessionToken}`;
    } else if (privateEnv.READ_TOKEN) {
      headers.Authorization = `Bearer ${privateEnv.READ_TOKEN}`;
    }
    // Delta §D1.2. Set only when present: an empty X-Forwarded-For would key
    // every such request into one bucket instead of falling back to the
    // socket address, which is the opposite of the intent.
    if (clientIp) headers['X-Forwarded-For'] = clientIp;
    return headers;
  }
```

Have `fetchJson` call it, keeping its existing comment block and its 401/503
handling verbatim. Then add to the returned object:

```ts
    /**
     * Mute or unmute a flaky test.
     *
     * Throws APIError rather than SvelteKit's error() — unlike every read above,
     * this is called from a form action, which must answer with fail() so the
     * message renders beside the form instead of replacing the page.
     */
    async setFlakyStatus(id: string, status: 'ignored' | 'active'): Promise<void> {
      const path = `/api/v1/tests/flaky/${id}`;
      let response: Response;
      try {
        response = await fetch(`${API_URL}${path}`, {
          method: 'PATCH',
          headers: { ...buildHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
      } catch {
        throw new APIError(503, `Cannot reach the Flackyness API (${API_URL}).`, path);
      }
      if (!response.ok) {
        throw new APIError(response.status, `Failed to update status`, path);
      }
    },
```

- [ ] **Step 6: Rewrite the route**

Replace `apps/dashboard/src/routes/flaky/+page.server.ts`'s `ADMIN_TOKEN` uses.
`canMute` becomes a function of the signed-in user, and the action acts as them:

```ts
import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { createApi, APIError } from '$lib/server/api';
import { canMuteTests } from '$lib/permissions';

export const load: PageServerLoad = async ({ url, parent, locals }) => {
  const { selectedProject } = await parent();

  if (!selectedProject) {
    return { flakyTests: [], currentProject: null, status: 'active', canMute: false };
  }

  const status = url.searchParams.get('status') || 'active';
  const api = createApi(locals.sessionToken, locals.clientIp);
  const flakyTests = await api.getFlakyTests(selectedProject.id, status);

  return {
    flakyTests,
    currentProject: selectedProject,
    status,
    canMute: canMuteTests(locals.user, locals.teams, selectedProject),
  };
};

export const actions = {
  setStatus: async ({ request, locals }) => {
    const form = await request.formData();
    const id = String(form.get('id') ?? '');
    const status = String(form.get('status') ?? '');
    if (!id || (status !== 'ignored' && status !== 'active')) {
      return fail(400, { message: 'Invalid request' });
    }
    // No canMuteTests() check here on purpose: the API is the boundary and it
    // re-decides on every request. Re-deciding here too would mean two copies
    // of one rule that can drift, and the copy that drifts is the one nobody
    // tests against a real session.
    try {
      await createApi(locals.sessionToken, locals.clientIp).setFlakyStatus(id, status);
    } catch (err) {
      if (err instanceof APIError) {
        if (err.statusCode === 401 || err.statusCode === 403) {
          return fail(403, { message: 'You do not have permission to mute tests in this project.' });
        }
        return fail(err.statusCode === 404 ? 404 : 502, { message: 'Failed to update status' });
      }
      return fail(502, { message: 'Failed to update status' });
    }
    return { success: true };
  },
} satisfies Actions;
```

`selectedProject` comes from the layout and is typed `Project`, which carries
`teamId: string | null` (Task 1) — so it satisfies `canMuteTests`'s third
parameter with no cast.

- [ ] **Step 7: Run to verify everything passes**

```bash
pnpm --filter dashboard exec vitest run
env -u ADMIN_TOKEN pnpm --filter dashboard check
pnpm run lint
grep -rn "ADMIN_TOKEN" apps/dashboard/src/routes apps/dashboard/src/lib
```
Expected: PASS, clean, and the grep returns **nothing** (`hooks.server.ts` still
mentions it — Task 3 owns that file, and `adminApi.ts`'s doc comment names it
only to explain what it replaced).

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/lib apps/dashboard/src/routes/flaky
git commit -m "refactor(dashboard): mute tests as the signed-in user, not ADMIN_TOKEN"
```

---

### Task 3: replace Basic Auth with the session gate

**Files:**
- Modify: `apps/dashboard/src/hooks.server.ts`, `apps/dashboard/src/hooks.server.test.ts`
- Delete: `apps/dashboard/src/lib/server/basicAuth.ts`, `apps/dashboard/src/lib/server/basicAuth.test.ts`

**Interfaces:**
- Consumes: `redirectTargetFor`, `SESSION_COOKIE` (Task 1); `fetchMe` (Task 2).
- Produces: `event.locals.user`, `event.locals.teams`, `event.locals.sessionToken` on every request; a redirect to `/login` for anonymous traffic.

- [ ] **Step 1: Rewrite `hooks.server.test.ts`**

Replace the Basic-Auth suite entirely. It must cover:

```ts
  it('redirects an anonymous request to /login', /* … expect 302 with Location /login … */);
  it('does not redirect the /login page itself (no loop)', /* … */);
  it('clears a cookie the API rejects, so a stale session does not retry forever', /* … */);
  it('populates locals.user for a valid session', /* … */);
  it('redirects a must_change_password user to /change-password', /* … */);
  it('lets that user reach /change-password and /logout', /* … */);
  it('fails CLOSED when the API is unreachable (redirects to /login, never renders)', /* … */);
```

Mock `$lib/server/session`'s `fetchMe` with `vi.mock`, following the pattern already used by the route `page.server.test.ts` files.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dashboard exec vitest run src/hooks.server.test.ts`
Expected: FAIL — the hook still does Basic Auth.

- [ ] **Step 3: Rewrite the hook**

Replace `apps/dashboard/src/hooks.server.ts` in full:

```ts
import { redirect, type Handle } from '@sveltejs/kit';
import { SESSION_COOKIE, redirectTargetFor } from '$lib/session';
import { fetchMe } from '$lib/server/session';

/**
 * The single authentication gate for the dashboard (plan 059).
 *
 * Replaces the shared DASHBOARD_PASSWORD Basic Auth from plan 031. That hook
 * existed to close a confused deputy — an anonymous POST could mute a test,
 * and a muted test feeds the CI quarantine skip-list. The same property holds
 * here and is now stronger: the API itself authorizes per user (plan 058), so
 * the dashboard is no longer the only thing standing in the way.
 *
 * Runs in front of EVERY route by construction, so no per-route check is
 * needed or wanted.
 */
export const handle: Handle = async ({ event, resolve }) => {
  const token = event.cookies.get(SESSION_COOKIE) ?? null;

  // Delta §D1.2. Read once here and thread it through locals: this is the only
  // place the browser's address is available. adapter-node derives it from
  // ADDRESS_HEADER/XFF_DEPTH when the dashboard is itself behind a proxy —
  // those are the operator's existing knobs and this does not change them.
  const clientIp = event.getClientAddress();

  const me = token ? await fetchMe(token, clientIp) : null;

  if (token && !me) {
    // The API rejected it (expired, revoked) or was unreachable. Drop the
    // cookie so the browser stops presenting a dead credential on every
    // request — otherwise a revoked session costs an API round-trip per page
    // view, forever.
    event.cookies.delete(SESSION_COOKIE, { path: '/' });
  }

  event.locals.user = me?.user ?? null;
  event.locals.teams = me?.teams ?? [];
  event.locals.sessionToken = me ? token : null;
  event.locals.clientIp = clientIp;

  const target = redirectTargetFor(event.locals.user, event.url.pathname);
  if (target) throw redirect(303, target);

  return resolve(event);
};
```

- [ ] **Step 3b: Pin the two halves of the mid-reset contract (delta §D3)**

`redirectTargetFor`'s `ESCAPE_HATCHES` lists the dashboard routes a mid-reset
user may reach. Plan 058b's `PASSWORD_CHANGE_ALLOWLIST` lists the API requests
such a user may make. **They are two halves of one contract**: if the dashboard
redirects a user to a page whose load calls an API route the gate refuses, the
user is trapped in a loop with no way out — the exact lockout both plans exist to
prevent.

They agree today, by construction rather than by test: `/change-password` →
`POST /auth/change-password`, `/logout` → `POST /auth/logout`, and the gate's own
`fetchMe` → `GET /auth/me`. 058b's allowlist comment already records that
`/auth/me` is allowlisted *specifically* so the change-password page can render.
Agreement by coincidence is not a guarantee.

Add to `apps/dashboard/src/lib/session.test.ts`:

```ts
/**
 * The API calls each dashboard escape-hatch route makes. Hard-coded rather than
 * derived: this is a CONTRACT, and the test's value is that changing either
 * side forces a deliberate edit here.
 */
const ESCAPE_HATCH_API_CALLS = [
  { route: '/change-password', method: 'POST', path: '/api/v1/auth/change-password' },
  { route: '/logout', method: 'POST', path: '/api/v1/auth/logout' },
  // Not a route the user visits — the session gate calls it on EVERY request,
  // so a mid-reset user cannot render any page without it.
  { route: '<session gate>', method: 'GET', path: '/api/v1/auth/me' },
];

it('every API call reachable while mid-reset is on the API allowlist', () => {
  // Mirrors apps/api/src/services/auth/access.ts PASSWORD_CHANGE_ALLOWLIST.
  // If this list drifts from the API's, the assertion below fails and whoever
  // changed one side must consciously change the other.
  const apiAllowlist = [
    { method: 'POST', path: '/api/v1/auth/change-password' },
    { method: 'GET', path: '/api/v1/auth/me' },
    { method: 'HEAD', path: '/api/v1/auth/me' },
    { method: 'POST', path: '/api/v1/auth/logout' },
    { method: 'POST', path: '/api/v1/auth/login' },
  ];

  for (const call of ESCAPE_HATCH_API_CALLS) {
    expect(
      apiAllowlist.some((a) => a.method === call.method && a.path === call.path),
      `Dashboard route ${call.route} calls ${call.method} ${call.path} while the ` +
        `user is mid-reset, but that request is NOT on the API's ` +
        `PASSWORD_CHANGE_ALLOWLIST. The gate will answer 403 ` +
        `password_change_required, the page cannot load, and the user is locked ` +
        `out of password recovery with no way forward.`
    ).toBe(true);
  }
});
```

Prove it bites: temporarily drop the `/auth/me` entry from `apiAllowlist` and
watch it redden. A test that passes against an empty allowlist proves nothing.

- [ ] **Step 4: Delete the Basic-Auth module**

```bash
git rm apps/dashboard/src/lib/server/basicAuth.ts apps/dashboard/src/lib/server/basicAuth.test.ts
```

If `scripts/mutation-gate.mjs` carries a floor for `basicAuth.ts`, remove that row too — a floor pointing at a deleted file makes the gate report on nothing.

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm --filter dashboard exec vitest run
pnpm --filter dashboard check
```
Expected: PASS and clean.

- [ ] **Step 6: Commit**

```bash
git add -A apps/dashboard/src/hooks.server.ts apps/dashboard/src/hooks.server.test.ts apps/dashboard/src/lib/server scripts/mutation-gate.mjs
git commit -m "feat(dashboard): session gate replaces DASHBOARD_PASSWORD basic auth"
```

---

### Task 4: the login page

**Files:**
- Create: `apps/dashboard/src/routes/login/+page.server.ts`, `+page.svelte`, `page.svelte.test.ts`

**Interfaces:**
- Consumes: `parseSessionCookie`, `SESSION_COOKIE`.
- Produces: a `default` form action that POSTs to `/api/v1/auth/login`, lifts the token, sets the dashboard's own cookie, and redirects.

- [ ] **Step 1: Write the failing server tests**

Create `apps/dashboard/src/routes/login/page.server.test.ts` covering:

```ts
  it('sets the session cookie and redirects to / on success', /* … */);
  it('redirects to /change-password when the API says a reset is required', /* … */);
  it('returns a 400 fail with a generic message on bad credentials — never echoes which field was wrong', /* … */);
  it('never puts the password in the returned form data', /* … */);
  it('returns a 503 fail when the API is unreachable', /* … */);
```

- [ ] **Step 2: Implement the action**

Create `apps/dashboard/src/routes/login/+page.server.ts`:

```ts
import { fail, redirect, type Actions } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import { SESSION_COOKIE, parseSessionCookie } from '$lib/session';

const API_URL = env.PUBLIC_API_URL || 'http://localhost:8080';

export const actions: Actions = {
  default: async ({ request, cookies }) => {
    const form = await request.formData();
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');

    if (!email || !password) {
      return fail(400, { email, error: 'Enter your email and password.' });
    }

    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    } catch {
      return fail(503, { email, error: 'Cannot reach the Flackyness API. Is it running?' });
    }

    if (!res.ok) {
      // Deliberately generic and identical for "no such account" and "wrong
      // password" — the API already refuses to distinguish them, and echoing
      // a more helpful message here would reintroduce the enumeration oracle
      // it closed. Note `password` is NOT returned: a failed form re-render
      // must not put it back in the DOM.
      return fail(401, { email, error: 'Invalid email or password.' });
    }

    const token = parseSessionCookie(res.headers.get('set-cookie'));
    if (!token) {
      return fail(502, { email, error: 'The API did not return a session. Check the API logs.' });
    }

    const body = (await res.json()) as { mustChangePassword: boolean };

    cookies.set(SESSION_COOKIE, token, {
      // Load-bearing, and must stay identical to the gate's
      // `cookies.delete(SESSION_COOKIE, { path: '/' })` in hooks.server.ts.
      // A cookie deletion only matches a cookie with the same path, so a
      // mismatch here silently resurrects the stale-credential loop that
      // delete exists to break: the API keeps rejecting the dead session and
      // the browser keeps presenting it, one wasted round-trip per page view,
      // forever. Noted 2026-08-15 by the Task 3 review.
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      // Mirrors the API's COOKIE_SECURE: over plain http the browser silently
      // drops a Secure cookie, and the docker-compose default and the E2E
      // build are both plain http.
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: 7 * 24 * 60 * 60,
    });

    throw redirect(303, body.mustChangePassword ? '/change-password' : '/');
  },
};
```

- [ ] **Step 3: Build the page**

Create `apps/dashboard/src/routes/login/+page.svelte` — a centered card with email + password fields, a submit button, and the `form?.error` message rendered in an alert region. Match the visual language of the existing admin screens (Tailwind v4 classes, no new config). Use `use:enhance` only if the existing routes do; otherwise a plain POST form is correct and simpler.

Requirements the tests will check:
- The password input is `type="password"` and has no `value` binding that could re-render a submitted password.
- The error region carries `role="alert"`.
- The email field is repopulated from `form?.email` after a failure.

- [ ] **Step 4: Write the render test**

Create `apps/dashboard/src/routes/login/page.svelte.test.ts` (browser mode — **no `+` prefix on the test filename**, but the import keeps `+page.svelte`):

```ts
import { render } from 'vitest-browser-svelte';
import Page from './+page.svelte';
// …assert: both fields present, error shown when `form.error` is set,
// email repopulated, password field empty after a failed submit.
```

- [ ] **Step 5: Verify**

```bash
pnpm --filter dashboard exec vitest run src/routes/login
pnpm --filter dashboard test:browser
pnpm --filter dashboard check
```

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/routes/login
git commit -m "feat(dashboard): login page"
```

---

### Task 5: forced first-login password reset

**Files:**
- Create: `apps/dashboard/src/routes/change-password/+page.server.ts`, `+page.svelte`, `page.svelte.test.ts`

**Interfaces:**
- Consumes: `locals.sessionToken`, `locals.user`.
- Produces: a `default` action POSTing to `/api/v1/auth/change-password`, replacing the session cookie with the fresh one the API issues.

**The subtlety worth getting right:** the API revokes every session on a password change and issues a new one (plan 056, Task 6). The dashboard must lift *that* new cookie and overwrite its own, or the user is signed out the instant they succeed — a bug that reads as "changing my password broke my account."

- [ ] **Step 1: Write the failing server test**

```ts
  it('replaces the session cookie with the one the API re-issues', /* … assert cookies.set called with the NEW token … */);
  it('redirects to / on success', /* … */);
  it('fails with the API\'s message when the current password is wrong', /* … */);
  it('rejects a new password shorter than 12 characters before calling the API', /* … */);
  it('rejects a mismatched confirmation without calling the API', /* … */);
```

- [ ] **Step 2: Implement**

The action reads `currentPassword`, `newPassword`, `confirmPassword`; validates locally (non-empty, ≥12, match) and returns `fail(400, …)` without an API call when local validation fails; otherwise POSTs with the session cookie, and on success:

```ts
    const fresh = parseSessionCookie(res.headers.get('set-cookie'));
    if (fresh) {
      cookies.set(SESSION_COOKIE, fresh, { path: '/', httpOnly: true, sameSite: 'lax', secure: /* … */, maxAge: 7 * 24 * 60 * 60 });
    }
    throw redirect(303, '/');
```

Extract the local validation into `apps/dashboard/src/lib/password-form.ts` as a pure `validatePasswordChange(raw): string | null` returning the error message or null, and unit-test it — the same `$lib` extraction pattern as `rules-validation.ts` (plan 055). Add it to `scripts/mutation-gate.mjs` with a calibrated floor.

- [ ] **Step 3: Build the page**

`+page.svelte` — three password fields, a heading that differs when `data.forced` is true ("You must change your password before continuing"), and the error alert. The load function returns `{ forced: locals.user?.mustChangePassword ?? false }`.

- [ ] **Step 4: Write the render test** covering both the forced and voluntary headings and the error region.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter dashboard exec vitest run src/routes/change-password src/lib/password-form.test.ts
pnpm --filter dashboard test:browser
git add apps/dashboard/src/routes/change-password apps/dashboard/src/lib/password-form.ts apps/dashboard/src/lib/password-form.test.ts scripts/mutation-gate.mjs
git commit -m "feat(dashboard): forced first-login password reset"
```

---

### Task 6: user menu, sign-out, and the team switcher

**Files:**
- Create: `apps/dashboard/src/lib/components/TeamSwitcher.svelte` + `TeamSwitcher.svelte.test.ts`
- Create: `apps/dashboard/src/routes/logout/+page.server.ts`
- Modify: `apps/dashboard/src/routes/+layout.server.ts`, `+layout.svelte`, `layout.svelte.test.ts`

**Interfaces:**
- Consumes: `locals.user`, `locals.teams`.
- Produces: `+layout.server.ts` returns `{ user, teams, projects, selectedProject, apiError }`; a `/logout` action; a team filter driven by a `?team=` search param.

- [ ] **Step 1: Extend the layout load**

`+layout.server.ts` currently loads projects and picks a selected one. Add the user/teams passthrough and the team filter:

```ts
export async function load({ url, locals }: ServerLoadEvent) {
  const api = createApi(locals.sessionToken, locals.clientIp);

  let projects: Project[] = [];
  let apiError: string | null = null;

  // Delta §D2. This layout load runs for EVERY route, including
  // /change-password. Under plan 058b a mid-reset session is refused on every
  // non-allowlisted route, so getProjects() answers 403
  // password_change_required — and the catch below would report "Cannot reach
  // the Flackyness API" on the one page the user must use to recover, while
  // the API is healthy and answering exactly as designed. There is also
  // nothing to show a user who cannot read projects yet, so skip the call.
  //
  // The `locals.user &&` half is load-bearing and was ADDED 2026-08-15, during
  // execution — `!locals.user?.mustChangePassword` alone is `true` for an
  // ANONYMOUS caller, and this layout runs for /login too (Task 3's gate lets
  // /login through by design, so the gate cannot be relied on to stop this).
  // With no session, api.ts falls back to READ_TOKEN or an anonymous request,
  // and anonymous API reads are UNSCOPED (AGENTS.md: "Anonymous callers stay
  // unscoped" — true whether or not READ_TOKEN is set). The nav would
  // therefore render every project name on the instance to a visitor sitting
  // on the sign-in page. Skip the fetch unless somebody is actually signed in.
  if (locals.user && !locals.user.mustChangePassword) {
    try {
      projects = await api.getProjects();
    } catch {
      apiError = 'Cannot reach the Flackyness API. Showing an empty dashboard.';
    }
  }

  // NOTE: `projects` is ALREADY team-scoped by the API (plan 058) — this
  // filter is a UI convenience for a multi-team user narrowing their view,
  // never a security control. Do not let it become one: a client-supplied
  // ?team= must not be able to widen what the API returned.
  const teamFilter = url.searchParams.get('team');
  const visible = teamFilter ? projects.filter((p) => p.teamId === teamFilter) : projects;

  const selectedProjectId = url.searchParams.get('project') || visible[0]?.id || null;
  const selectedProject = visible.find((p) => p.id === selectedProjectId) || visible[0] || null;

  return {
    projects: visible,
    selectedProject,
    apiError,
    user: locals.user,
    teams: locals.teams,
    activeTeam: teamFilter,
  };
}
```

Add **two** load tests for the skip. In both, assert the fetch was **not
called** — not merely that `apiError` is null, which passes if the call happens
and happens to succeed:

1. (delta §D2) a **mid-reset** user's layout load performs no projects fetch and
   surfaces no `apiError`.
2. (added 2026-08-15) an **anonymous** caller's layout load performs no projects
   fetch. This is the one that guards the leak described in the comment above,
   and it fails against the original `!locals.user?.mustChangePassword`
   condition — which is exactly why it is worth writing. Assert on the fetch,
   because `projects` is `[]` either way and asserting on the result would pass
   against the leaking version whenever the API happened to return nothing.

This relies on `teamId` being present on the `GET /api/v1/projects` response, which plan 058 (Task 3, Step 4) returns additively. If it is missing, stop and fix it in the API rather than inferring team membership client-side — a filter over a field the API does not send silently shows everything.

- [ ] **Step 2: Build `TeamSwitcher.svelte`**

Renders nothing when `teams.length < 2` (a single-team user has no choice to make and should not see a dead control). Otherwise a link-based selector — "All teams" plus one entry per team — each preserving the rest of the query string. Write the query-string composition as a pure helper in `$lib/href.ts` (which already exists and is mutation-gated) rather than inline in the template.

- [ ] **Step 2b: Render the "Unassigned" group — this discharges a Global Constraint**

Do not skip this because it is not in the Step 1 code sample. It is the condition on which plan
058's pre-flight ruling was made: `POST /admin/projects` keeps `teamId` optional, so a project
created without one stays `team_id IS NULL` and — by `canReadProject`'s design — is invisible to
every non-global-admin, **including the team that created it**. 1,529 of 2,952 projects on the
dev database are already in that state. Keeping that default was allowed *only* because this
plan surfaces it; without this step the ruling becomes a silent trap.

In the project list, partition on `teamId === null` and render those under an explicit
**"Unassigned"** heading, shown only when `data.user?.isGlobalAdmin` — they are the only caller
who can read such a project at all, so the group is empty and meaningless for anyone else.

```svelte
{#if data.user?.isGlobalAdmin && unassigned.length > 0}
  <h3>Unassigned</h3>
  <!-- …same project-link markup as the grouped lists… -->
{/if}
```

Derive the partition as a pure helper in `$lib/` (next to the other extracted view logic, so it
is unit-testable in the node env and mutation-gated) rather than inline in the template.

Add render assertions to `layout.svelte.test.ts` for all three cases: the group **appears** for a
global admin when an unassigned project exists, **does not appear** for a global admin when none
does (no empty heading), and **does not appear** for a non-admin even if the array somehow
contains one. Prove the first assertion bites by removing the group and watching it redden — an
"Unassigned" heading that renders unconditionally would pass a careless test while telling every
member about projects they cannot open.

- [ ] **Step 3: Add the user menu and sign-out to `+layout.svelte`**

Show the display name or email, a "Teams"/"Users" nav entry **only when `user.isGlobalAdmin`**, and a sign-out form posting to `/logout`. Add render assertions to `layout.svelte.test.ts` for: the admin links appearing for a global admin, **not** appearing for a member, and the switcher's absence for a single-team user.

- [ ] **Step 3b: Render no app chrome when nobody is signed in**

**Added 2026-08-15, found while briefing Task 4.** `+layout.svelte` renders the
whole application shell — the nav (Overview / Flaky Tests / Runs / Analysis /
**Admin**) and the project selector fed by `data.selectedProject`. Task 3's gate
lets `/login` through anonymously by design, and that page therefore renders
*inside* this shell: an unauthenticated visitor sees links to every
authenticated screen and a project dropdown.

A SvelteKit `+page@.svelte` breakout does **not** solve this. `/login` lives at
`src/routes/login/`, and the only layout above it *is* the root — there is no
higher layout to break out to, so the `@` suffix would resolve to the same
component.

Wrap the chrome instead, so the shell is a function of being signed in:

```svelte
{#if data.user}
  <!-- existing nav + project selector + user menu -->
  {@render children()}
{:else}
  <!-- login and any other anonymous route: the page renders bare -->
  {@render children()}
{/if}
```

Add a `layout.svelte.test.ts` assertion for **both** directions: with
`data.user` set the nav is present, and with `data.user: null` **no nav link and
no project selector is in the DOM**. Assert on the absence of a specific nav
link (e.g. the "Admin" one), not merely that some wrapper is missing — the
latter passes if the markup moves rather than disappears.

This pairs with Step 1's fetch guard: that one stops the *data* reaching an
anonymous caller, this one stops the *navigation* doing so. Both are needed —
the fetch guard alone still renders an empty project selector and a full nav.

- [ ] **Step 4: Implement `/logout`**

```ts
export const actions: Actions = {
  default: async ({ cookies, locals }) => {
    if (locals.sessionToken) {
      // Best-effort: revoke server-side too. A failure here still signs the
      // user out locally — leaving the browser holding a live cookie because
      // the API hiccuped would be the worse outcome.
      try {
        await fetch(`${API_URL}/api/v1/auth/logout`, {
          method: 'POST',
          headers: { Cookie: `${SESSION_COOKIE}=${locals.sessionToken}` },
        });
      } catch { /* fall through to clearing the cookie */ }
    }
    cookies.delete(SESSION_COOKIE, { path: '/' });
    throw redirect(303, '/login');
  },
};
```

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter dashboard exec vitest run
pnpm --filter dashboard test:browser
pnpm --filter dashboard check
git add apps/dashboard/src/routes apps/dashboard/src/lib/components
git commit -m "feat(dashboard): user menu, sign-out and team switcher"
```

---

### Task 7: the teams and users admin console

> **Split during execution (2026-08-15) into 7a and 7b.** Requirements are
> unchanged — only the dispatch boundary moved. This task is ~2.5× its closest
> analogue in the repo (plan 055's rules console was one whole task at 162 +
> 279 + 379 lines; this is two of those plus two file modifications), and the
> two screens are independently reviewable.
> - **7a** — Step 1 and Step 2: the `/admin/teams` screen.
> - **7b** — Steps 3, 3b and 4: the `/admin/users` screen, the stale
>   "Set `ADMIN_TOKEN`" copy fix, and project team assignment.
>
> Three constraints on Step 4 that this section does not state, verified
> against the API while briefing: `admin/[projectId]` is reachable by a
> **team_admin**, but `GET /admin/teams` is global-admin only
> (`admin-teams.ts:28-33`), so fetching it unconditionally 403s that page for
> them; the select must render for a global admin only; and the API
> distinguishes `teamId` **absent** from `teamId: null`
> (`admin.ts:443` gates on `'teamId' in data`, since `null` is the deliberate
> orphaning case), so always sending the key makes every team_admin settings
> save fail.

**Files:**
- Create: `apps/dashboard/src/routes/admin/teams/+page.server.ts`, `+page.svelte`, `page.svelte.test.ts`
- Create: `apps/dashboard/src/routes/admin/users/+page.server.ts`, `+page.svelte`, `page.svelte.test.ts`
- Modify: `apps/dashboard/src/routes/admin/+page.svelte` (links), `admin/[projectId]/+page.svelte` (team assignment)

**Interfaces:**
- Consumes: `createAdminApi` (Task 2).
- Produces: two console screens, global-admin only.

- [ ] **Step 1: Guard both routes**

Each `load` starts:

```ts
  if (!locals.user?.isGlobalAdmin) {
    // 404, not 403: the same existence-hiding posture the API takes on reads.
    // A non-admin has no business learning that a user-management screen exists.
    error(404, 'Not found');
  }
```

The API refuses these calls anyway (plan 058) — this is a second layer so a non-admin gets a clean page instead of a rendered console full of error banners.

- [ ] **Step 2: `/admin/teams`**

`+page.server.ts` follows this shape — every action mutates, then returns freshly-loaded server state:

```ts
import { error, fail, type Actions, type ServerLoadEvent } from '@sveltejs/kit';
import { createAdminApi, AdminApiError, NotAuthenticatedError } from '$lib/server/adminApi';

export async function load({ locals }: ServerLoadEvent) {
  if (!locals.user?.isGlobalAdmin) error(404, 'Not found');
  const api = createAdminApi(locals.sessionToken, locals.clientIp);
  const [{ teams }, { users }] = await Promise.all([api.listTeams(), api.listUsers()]);
  return { teams, users };
}

/** Map an API error onto a form fail, preserving the API's own message. */
function toFail(e: unknown) {
  if (e instanceof AdminApiError) return fail(e.statusCode, { error: e.message });
  if (e instanceof NotAuthenticatedError) return fail(403, { error: 'Not signed in.' });
  // CORRECTED 2026-08-15 during execution — this line originally read `throw e`.
  // `adminFetch` ($lib/server/adminApi.ts) calls bare `fetch()` with no
  // try/catch, so an UNREACHABLE API propagates a raw TypeError, which is
  // neither type above. In a SvelteKit form action a rethrow renders a 500
  // error page instead of an inline fail() — so the console would blank out
  // exactly when the API goes down. Every other dashboard surface handles this
  // deliberately (the rules console's `actionError`, `api.ts:80`, the login and
  // change-password actions). Match them.
  return fail(502, { error: 'Cannot reach the Flackyness API. Is it running?' });
}

export const actions: Actions = {
  create: async ({ request, locals }) => {
    if (!locals.user?.isGlobalAdmin) return fail(403, { error: 'Global admin required.' });
    const name = String((await request.formData()).get('name') ?? '').trim();
    if (!name) return fail(400, { error: 'Enter a team name.' });
    try {
      await createAdminApi(locals.sessionToken, locals.clientIp).createTeam(name);
      return { success: true };
    } catch (e) {
      return toFail(e);
    }
  },

  delete: async ({ request, locals }) => {
    if (!locals.user?.isGlobalAdmin) return fail(403, { error: 'Global admin required.' });
    const form = await request.formData();
    const teamId = String(form.get('teamId') ?? '');
    const typedName = String(form.get('confirmName') ?? '');

    const api = createAdminApi(locals.sessionToken, locals.clientIp);
    // Re-fetch the authoritative name server-side and compare there. A
    // client-submitted "expected name" would let the confirmation gate be
    // bypassed by editing the DOM — same rule as plan 055's reorder.
    const { teams } = await api.listTeams();
    const team = teams.find((t) => t.id === teamId);
    if (!team) return fail(404, { error: 'Team not found.' });
    if (typedName !== team.name) {
      return fail(400, { error: `Type the team name exactly to confirm: ${team.name}` });
    }

    try {
      const res = await api.deleteTeam(teamId);
      return { success: true, orphanedProjects: res.orphanedProjects };
    } catch (e) {
      return toFail(e);
    }
  },

  // rename, addMember, setRole, removeMember follow the same shape:
  // guard → read form → call the API → return { success: true } or toFail(e).
};
```

Write `rename`, `addMember`, `setRole` and `removeMember` to that same shape — do not leave them unimplemented.

The page renders a table of teams with `memberCount` / `projectCount`, plus:
- `create` — name field.
- `rename` — inline edit.
- `delete` — **typed-name confirmation**, matching plan 053's project delete. The confirm copy must state the consequence explicitly: *"Its N projects will become unassigned, not deleted."* Read the count from the row and interpolate it.
- `addMember` / `removeMember` / `setRole` — a member list per team with a user picker and a role select.

Every action re-fetches server-side after mutating and returns fresh data; never trust a client-submitted current state (the lesson recorded in plan 055's reorder constraint).

- [ ] **Step 3: `/admin/users`**

Table of users (email, display name, global-admin flag, teams, last login), plus:
- `create` — email + display name + global-admin checkbox → renders the **show-once temporary password** using the existing `TokenReveal.svelte` component (plan 053 built it for exactly this shape; reuse it rather than writing a second reveal).
- `resetPassword` — show-once again, with copy warning that all the user's sessions are revoked.
- `toggleGlobalAdmin`, `delete` — both must surface the API's `409` ("Cannot demote/delete the last global admin") as a readable inline error, not a generic failure.
- `delete` — **typed-email confirmation, compared server-side**, the same shape
  as team delete and project delete. *(Added 2026-08-15 during execution: the
  first implementation used a client-side two-step confirm, which the action
  table above did not define a field for. The gap is one of kind, not degree —
  a client-side confirm is defeated by editing the DOM, so the most destructive
  action on this page would carry exactly one server-side guard,
  `isGlobalAdmin`, the same as the fully reversible `toggleGlobalAdmin`, while
  two less destructive deletes carry two. The API's `409` covers only the
  **last** global admin; deleting the second-to-last, or any team_admin, is
  ungated.)* Re-fetch from `listUsers()` inside the action and compare the
  typed value against the authoritative email there — never against a
  client-submitted expected value. Test it with a forged request that carries a
  competing client field, or a `?? user.email` fallback bypass survives: that
  exact mutation went unnoticed in the teams console until its review.

- [ ] **Step 3b: Fix the stale "admin disabled" copy**

**Added 2026-08-15, found during Task 2.** `apps/dashboard/src/routes/admin/+page.svelte:25-32` still tells the operator to *"Set `ADMIN_TOKEN` in the dashboard's environment to manage projects from here."* Task 2 kept the `data.adminEnabled` flag but changed what it means: it no longer reports whether the *server* holds a token, it reports whether **this caller's session** is accepted by the admin API. The advice is now not just stale but actively misleading — setting `ADMIN_TOKEN` will not make the panel appear, and an operator who follows it will conclude the feature is broken.

Replace the block's body with copy that names the real cause:

```svelte
    <h3 class="text-lg font-semibold text-gray-900 mb-2">Admin actions are unavailable</h3>
    <p class="text-muted">
      Your account does not have permission to manage projects. Ask a global
      administrator for access.
    </p>
```

Update the corresponding assertion in `apps/dashboard/src/routes/admin/page.svelte.test.ts:37` (*"shows the disabled notice when adminEnabled is false"*) to match the new text — it currently asserts on the old wording.

- [ ] **Step 4: Add team assignment to the project settings screen**

In `admin/[projectId]/+page.svelte`, add a team `<select>` (options from `listTeams`, plus an explicit "Unassigned") wired into the existing settings form action, which already PATCHes the project.

**Known limitation, do not treat as a bug (delta §D4):** a form that fails
**schema** validation shows the generic `API request failed (400)` rather than
the real problem. Follow-up #25 in `plans/README.md` records why: all 14
`zValidator` call sites are mounted without a custom hook, so a validation `400`
returns the library's own shape, in which `error` is an **object**, not a string
— and `adminFetch`'s `typeof errBody.error === 'string'` check correctly
declines to render an object. It degrades safely: no crash, no wrong data. Do
**not** fix it inside this plan; that means changing the error contract of 14 API
routes mid-feature, which is #25's job. Expect it during console testing.

- [ ] **Step 5: Render tests**

For each screen: the table renders rows; the delete confirm is disabled until the typed name matches; the temp password is shown once and the reveal is present; a `409` error message renders in the alert region.

- [ ] **Step 6: Verify and commit**

```bash
pnpm --filter dashboard exec vitest run
pnpm --filter dashboard test:browser
pnpm --filter dashboard check
git add apps/dashboard/src/routes/admin
git commit -m "feat(dashboard): teams and users admin console"
```

---

### Task 8: E2E, deployment config, and the breaking-change notice

**Files:**
- Create: `apps/dashboard/e2e/auth.spec.ts`
- Modify: `apps/dashboard/e2e/global-setup.ts`, `playwright.config.ts`
- Modify: `docker-compose.yml`, `.env.example`, `docs/GETTING_STARTED.md`, `AGENTS.md`, `plans/README.md`

- [ ] **Step 1: Seed a user in `global-setup.ts`**

Every existing spec now hits the login gate. Extend the global setup to create a global-admin user via `POST /api/v1/admin/users` with `ADMIN_TOKEN`, change its password to a known value via the API, and save a signed-in `storageState` for the suite to reuse:

```ts
  // Sign in once and persist the cookie; specs then start authenticated.
  // Without this every spec written before plan 059 would redirect to /login.
```

Wire `use: { storageState: 'e2e/.auth/user.json' }` into `playwright.config.ts` and add `e2e/.auth/` to `.gitignore`.

- [ ] **Step 2: Write `auth.spec.ts`**

Cover the flows that only a real browser proves:
- Visiting `/` unauthenticated lands on `/login`.
- Wrong credentials show the error and stay on `/login`.
- Correct credentials land on `/`.
- A freshly provisioned user is forced to `/change-password` and cannot navigate away until they change it.
- After changing, they reach `/` and stay signed in (this is the re-issued-cookie property from Task 5 — the one that fails silently in unit tests).
- Sign-out returns to `/login` and the back button does not restore the session.
- The show-once temp password appears exactly once: reload `/admin/users` and assert it is gone.

Use a fresh browser context (not the shared `storageState`) for the specs that need an anonymous or a forced-reset user.

- [ ] **Step 3: Retire `DASHBOARD_PASSWORD`**

- `docker-compose.yml` — remove `DASHBOARD_PASSWORD` from the dashboard service's `environment`. **Leave `ORIGIN` alone.** If `DASHBOARD_PASSWORD` is in the top-level `env_file`/required-vars set, remove it there too — `AGENTS.md` records that compose refuses to parse without `DB_PASSWORD` and `ADMIN_TOKEN`; confirm `DASHBOARD_PASSWORD` is not in that same required set before assuming its removal is inert.

- `docker-compose.yml` **and** `.env.example` — **add `COOKIE_SECURE` to the *dashboard* service.** Found 2026-08-15 by the Task 4 review. From plan 059 on, the cookie the dashboard sets at login is the **only session cookie a browser ever holds** — the API's own `Set-Cookie` is consumed server-side by `parseSessionCookie` and never reaches the browser. `COOKIE_SECURE` today appears only in `docs/API.md` and on the API service, so `privateEnv.COOKIE_SECURE` in the dashboard is permanently `undefined` on the documented deployment: an operator running behind a TLS proxy has **no way to mark the real session cookie `Secure`**. Add it as
  `COOKIE_SECURE: ${COOKIE_SECURE:-false}` with a comment saying to set it to
  `true` whenever the dashboard is served over https, and add the same line to
  `.env.example`.

  **Do not "fix" this by making the dashboard mirror the API's
  `isCookieSecure()`.** That helper is three-way (`'true'`→true, `'false'`→false,
  unset→`NODE_ENV === 'production'`); the dashboard's is deliberately two-way
  (unset→false). Compose sets `NODE_ENV: production` with a plain-http `ORIGIN`,
  so adopting the API's default would mark the browser cookie `Secure` over
  http, the browser would silently drop it, and **sign-in would break on the
  default deployment**. The divergence is correct; the missing knob is the bug.
- `.env.example` — remove the variable; add a comment pointing at the bootstrap procedure.
- `AGENTS.md` — replace the plan-053 sharp edge about `DASHBOARD_PASSWORD` gating `/admin` with the account model, and add:

```markdown
- **The dashboard authenticates users, not a shared password (plan 059).**
  `DASHBOARD_PASSWORD` is **gone**; `hooks.server.ts` validates the `fk_session`
  cookie against `GET /auth/me` and redirects anonymous traffic to `/login`.
  The dashboard **no longer holds `ADMIN_TOKEN`** — `$lib/server/adminApi.ts`
  forwards the signed-in user's session, and the API authorizes per user
  (plan 058). `ADMIN_TOKEN` remains a valid API credential for operators and
  scripts. On upgrade an operator MUST create their first global admin via
  `POST /api/v1/admin/users` with `ADMIN_TOKEN` before they can sign in — see
  `docs/GETTING_STARTED.md`.
```

- `docs/GETTING_STARTED.md` — promote the bootstrap procedure added in plan 057 into an explicit **Upgrading** section stating the breaking change in one sentence at the top.

- [ ] **Step 4: Add the plan row to `plans/README.md`**

```markdown
| 059 | Roadmap #5+#6 Phase D: dashboard accounts & teams — `/login`, session gate in `hooks.server.ts`, forced first-login reset, team switcher, global-admin teams/users console, project team assignment. **Breaking: `DASHBOARD_PASSWORD` removed** (operators must create a user first); the dashboard also stops holding `ADMIN_TOKEN` and acts as the signed-in user | P2 | M–L | **058 (hard)** | TODO |
```

- [ ] **Step 5: Full verification**

```bash
pnpm lint
pnpm --filter dashboard check
pnpm --filter dashboard test
pnpm --filter dashboard test:browser
pnpm --filter dashboard test:e2e
node scripts/mutation-gate.mjs
```

All must pass. The E2E suite needs a real Postgres and a running API — see `AGENTS.md`.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/e2e apps/dashboard/playwright.config.ts .gitignore docker-compose.yml .env.example docs/GETTING_STARTED.md AGENTS.md plans/README.md
git commit -m "feat(dashboard): retire DASHBOARD_PASSWORD in favour of user accounts"
```

---

## Definition of done

- [ ] Two dashboard users signing in from **different** browser IPs occupy
      **separate** rate-limit buckets on the API — the assertion that actually
      proves delta §D1. One that checks a single request still passes against
      the shared bucket this work exists to eliminate.
- [ ] A mid-reset user's layout load performs no projects fetch and shows no
      "Cannot reach the Flackyness API" banner (delta §D2).
- [ ] An anonymous visit to any route redirects to `/login`; there is no redirect loop on `/login` itself.
- [ ] A provisioned user signs in with their temp password, is forced to `/change-password`, cannot navigate away, and **stays signed in** after changing it.
- [ ] A member sees only their teams' projects; the team switcher appears only for multi-team users; the Teams/Users nav appears only for global admins.
- [ ] `grep -rn "DASHBOARD_PASSWORD" apps/ docker-compose.yml .env.example --include='*.ts' --include='*.svelte' --include='*.yml' --include='.env.example'` returns **no configuration or code reference** — no `env.DASHBOARD_PASSWORD` read, no compose/env entry, no live `.env.example` assignment. Expect exactly **three** comment matches (listed below).

  Amended 2026-08-15: the original wording demanded the grep return *nothing*
  outside `plans/` and `docs/`, which can never hold. Three **comments**
  legitimately name the variable to record what was removed and why —
  `hooks.server.ts`'s gate docstring (which Task 3's brief mandates verbatim,
  and which explains the confused-deputy problem the old gate solved),
  `apps/api/src/index.ts`'s cookie-security warning, and `.env.example`'s note
  that there is no `DASHBOARD_PASSWORD` to set. Deleting a historical
  explanation to satisfy a grep trades a real maintenance aid for a green
  check. Verify the *absence of live reads*, not the absence of the string.

  Corrected 2026-08-15 (final fix wave): the command previously ended
  `--include='*.ts' --include='*.svelte' --include='*.yml'` and named
  `.env.example` as a path — but `--include` filters explicitly-named files
  too, so `.env.example` was silently excluded and the command **could not
  test the very half of its claim that mentions it**. Proven by planting a
  `DASHBOARD_PASSWORD=canary` line in `.env.example` and watching the old
  command still return only the two `.ts` comments; the added
  `--include='.env.example'` catches it. The property itself always held —
  this was a false green, not a missed defect. It is the third
  unsatisfiable-or-blind grep found in this plan, which is why the expected
  match count is now stated explicitly rather than left as "no reference".
- [ ] `grep -rn "env.ADMIN_TOKEN\|ADMIN_TOKEN}" apps/dashboard/src` returns
  **nothing** — no code path reads or spends the token. Amended 2026-08-15: the
  original wording was "`grep -rn "ADMIN_TOKEN" apps/dashboard/src` returns
  nothing", which is unsatisfiable and would have been discovered here, at the
  end. Two brief-mandated *mentions* survive and should: `adminApi.ts`'s
  `NotAuthenticatedError` doc comment, which names the token to explain what it
  replaced, and `adminApi.test.ts`'s assertion *"forwards the caller's session
  cookie, not an ADMIN_TOKEN"*, whose whole value is naming what must not be
  sent. Deleting either to satisfy a grep would make the codebase worse.
- [ ] `pnpm lint`, `pnpm --filter dashboard check`, the node suite, the browser suite, the E2E suite, and the mutation gate all pass.

## Follow-ups this plan deliberately does not do

- **No external SSO/OIDC.** The remaining slice of roadmap #6 and a clean fast-follow at the same seam (spec §Scope boundaries).
- **No self-signup, email invites, or password-reset-by-email.** There is no SMTP in the stack; provisioning stays admin-driven.
- **No per-user audit trail.** `quarantine_events` still records `auto`/`manual`, not *which* user.
- **No team-scoped notification routing.** Webhooks stay per-project.
