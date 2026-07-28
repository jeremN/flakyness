# Dashboard Accounts & Teams (Phase D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's single shared `DASHBOARD_PASSWORD` with real accounts — a `/login` page, a forced first-login password reset, team-scoped views with a switcher for multi-team users, and a global-admin console for teams and users — with the user's session, not an ambient `ADMIN_TOKEN`, authorizing every call.

**Architecture:** `hooks.server.ts` becomes the single gate: it reads the `fk_session` cookie, validates it against `GET /auth/me`, populates `event.locals.user`, and redirects unauthenticated traffic to `/login`. Both server-only API clients (`$lib/server/api.ts`, `$lib/server/adminApi.ts`) are converted from module-level functions into per-request factories that carry the caller's session cookie — so the compiler forces every call site to supply an identity, and the dashboard stops holding `ADMIN_TOKEN` at all. Pure `$lib` helpers carry the view-logic and are node-unit-tested to be mutation-provable.

**Tech Stack:** SvelteKit (Svelte 5 runes), TypeScript, Vitest (node + browser mode via `vitest-browser-svelte`), Playwright (E2E), Tailwind v4, Stryker.

**Spec:** `docs/superpowers/specs/2026-07-25-teams-identity-access-control-design.md` (Phase D)

## Global Constraints

Every task's requirements implicitly include this section.

- **Depends hard on plans 056–058.** The API must already accept global-admin **sessions** on the admin API (plan 058, Task 5) — otherwise the console cannot work without `ADMIN_TOKEN`.
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
- `apps/dashboard/src/lib/server/session.ts` — server-only `fetchMe(sessionToken)`.
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
  - `fetchMe(sessionToken: string): Promise<{ user: SessionUser; teams: TeamSummary[] } | null>`
  - `createApi(sessionToken: string | null)` — returns `{ getProjects, getProjectStats, getFlakyTests, getProjectRuns, getRunDetail, getTestHistory, getFlakeTrend, getTestTrend, getAnalysis }`, same signatures as today.
  - `createAdminApi(sessionToken: string | null)` — returns the existing admin functions plus `listTeams`, `createTeam`, `patchTeam`, `deleteTeam`, `listTeamMembers`, `addTeamMember`, `patchTeamMember`, `removeTeamMember`, `listUsers`, `createUser`, `patchUser`, `resetUserPassword`, `deleteUser`.

**Why a factory and not an extra parameter:** converting to a factory **deletes** the module-level exports, so every existing call site stops compiling until it supplies an identity. An optional parameter would let a forgotten call site keep compiling and silently make an unauthenticated request — the same "remember to do it" failure class this repo has been bitten by three times.

- [ ] **Step 1: Write the failing client tests**

Extend `apps/dashboard/src/lib/server/adminApi.test.ts` (and create the equivalent for `api.ts` if absent):

```ts
  it('forwards the caller\'s session cookie, not an ADMIN_TOKEN', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ projects: [] }));
    await createAdminApi('sess-abc').listProjects();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Cookie).toBe('fk_session=sess-abc');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('refuses to call the admin API with no session rather than calling it anonymously', async () => {
    await expect(createAdminApi(null).listProjects()).rejects.toBeInstanceOf(NotAuthenticatedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a 403 from the API as an AdminApiError carrying the status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Global admin required' }, 403));
    await expect(createAdminApi('s').listTeams()).rejects.toMatchObject({ statusCode: 403 });
  });
```

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

export function createAdminApi(sessionToken: string | null) {
  async function adminFetch<T>(
    path: string,
    init: { method: string; body?: unknown } = { method: 'GET' }
  ): Promise<T> {
    if (!sessionToken) throw new NotAuthenticatedError();

    const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${sessionToken}` };
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

Wrap the existing nine read functions in `createApi(sessionToken)`. Replace the `READ_TOKEN` Authorization header with the session cookie, but **keep the `READ_TOKEN` fallback** for the token itself: a deployment may run the dashboard against an API that has `READ_TOKEN` set, and SSR requests made before login (there are none once the gate lands, but the 401 message is still the operator's best diagnostic) should keep the existing explanatory error at `api.ts:41-49`. Concretely:

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
  sessionToken: string
): Promise<{ user: SessionUser; teams: TeamSummary[] } | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/auth/me`, {
      headers: { Cookie: `${SESSION_COOKIE}=${sessionToken}` },
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
  const api = createApi(locals.sessionToken);
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

  const me = token ? await fetchMe(token) : null;

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

  const target = redirectTargetFor(event.locals.user, event.url.pathname);
  if (target) throw redirect(303, target);

  return resolve(event);
};
```

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
  const api = createApi(locals.sessionToken);

  let projects: Project[] = [];
  let apiError: string | null = null;
  try {
    projects = await api.getProjects();
  } catch {
    apiError = 'Cannot reach the Flackyness API. Showing an empty dashboard.';
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

This relies on `teamId` being present on the `GET /api/v1/projects` response, which plan 058 (Task 3, Step 4) returns additively. If it is missing, stop and fix it in the API rather than inferring team membership client-side — a filter over a field the API does not send silently shows everything.

- [ ] **Step 2: Build `TeamSwitcher.svelte`**

Renders nothing when `teams.length < 2` (a single-team user has no choice to make and should not see a dead control). Otherwise a link-based selector — "All teams" plus one entry per team — each preserving the rest of the query string. Write the query-string composition as a pure helper in `$lib/href.ts` (which already exists and is mutation-gated) rather than inline in the template.

- [ ] **Step 3: Add the user menu and sign-out to `+layout.svelte`**

Show the display name or email, a "Teams"/"Users" nav entry **only when `user.isGlobalAdmin`**, and a sign-out form posting to `/logout`. Add render assertions to `layout.svelte.test.ts` for: the admin links appearing for a global admin, **not** appearing for a member, and the switcher's absence for a single-team user.

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
  const api = createAdminApi(locals.sessionToken);
  const [{ teams }, { users }] = await Promise.all([api.listTeams(), api.listUsers()]);
  return { teams, users };
}

/** Map an API error onto a form fail, preserving the API's own message. */
function toFail(e: unknown) {
  if (e instanceof AdminApiError) return fail(e.statusCode, { error: e.message });
  if (e instanceof NotAuthenticatedError) return fail(403, { error: 'Not signed in.' });
  throw e;
}

export const actions: Actions = {
  create: async ({ request, locals }) => {
    if (!locals.user?.isGlobalAdmin) return fail(403, { error: 'Global admin required.' });
    const name = String((await request.formData()).get('name') ?? '').trim();
    if (!name) return fail(400, { error: 'Enter a team name.' });
    try {
      await createAdminApi(locals.sessionToken).createTeam(name);
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

    const api = createAdminApi(locals.sessionToken);
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

- [ ] **Step 4: Add team assignment to the project settings screen**

In `admin/[projectId]/+page.svelte`, add a team `<select>` (options from `listTeams`, plus an explicit "Unassigned") wired into the existing settings form action, which already PATCHes the project.

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

- [ ] An anonymous visit to any route redirects to `/login`; there is no redirect loop on `/login` itself.
- [ ] A provisioned user signs in with their temp password, is forced to `/change-password`, cannot navigate away, and **stays signed in** after changing it.
- [ ] A member sees only their teams' projects; the team switcher appears only for multi-team users; the Teams/Users nav appears only for global admins.
- [ ] `grep -rn "DASHBOARD_PASSWORD" --include='*.ts' --include='*.svelte' --include='*.yml' apps/ docker-compose.yml .env.example` returns **nothing** outside `plans/` and `docs/superpowers/specs/` (historical records).
- [ ] `grep -rn "ADMIN_TOKEN" apps/dashboard/src` returns **nothing**.
- [ ] `pnpm lint`, `pnpm --filter dashboard check`, the node suite, the browser suite, the E2E suite, and the mutation gate all pass.

## Follow-ups this plan deliberately does not do

- **No external SSO/OIDC.** The remaining slice of roadmap #6 and a clean fast-follow at the same seam (spec §Scope boundaries).
- **No self-signup, email invites, or password-reset-by-email.** There is no SMTP in the stack; provisioning stays admin-driven.
- **No per-user audit trail.** `quarantine_events` still records `auto`/`manual`, not *which* user.
- **No team-scoped notification routing.** Webhooks stay per-project.
