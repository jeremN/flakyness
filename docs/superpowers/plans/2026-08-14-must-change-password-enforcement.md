# `mustChangePassword` Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `users.must_change_password` an actual authorization boundary in `apps/api`, so a session holding an unrotated temporary password can do nothing but complete the password change.

**Architecture:** Two enforcement points sharing one predicate. **Layer 1** — `Access` gains `mustChangePassword`, and `canReadProject` / `canWriteProject` / `canAdministerTeams` / `canEnterAdminApi` refuse when it is set. **Layer 2** — a `passwordChangeGate()` middleware mounted `use('*')` on each of the seven `/api/v1` routers, immediately after that router's rate limiter, which returns `403 { code: 'password_change_required' }` unless the path is on a four-entry allowlist. Layer 2 runs before every other authorization code path, so it is the sole emitter of the error contract; layer 1 is the backstop for a router that never mounts it.

**Tech Stack:** TypeScript 7, Hono 4, Drizzle ORM, Postgres, Vitest 4, Stryker (mutation gate).

**Spec:** `docs/superpowers/specs/2026-08-14-must-change-password-enforcement-design.md`. Read it before Task 1 — it records *why* each of these decisions is what it is, including three that were wrong in earlier drafts.

## Global Constraints

- **`apps/api` only.** No dashboard changes. Plan 059 owns the redirect and consumes `code`.
- **Commits:** one single-line conventional-commit subject. **No `Co-Authored-By` trailer.** Never `--no-verify`.
- **Branch:** `feat/must-change-password-enforcement` (already exists, already has the spec commits). `main` is branch-protected.
- **The gate must `return c.json(..., 403)`, never `throw new HTTPException(403, ...)`.** The global error handler renders exceptions as `c.json({ error: err.message }, err.status)` (`apps/api/src/index.ts:44-52`) and **drops any `code` field**. Throwing produces exactly the opaque refusal the spec forbids.
- **Zero behaviour change for machine credentials that present no session cookie.** CI ingest (project token), `ADMIN_TOKEN` and `READ_TOKEN` callers must be byte-identical. A request carrying *both* a must-change cookie and a bearer token IS refused — session outranks bearer (`apps/api/src/middleware/access.ts:50-70`), and that is intended.
- **Structured logger only** (`apps/api/src/middleware/logger.ts`), never `console.log`.
- **Never run Stryker locally.** `apps/api/reports/mutation/mutation.json` is gitignored and every run overwrites it wholesale. The nightly `Mutation` workflow is the only place it runs.
- **Test env:** API route suites need `DATABASE_URL` and `ADMIN_TOKEN` exported or they self-skip. Postgres runs on **port 5433** (`docker compose up -d postgres`), not 5432.
- **Every assertion must be mutation-provable.** An assertion that passes against a deliberately broken implementation is a plan failure, not a test. Each task below names the mutation its test must catch.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/api/src/services/auth/access.ts` | *modify* — `Access.mustChangePassword`, `requiresPasswordChange()`, `PASSWORD_CHANGE_ALLOWLIST`, four predicate short-circuits | 1 |
| `apps/api/src/services/auth/access.test.ts` | *modify* — unit proof of layer 1 | 1 |
| `apps/api/src/middleware/access.ts` | *modify* — one line: populate the new field from `sessionUser` | 1 |
| `apps/api/src/middleware/password-change.ts` | **create** — `passwordChangeGate()`, tagged `isPasswordChangeGate` | 2 |
| `apps/api/src/middleware/password-change.test.ts` | **create** — unit proof of layer 2 | 2 |
| `apps/api/src/routes/{reports,projects,tests,admin,admin-users,admin-teams,auth}.ts` | *modify* — one `use('*', passwordChangeGate())` line each | 3 |
| `apps/api/src/password-change-coverage.test.ts` | **create** — static guards: seven mounts, allowlist matches the auth route table | 3 |
| `apps/api/src/routes/password-change-enforcement.test.ts` | **create** — HTTP behaviour: lockout, contract uniformity, non-regression, layer-1 isolation, rate limiting | 4, 5 |
| `docs/API.md` | *modify* — document the 403 and its `code` | 6 |
| `AGENTS.md`, `.agent/CONTEXT.md`, `plans/README.md` | *modify* — sharp edge + status | 6 |

---

## Task 1: The shared rule (layer 1)

**Files:**
- Modify: `apps/api/src/services/auth/access.ts`
- Modify: `apps/api/src/middleware/access.ts:61-68`
- Test: `apps/api/src/services/auth/access.test.ts`
- Test: `apps/api/src/middleware/session.test.ts:136-163`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `Access.mustChangePassword: boolean` — a new required field on the existing `Access` interface.
  - `requiresPasswordChange(access: Access): boolean`
  - `PASSWORD_CHANGE_ALLOWLIST: readonly string[]`
  - Task 2 imports `PASSWORD_CHANGE_ALLOWLIST`; Task 3's coverage guard imports it too.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/auth/access.test.ts` already defines the fixtures these tests need (`base`, `member()`, `globalAdminUser`, `projectInA`, `orphan`, `TEAM_A` at lines 13-40). **Reuse them — do not add a parallel builder.** Two edits:

First, `base` is a full `Access` literal and the new field is required, so add one line to it (this is what makes `tsc` red until it is done):

```ts
const base: Access = {
  kind: 'anonymous',
  userId: null,
  isGlobalAdmin: false,
  teamIds: [],
  roleByTeam: {},
  projectId: null,
  mustChangePassword: false,
};
```

Then append:

```ts
// A mid-reset variant of each fixture the file already uses. Spreading the
// existing ones rather than rebuilding them is deliberate: if the Access shape
// changes again, these follow automatically instead of silently going stale.
const midResetMember = (teams: Record<string, 'team_admin' | 'member'>): Access => ({
  ...member(teams),
  mustChangePassword: true,
});
const midResetGlobalAdmin: Access = { ...globalAdminUser, mustChangePassword: true };

describe('requiresPasswordChange', () => {
  it('is true only for a user session carrying the flag', () => {
    expect(requiresPasswordChange(midResetMember({ [TEAM_A]: 'team_admin' }))).toBe(true);
    expect(requiresPasswordChange(member({ [TEAM_A]: 'team_admin' }))).toBe(false);
  });

  it('is false for every non-user kind, even if the flag is somehow set', () => {
    // Defence against a future edit that spreads a user Access into a token
    // one. Tokens are never mid-reset; the kind check is what guarantees it.
    for (const kind of ['project-token', 'read-token', 'admin-token', 'anonymous'] as const) {
      expect(
        requiresPasswordChange({ ...base, kind, mustChangePassword: true }),
        `${kind} must never be treated as mid-reset`
      ).toBe(false);
    }
  });

  it('anonymousAccess() never carries the flag', () => {
    expect(anonymousAccess().mustChangePassword).toBe(false);
  });
});

describe('the four predicates refuse a mid-reset user', () => {
  // Every case is asserted BOTH ways. A bare `toBe(false)` would also pass if
  // the predicate refused for an unrelated reason — wrong team, wrong role —
  // so each refusal is paired with the permit it would otherwise have been.
  it('canReadProject', () => {
    expect(canReadProject(member({ [TEAM_A]: 'member' }), projectInA)).toBe(true);
    expect(canReadProject(midResetMember({ [TEAM_A]: 'member' }), projectInA)).toBe(false);
  });

  it('canWriteProject', () => {
    expect(canWriteProject(member({ [TEAM_A]: 'team_admin' }), projectInA)).toBe(true);
    expect(canWriteProject(midResetMember({ [TEAM_A]: 'team_admin' }), projectInA)).toBe(false);
  });

  it('canAdministerTeams', () => {
    expect(canAdministerTeams(globalAdminUser)).toBe(true);
    expect(canAdministerTeams(midResetGlobalAdmin)).toBe(false);
  });

  it('canEnterAdminApi — both branches, not just the global-admin one', () => {
    expect(canEnterAdminApi(globalAdminUser)).toBe(true);
    expect(canEnterAdminApi(midResetGlobalAdmin)).toBe(false);
    // canEnterAdminApi's second branch (a plain team_admin) does NOT go through
    // canAdministerTeams. Guarding only that function is the obvious half-fix,
    // and this pair is what catches it.
    expect(canEnterAdminApi(member({ [TEAM_A]: 'team_admin' }))).toBe(true);
    expect(canEnterAdminApi(midResetMember({ [TEAM_A]: 'team_admin' }))).toBe(false);
  });

  it('the check is ordered BEFORE the isGlobalAdmin shortcut', () => {
    // canReadProject and canWriteProject both open with
    // `if (access.isGlobalAdmin) return true`. Putting the new check after it
    // leaves global admins — the highest-value accounts — entirely unenforced.
    // `orphan` (teamId: null) is readable by global admins ONLY, so a true here
    // can come from nothing but the isGlobalAdmin branch having run first.
    expect(canReadProject(globalAdminUser, orphan)).toBe(true);
    expect(canReadProject(midResetGlobalAdmin, orphan)).toBe(false);
    expect(canWriteProject(globalAdminUser, orphan)).toBe(true);
    expect(canWriteProject(midResetGlobalAdmin, orphan)).toBe(false);
  });
});

describe('PASSWORD_CHANGE_ALLOWLIST', () => {
  it('is exactly the four recovery paths, spelled in full', () => {
    // Full absolute paths, not suffixes: the gate matches against c.req.path,
    // which Hono reports as the whole request path even inside a sub-router.
    expect([...PASSWORD_CHANGE_ALLOWLIST].sort()).toEqual([
      '/api/v1/auth/change-password',
      '/api/v1/auth/login',
      '/api/v1/auth/logout',
      '/api/v1/auth/me',
    ]);
  });
});
```

Add the new names to the file's existing import from `./access`: `requiresPasswordChange`, `PASSWORD_CHANGE_ALLOWLIST`, `canAdministerTeams`, and the `Access` type if not already imported.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter api exec vitest run src/services/auth/access.test.ts
```

Expected: FAIL — `requiresPasswordChange is not a function` / `PASSWORD_CHANGE_ALLOWLIST is not defined`, plus type errors on `mustChangePassword`.

- [ ] **Step 3: Add the field, the predicate and the allowlist**

In `apps/api/src/services/auth/access.ts`, extend the interface (after `projectId`, line 17):

```ts
  /**
   * The caller is a `user` whose password was admin-provisioned or admin-reset
   * and not yet rotated. Only ever true for kind === 'user' — every token-kind
   * Access is built by spreading anonymousAccess(), which sets it false.
   */
  mustChangePassword: boolean;
```

In `anonymousAccess()`, add `mustChangePassword: false,` after `projectId: null,`.

Add, below `anonymousAccess()`:

```ts
/**
 * Is this caller holding an unrotated temporary password?
 *
 * The `kind` check is load-bearing, not defensive noise: it is what guarantees
 * a token can never be classified as mid-reset even if a future edit spreads a
 * user Access into one.
 */
export function requiresPasswordChange(access: Access): boolean {
  return access.kind === 'user' && access.mustChangePassword;
}

/**
 * Routes reachable while a password change is pending.
 *
 * EXPLICIT ABSOLUTE PATHS, never an `/api/v1/auth` prefix — plan 041's
 * SELF_GATED carries the same warning, for the same reason: a prefix silently
 * exempts every future auth route. Adding an entry here must be a deliberate,
 * reviewed edit, and password-change-coverage.test.ts fails CI if a new auth
 * route appears without one.
 *
 * The contents follow AWS IAM's PasswordResetRequired rule — allow what
 * COMPLETES the remedy, not only the remedy itself:
 *   change-password  the remedy
 *   me               the dashboard cannot render the change-password page without it
 *   logout           never trap a user in a session they cannot leave
 *   login            re-authenticating must not be blocked by a pending reset
 */
export const PASSWORD_CHANGE_ALLOWLIST: readonly string[] = [
  '/api/v1/auth/change-password',
  '/api/v1/auth/me',
  '/api/v1/auth/logout',
  '/api/v1/auth/login',
];
```

Add the short-circuit as the **first statement** of all four predicates — ahead of the `isGlobalAdmin` shortcut in the two that have one:

```ts
export function canReadProject(access: Access, project: ScopedProject): boolean {
  if (requiresPasswordChange(access)) return false;
  if (access.isGlobalAdmin) return true;
  // ...unchanged
```

```ts
export function canWriteProject(access: Access, project: ScopedProject): boolean {
  if (requiresPasswordChange(access)) return false;
  if (access.isGlobalAdmin) return true;
  // ...unchanged
```

```ts
export function canAdministerTeams(access: Access): boolean {
  if (requiresPasswordChange(access)) return false;
  return access.isGlobalAdmin || access.kind === 'admin-token';
}
```

```ts
export function canEnterAdminApi(access: Access): boolean {
  // Guarded here as well as in canAdministerTeams: the second branch below
  // does NOT go through canAdministerTeams, so guarding only that function
  // would leave a mid-reset team_admin with full admin-API entry.
  if (requiresPasswordChange(access)) return false;
  if (canAdministerTeams(access)) return true;
  return access.kind === 'user' && Object.values(access.roleByTeam).includes('team_admin');
}
```

Leave `scopesProjectList` alone — it answers "filter this list?", not "permit or deny", and its safe direction is already `true`.

- [ ] **Step 4: Populate the field from the session**

In `apps/api/src/middleware/access.ts`, in `resolveAccessValue`'s user branch (the return at lines 61-68), add one property:

```ts
    return {
      kind: 'user',
      userId: sessionUser.id,
      isGlobalAdmin: sessionUser.isGlobalAdmin,
      teamIds: memberships.map((m) => m.teamId),
      roleByTeam,
      projectId: null,
      mustChangePassword: sessionUser.mustChangePassword,
    };
```

No other branch changes: every token branch already spreads `anonymousAccess()`.

- [ ] **Step 5: Close the shared single point of failure**

Both layers read `mustChangePassword` off one `SessionUser` object, set once by `sessionAuth()` (`middleware/session.ts:100-107`). If a future edit drops the field from that projection, **both layers fail open at once** and nothing else notices. The spec rejected buying real input independence (it would cost a DB read per authenticated request) in favour of guarding this point directly.

`session.test.ts:136` already asserts the whole object with `toEqual`, so a *dropped* field reds it. But every existing case uses `mustChangePassword: false`, so a projection hard-coded to `false` — the more likely mistake, and a total fail-open — passes today. Add the missing direction, right after that test:

```ts
  it('propagates mustChangePassword: true — the value, not just the key', async () => {
    // The sibling test above pins the SHAPE. This pins the VALUE: a projection
    // that hard-coded `mustChangePassword: false` would keep that test green
    // while failing BOTH enforcement layers open, everywhere, silently.
    const row: FakeRow = {
      sessionId: 'sess-mid-reset',
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(Date.now() - 1_000),
      id: 'user-2',
      email: 'grace@example.com',
      displayName: 'Grace Hopper',
      isGlobalAdmin: false,
      mustChangePassword: true,
    };
    selectMock.mockReturnValue(chain(Promise.resolve([row])));

    const app = buildApp();
    const res = await app.request('/', { headers: { Cookie: `${SESSION_COOKIE}=live-token` } });

    expect(res.status).toBe(200);
    expect((await res.json()).user.mustChangePassword).toBe(true);
  });
```

If `buildApp()` / `chain()` / `FakeRow` differ from the sibling test's usage, follow the sibling test exactly — it is the working reference in the same file.

- [ ] **Step 6: Run the tests and the typechecker**

```bash
pnpm --filter api exec vitest run src/services/auth/access.test.ts src/middleware/session.test.ts
pnpm --filter api exec tsc --noEmit
```

Expected: PASS, and 0 type errors. `tsc` is the point of making the field **required** rather than optional — every literal that builds an `Access` must now name it, so no construction site can be silently missed. Fix each error it reports by adding `mustChangePassword: false`; do not make the field optional to silence them.

- [ ] **Step 7: Run the full API unit suite for regressions**

```bash
pnpm --filter api exec vitest run
```

Expected: PASS. Route suites self-skip without `DATABASE_URL`/`ADMIN_TOKEN`; that is fine here — Task 4 is where they must run.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/auth/access.ts apps/api/src/services/auth/access.test.ts \
        apps/api/src/middleware/access.ts apps/api/src/middleware/session.test.ts
git commit -m "feat(api): refuse mid-reset sessions in the access predicates"
```

---

## Task 2: The gate middleware (layer 2)

**Files:**
- Create: `apps/api/src/middleware/password-change.ts`
- Test: `apps/api/src/middleware/password-change.test.ts`

**Interfaces:**
- Consumes: `PASSWORD_CHANGE_ALLOWLIST` from Task 1; `getSessionUser` from `./session`.
- Produces:
  - `passwordChangeGate(): PasswordChangeGateMiddleware`
  - `interface PasswordChangeGateMiddleware extends MiddlewareHandler { isPasswordChangeGate: true }`
  - Task 3 mounts the function and its static guard keys off the `isPasswordChangeGate` tag.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/middleware/password-change.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { passwordChangeGate } from './password-change';
import type { SessionUser } from './session';

/**
 * Layer 2 in isolation — no database, no real session lookup. A fake
 * sessionAuth writes the context variable that the real one would, so this
 * file proves the GATE, not the session plumbing.
 */
function appWith(sessionUser: SessionUser | null): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (sessionUser) c.set('sessionUser', sessionUser);
    await next();
  });
  app.use('*', passwordChangeGate());
  app.all('*', (c) => c.json({ reached: true }, 200));
  return app;
}

function sessionUser(mustChangePassword: boolean): SessionUser {
  return {
    id: 'u1',
    email: 'u@example.com',
    displayName: null,
    isGlobalAdmin: true,
    mustChangePassword,
    sessionId: 's1',
  };
}

describe('passwordChangeGate', () => {
  it('refuses a mid-reset session on a non-allowlisted path with 403 and a code', async () => {
    const res = await appWith(sessionUser(true)).request('/api/v1/projects');
    expect(res.status).toBe(403);
    // The code is the contract plan 059 keys its redirect off. Asserting the
    // status alone would pass against a bare HTTPException, which the global
    // error handler renders WITHOUT a code field.
    expect(await res.json()).toEqual({
      error: 'Password change required',
      code: 'password_change_required',
    });
  });

  it.each([
    '/api/v1/auth/change-password',
    '/api/v1/auth/me',
    '/api/v1/auth/logout',
    '/api/v1/auth/login',
  ])('lets a mid-reset session through on the allowlisted path %s', async (path) => {
    const res = await appWith(sessionUser(true)).request(path);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: true });
  });

  it('does not refuse a session without the flag', async () => {
    const res = await appWith(sessionUser(false)).request('/api/v1/projects');
    expect(res.status).toBe(200);
  });

  it('does not refuse an anonymous request — no cookie, no gate', async () => {
    // The break-glass property: an ADMIN_TOKEN-only caller presents no session
    // cookie, so sessionAuth sets nothing and this branch is what carries them.
    const res = await appWith(null).request('/api/v1/projects');
    expect(res.status).toBe(200);
  });

  it('matches the allowlist on the FULL request path, not a suffix', async () => {
    // Hono reports c.req.path as the whole path even inside a sub-router. A
    // suffix or `endsWith` match would wrongly exempt this decoy.
    const res = await appWith(sessionUser(true)).request('/api/v1/projects/auth/me');
    expect(res.status).toBe(403);
  });

  it('is tagged so the static coverage guard can find it', () => {
    // Every call returns a fresh closure, so the guard cannot identify mounts
    // by reference. Same reason readAuth and resolveAccess are tagged.
    expect(passwordChangeGate().isPasswordChangeGate).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter api exec vitest run src/middleware/password-change.test.ts
```

Expected: FAIL — cannot resolve `./password-change`.

- [ ] **Step 3: Write the middleware**

Create `apps/api/src/middleware/password-change.ts`:

```ts
import { Context, MiddlewareHandler } from 'hono';
import { getSessionUser } from './session';
import { PASSWORD_CHANGE_ALLOWLIST } from '../services/auth/access';

/**
 * Tagged for the same reason readAuth and resolveAccess are
 * (routes-auth-coverage.test.ts:62-77): every call returns a fresh closure, so
 * a static guard cannot identify mounted gates by reference. Removing
 * `isPasswordChangeGate` makes password-change-coverage.test.ts pass over an
 * empty set — the exact failure mode it exists to eliminate.
 */
export interface PasswordChangeGateMiddleware extends MiddlewareHandler {
  isPasswordChangeGate: true;
}

/**
 * Refuse every request from a session holding an unrotated temporary password,
 * except the four paths that let the holder complete the change.
 *
 * MOUNT POINT: `use('*')` inside each router, AFTER that router's rate limiter.
 * NOT `app.use('*')` on the root app. A denial returns without calling next(),
 * so a global mount ahead of the routers would run before every per-router
 * limiter and starve it: a mid-reset session could then send unlimited requests
 * to a non-allowlisted path — each still paying the session lookup in
 * sessionAuth (session.ts:45,49) — and never receive a 429. That is precisely
 * the unthrottled-cookie path plan 056's rate-limiter ruling and its regression
 * test (rate-limit.test.ts:341-361) exist to prevent. A short-circuit is never
 * neutral: everything downstream stops running, including the defences.
 *
 * Returns c.json rather than throwing HTTPException: the global error handler
 * renders exceptions as `c.json({ error: err.message }, err.status)`
 * (index.ts:44-52) and would DROP the `code` field, reproducing Keycloak's
 * opaque `invalid_grant` — the one failure mode this contract exists to avoid.
 */
export function passwordChangeGate(): PasswordChangeGateMiddleware {
  const mw: MiddlewareHandler = async (c: Context, next) => {
    const sessionUser = getSessionUser(c);
    if (!sessionUser?.mustChangePassword) return await next();
    if (PASSWORD_CHANGE_ALLOWLIST.includes(c.req.path)) return await next();

    return c.json(
      { error: 'Password change required', code: 'password_change_required' },
      403
    );
  };

  return Object.assign(mw, { isPasswordChangeGate: true as const });
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter api exec vitest run src/middleware/password-change.test.ts
pnpm --filter api exec tsc --noEmit
```

Expected: PASS, 0 type errors.

- [ ] **Step 5: Prove the tests bite (manual mutation, revert after)**

Do all three, one at a time, confirming a RED run each time, then `git checkout` the file:

1. Change `403` to `404` → the status assertion must fail.
2. Delete the `code` property from the JSON body → the body assertion must fail.
3. Change `PASSWORD_CHANGE_ALLOWLIST.includes(c.req.path)` to `c.req.path.endsWith('/me')` → the decoy test (`/api/v1/projects/auth/me`) must fail.

If any mutation stays green, the test is vacuous — fix the test before continuing.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/middleware/password-change.ts apps/api/src/middleware/password-change.test.ts
git commit -m "feat(api): add the password-change gate middleware"
```

---

## Task 3: Mount the gate and guard the mounts

**Files:**
- Modify: `apps/api/src/routes/reports.ts:63`, `projects.ts:33`, `tests.ts:15`, `admin.ts:27`, `admin-users.ts:22`, `admin-teams.ts:18`, `auth.ts:48`
- Create: `apps/api/src/password-change-coverage.test.ts`

**Interfaces:**
- Consumes: `passwordChangeGate` (Task 2), `PASSWORD_CHANGE_ALLOWLIST` (Task 1).
- Produces: seven `ALL /api/v1/<mount>/*` entries in `app.routes` carrying the `isPasswordChangeGate` tag. Task 4's HTTP tests depend on these mounts existing.

- [ ] **Step 1: Write the failing coverage test**

Create `apps/api/src/password-change-coverage.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import app from './index';
import { PASSWORD_CHANGE_ALLOWLIST } from './services/auth/access';

/**
 * Fail-loud guard: every /api/v1 router mounts passwordChangeGate().
 *
 * Layer 2 is now SEVEN mounts rather than one global one (see the mount-point
 * comment in middleware/password-change.ts for why a global mount is wrong).
 * Seven places to forget is six more than one, so the forgetting is what gets
 * automated away here.
 *
 * This is a RUNTIME scan of Hono's route table, not a source-text scan — so
 * unlike the plan-058 admin-scope guard it needs no `stryMutAct_` skip: Stryker
 * instruments the source, but app.routes still reports the same paths.
 *
 * Verified mechanism: a router's `use('*', mw)` registration surfaces in
 * app.routes as an `ALL /api/v1/<mount>/*` entry.
 */

// The complete set of app.route('/api/v1/...') mounts in index.ts:143-152.
// Adding a router without adding it here fails the count assertion below;
// adding it here without mounting the gate fails the per-mount assertion.
const EXPECTED_GATE_MOUNTS = [
  '/api/v1/reports/*',
  '/api/v1/projects/*',
  '/api/v1/tests/*',
  '/api/v1/admin/users/*',
  '/api/v1/admin/teams/*',
  '/api/v1/admin/*',
  '/api/v1/auth/*',
];

function isGateHandler(handler: unknown): boolean {
  return (
    typeof handler === 'function' &&
    (handler as { isPasswordChangeGate?: boolean }).isPasswordChangeGate === true
  );
}

const gatePaths = new Set(app.routes.filter((r) => isGateHandler(r.handler)).map((r) => r.path));

// Terminal route registrations under /api/v1/auth — the `ALL` entries are
// middleware layers (apiRateLimit, authRateLimit, the gate), not routes.
const authRoutePaths = [
  ...new Set(
    app.routes.filter((r) => r.path.startsWith('/api/v1/auth/') && r.method !== 'ALL').map((r) => r.path)
  ),
].sort();

describe('password-change gate coverage', () => {
  beforeAll(() => {
    // Anti-vacuity, both directions. Without these, a refactor that changes how
    // Hono exposes routes leaves this file green while asserting nothing.
    if (app.routes.length === 0) {
      throw new Error(
        'app.routes is empty — the route table could not be read. This guard ' +
          'would pass vacuously. Fix this test, do not delete it.'
      );
    }
    if (gatePaths.size === 0) {
      throw new Error(
        'No passwordChangeGate mounts found at all. Either every router lost its ' +
          'mount, or the isPasswordChangeGate tag was removed from the middleware ' +
          '— in which case this guard can no longer see any mount and must be fixed.'
      );
    }
  });

  it.each(EXPECTED_GATE_MOUNTS)('mounts passwordChangeGate on %s', (path) => {
    expect(
      gatePaths.has(path),
      `${path} has no passwordChangeGate mounted. Add\n` +
        `  <router>.use('*', passwordChangeGate())\n` +
        `immediately AFTER that router's rate limiter — never before it, and never\n` +
        `as a global app.use(), which starves every per-router limiter.\n\n` +
        `Without it, a session holding an unrotated temporary password keeps full\n` +
        `authority on every route this router serves.`
    ).toBe(true);
  });

  it('has no gate mount this list does not know about', () => {
    // The other direction: a new router that DID mount the gate but was never
    // added to EXPECTED_GATE_MOUNTS. Not a security hole, but it means the list
    // has drifted from reality and the guard above is no longer complete.
    expect([...gatePaths].sort()).toEqual([...EXPECTED_GATE_MOUNTS].sort());
  });

  it('the allowlist matches the auth router route table exactly', () => {
    // A new /api/v1/auth/* route is a deliberate decision: either it is part of
    // password recovery (add it to PASSWORD_CHANGE_ALLOWLIST) or it is not
    // (leave it out and it is correctly refused). Silence is the one outcome
    // this forbids.
    expect(authRoutePaths).toEqual([...PASSWORD_CHANGE_ALLOWLIST].sort());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter api exec vitest run src/password-change-coverage.test.ts
```

Expected: FAIL — the `beforeAll` throws `No passwordChangeGate mounts found at all`.

- [ ] **Step 3: Mount the gate on all seven routers**

Each router: add the import, then one `use('*')` line **immediately after the rate limiter registration(s)** shown.

`apps/api/src/routes/reports.ts` — after line 63 (`reports.use('*', reportRateLimit);`):
```ts
reports.use('*', passwordChangeGate());
```

`apps/api/src/routes/projects.ts` — after line 33 (`projectsRouter.use('*', apiRateLimit);`):
```ts
projectsRouter.use('*', passwordChangeGate());
```

`apps/api/src/routes/tests.ts` — after line 15 (`testsRouter.use('*', apiRateLimit);`):
```ts
testsRouter.use('*', passwordChangeGate());
```

`apps/api/src/routes/admin.ts` — between line 27 (`adminRouter.use('*', adminRateLimit);`) and line 28 (`adminRouter.use('*', adminOrGlobalAdminAuth());`):
```ts
// Ahead of adminOrGlobalAdminAuth on purpose: that gate 403s a refused caller
// as `HTTPException(403, 'Admin access required')`, which carries no `code` and
// names the wrong reason. Running first is what makes the admin surface emit
// the same contract as reads and writes.
adminRouter.use('*', passwordChangeGate());
```

`apps/api/src/routes/admin-users.ts` — between line 22 (`adminUsersRouter.use('*', adminRateLimit);`) and line 23:
```ts
adminUsersRouter.use('*', passwordChangeGate());
```

`apps/api/src/routes/admin-teams.ts` — between line 18 (`adminTeamsRouter.use('*', adminRateLimit);`) and line 19:
```ts
adminTeamsRouter.use('*', passwordChangeGate());
```

`apps/api/src/routes/auth.ts` — after line 48 (`authRouter.use('/change-password', authRateLimit);`):
```ts
// All four current auth routes are allowlisted, so this mount changes nothing
// today. That is the point: it is what makes a FUTURE auth route refused by
// default rather than silently exempt.
authRouter.use('*', passwordChangeGate());
```

Import line for each file:
```ts
import { passwordChangeGate } from '../middleware/password-change';
```

- [ ] **Step 4: Run the coverage guard and the pre-existing one**

```bash
pnpm --filter api exec vitest run src/password-change-coverage.test.ts src/routes-auth-coverage.test.ts
```

Expected: both PASS. The second matters: `routes-auth-coverage.test.ts` counts GET routes under `/api/v1`, and the new entries are `ALL`, so `EXPECTED_READ_ROUTE_COUNT` must **not** need changing. If it does, stop — something was mounted with the wrong method.

- [ ] **Step 5: Prove the guard bites (manual mutation, revert after)**

Comment out the mount in `apps/api/src/routes/tests.ts`, re-run the coverage guard, confirm it fails naming `/api/v1/tests/*`, then restore it.

- [ ] **Step 6: Run the full API suite**

```bash
pnpm --filter api exec vitest run
pnpm --filter api exec tsc --noEmit
```

Expected: PASS. Any route-suite failure here means a mount landed in the wrong position — investigate before committing.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes apps/api/src/password-change-coverage.test.ts
git commit -m "feat(api): mount the password-change gate on every v1 router"
```

---

## Task 4: HTTP proof — lockout safety and contract uniformity

**Files:**
- Create: `apps/api/src/routes/password-change-enforcement.test.ts`

**Interfaces:**
- Consumes: the mounts from Task 3, the gate from Task 2, the predicates from Task 1.
- Produces: `provisionMustChangeUser()` and `loginAs()` helpers used again by Task 5 in the same file.

**Environment:** this suite needs Postgres and `ADMIN_TOKEN`.

```bash
docker compose up -d postgres && pnpm db:migrate
export DATABASE_URL='postgresql://flackyness:'"$DB_PASSWORD"'@localhost:5433/flackyness'
export ADMIN_TOKEN='<value from .env>'
```

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/password-change-enforcement.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, users, teams } from '../db';
import { SESSION_COOKIE } from '../services/auth/session';
import type { Hono } from 'hono';

const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeEnforcement = hasDatabase && hasAdminToken ? describe : describe.skip;

let app: Hono;
beforeAll(async () => {
  if (hasDatabase) app = (await import('../index')).default;
});

const adminHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
});

describeEnforcement('mustChangePassword enforcement', () => {
  let seq = 0;

  /**
   * Provision a mid-reset user who is `team_admin` of a fresh team of their own.
   *
   * TWO deliberate choices here, both load-bearing:
   *
   * 1. NOT a global admin. `admin-users.test.ts` mutates "who is a global
   *    admin" ambiently across the whole table and serialises itself on
   *    GLOBAL_ADMIN_LOCK_KEY (test-support/advisory-lock.ts) precisely because
   *    that state is shared across test FILES, which vitest runs in separate
   *    processes. Minting global admins here would race it — flaky tests, in a
   *    flaky-test tracker's own suite.
   *
   * 2. `team_admin`, not a plain member. It is the account that WOULD be
   *    allowed on every surface below, so a refusal can only come from the
   *    flag — a plain member would be refused anyway and the tests would prove
   *    nothing. It also exercises canEnterAdminApi's SECOND branch, which is
   *    the one a half-fix (guarding only canAdministerTeams) leaves open.
   */
  interface Fixture {
    id: string;
    teamId: string;
    email: string;
    password: string;
  }

  async function provisionMustChangeUser(): Promise<Fixture> {
    const stamp = `${Date.now()}-${seq++}`;

    const teamRes = await app.request('/api/v1/admin/teams', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ name: `must-change-team-${stamp}` }),
    });
    expect(teamRes.status, 'creating the fixture team must succeed').toBe(201);
    const teamId = (await teamRes.json()).team.id;

    const email = `must-change-${stamp}@example.com`;
    const userRes = await app.request('/api/v1/admin/users', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ email }),
    });
    expect(userRes.status, 'provisioning the fixture user must succeed').toBe(201);
    const body = await userRes.json();
    expect(body.user.mustChangePassword, 'a provisioned user starts mid-reset').toBe(true);

    const memberRes = await app.request(`/api/v1/admin/teams/${teamId}/members`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ userId: body.user.id, role: 'team_admin' }),
    });
    expect(memberRes.status, 'the fixture user must end up a team_admin').toBe(201);

    return { id: body.user.id, teamId, email, password: body.temporaryPassword };
  }

  /** Both rows, every time. Leaked teams accumulate across runs and make the
   *  `admin/teams` list route's own tests progressively slower and noisier. */
  async function cleanup(f: Fixture): Promise<void> {
    await db.delete(users).where(eq(users.id, f.id));
    await db.delete(teams).where(eq(teams.id, f.teamId));
  }

  async function loginAs(email: string, password: string): Promise<string> {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status, 'login must succeed even while mid-reset').toBe(200);
    const cookie = (res.headers.get('set-cookie') ?? '')
      .match(new RegExp(`${SESSION_COOKIE}=([^;]*)`))?.[1];
    // Asserted, not `!`-asserted: a bare non-null assertion is a TYPE claim
    // only. Without this, a login that stopped issuing cookies would send
    // `fk_session=undefined`, every request below would be anonymous, and the
    // 403 assertions would silently be testing nothing.
    expect(cookie, 'login must issue a session cookie').toBeDefined();
    return cookie!;
  }

  const withCookie = (cookie: string) => ({
    Cookie: `${SESSION_COOKIE}=${cookie}`,
    'Content-Type': 'application/json',
  });

  /**
   * THE LOCKOUT TEST — the most important test in this feature.
   *
   * Getting this wrong bricks every provisioned account with no recovery short
   * of hand-written SQL. Each route gets its own session because logout and
   * change-password both invalidate the one they are given.
   */
  describe('the four allowlisted routes still work while mid-reset', () => {
    it('GET /api/v1/auth/me returns the caller, flag included', async () => {
      const u = await provisionMustChangeUser();
      const res = await app.request('/api/v1/auth/me', {
        headers: withCookie(await loginAs(u.email, u.password)),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // The dashboard needs this field to know to redirect. A 200 that omits
      // it is a passing test and a broken feature.
      expect(body.user.mustChangePassword).toBe(true);
      await cleanup(u);
    });

    it('POST /api/v1/auth/logout ends the session', async () => {
      const u = await provisionMustChangeUser();
      const res = await app.request('/api/v1/auth/logout', {
        method: 'POST',
        headers: withCookie(await loginAs(u.email, u.password)),
      });
      expect(res.status).toBe(200);
      await cleanup(u);
    });

    it('POST /api/v1/auth/login works — proven by loginAs itself asserting 200', async () => {
      const u = await provisionMustChangeUser();
      await loginAs(u.email, u.password);
      await cleanup(u);
    });

    it('POST /api/v1/auth/change-password completes the remedy and clears the flag', async () => {
      const u = await provisionMustChangeUser();
      const res = await app.request('/api/v1/auth/change-password', {
        method: 'POST',
        headers: withCookie(await loginAs(u.email, u.password)),
        body: JSON.stringify({ currentPassword: u.password, newPassword: 'a-perfectly-fine-new-password' }),
      });
      expect(res.status).toBe(200);

      const [row] = await db.select({ f: users.mustChangePassword }).from(users).where(eq(users.id, u.id));
      expect(row.f, 'the remedy must actually clear the flag').toBe(false);

      // And the account is usable again — the escape hatch really opens. This
      // is the assertion that would catch a change-password that cleared the
      // DB flag but left the caller holding a session still resolving to the
      // old value. (It does not: auth.ts:255-260 revokes every session and
      // issues a fresh one in the same response.)
      const after = await loginAs(u.email, 'a-perfectly-fine-new-password');
      const me = await app.request('/api/v1/admin/projects', { headers: withCookie(after) });
      expect(me.status, 'a rotated password restores full authority').toBe(200);

      await cleanup(u);
    });
  });

  /**
   * CONTRACT UNIFORMITY — the regression test for the defect the spec review
   * found. Without the gate, these surfaces answer a mid-reset team_admin
   * three DIFFERENT ways: 200-with-an-empty-list (the project list filters
   * rather than refuses), 404 (tests.ts checks readability first, and layer 1
   * routes into plan 058's existence-hiding path), and a code-less 403
   * ("Admin access required"). All must now be the same 403 with the same code.
   *
   * Every assertion below compares the whole BODY, not just the status. Status
   * alone is too weak here: two of these surfaces already 403 for unrelated
   * reasons, so `expect(res.status).toBe(403)` would pass against a completely
   * unmounted gate.
   */
  describe('every refused surface emits the same contract', () => {
    const REFUSED_403 = { error: 'Password change required', code: 'password_change_required' };

    it('read: GET /api/v1/projects — refused, not merely filtered to empty', async () => {
      const u = await provisionMustChangeUser();
      const res = await app.request('/api/v1/projects', {
        headers: withCookie(await loginAs(u.email, u.password)),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(REFUSED_403);
      await cleanup(u);
    });

    it('write: PATCH /api/v1/tests/flaky/:id', async () => {
      const u = await provisionMustChangeUser();
      // A nonexistent id on purpose: the gate must fire BEFORE the row lookup.
      // If it ran after, this would 404 and the test would red — which is
      // exactly the ordering guarantee worth pinning.
      const res = await app.request('/api/v1/tests/flaky/00000000-0000-4000-8000-000000000000', {
        method: 'PATCH',
        headers: withCookie(await loginAs(u.email, u.password)),
        body: JSON.stringify({ status: 'ignored' }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(REFUSED_403);
      await cleanup(u);
    });

    it('admin API: GET /api/v1/admin/projects', async () => {
      const u = await provisionMustChangeUser();
      const res = await app.request('/api/v1/admin/projects', {
        headers: withCookie(await loginAs(u.email, u.password)),
      });
      expect(res.status).toBe(403);
      // Not just "a 403". `Admin access required` is also a 403 and would be
      // WRONG here — it names the wrong reason and carries no code.
      expect(await res.json()).toEqual(REFUSED_403);
      await cleanup(u);
    });

    it('admin user CRUD: GET /api/v1/admin/users — a SEPARATE router mount', async () => {
      // adminUsersRouter is mounted independently of adminRouter and carries
      // its own use('*') stack, so the case above does not cover it.
      //
      // Be explicit about what this does and does not prove: a team_admin is
      // refused here anyway (canAdministerTeams is global-admin only), so the
      // STATUS proves nothing. The body is the whole assertion — without the
      // gate this returns `{ error: 'Team administration requires a global
      // admin' }` or similar, never a `code`.
      const u = await provisionMustChangeUser();
      const res = await app.request('/api/v1/admin/users', {
        headers: withCookie(await loginAs(u.email, u.password)),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(REFUSED_403);
      await cleanup(u);
    });
  });
});
```

- [ ] **Step 2: Run it**

```bash
pnpm --filter api exec vitest run src/routes/password-change-enforcement.test.ts
```

Expected: PASS (Tasks 1-3 already implement the behaviour). If any test fails, the failure is real — fix the implementation, not the test.

If the whole suite **skips**, `DATABASE_URL` or `ADMIN_TOKEN` is unset. A skipped suite is not a passing suite; export both and re-run before continuing.

- [ ] **Step 3: Prove the suite bites (manual mutation, revert after)**

Comment out the mount in `apps/api/src/routes/admin.ts`, re-run. Expected: `GET /api/v1/admin/projects` fails with `403 'Admin access required'` — no `code`. That failure is the whole point of the task; restore the mount and confirm green.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/password-change-enforcement.test.ts
git commit -m "test(api): prove lockout safety and a uniform refusal contract"
```

---

## Task 5: HTTP proof — non-regression, layer 1 alone, rate limiting

**Files:**
- Modify: `apps/api/src/routes/password-change-enforcement.test.ts`

**Interfaces:**
- Consumes: `provisionMustChangeUser()`, `loginAs()`, `adminHeaders()` from Task 4 — same file, same `describeEnforcement` block.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Append inside the `describeEnforcement` block, after the contract-uniformity describe:

```ts
  /**
   * The zero-behaviour-change promise. An install with no user accounts must
   * not notice this feature at all.
   */
  describe('machine credentials presenting no session cookie are unaffected', () => {
    it('ADMIN_TOKEN still reaches the admin API', async () => {
      const res = await app.request('/api/v1/admin/projects', { headers: adminHeaders() });
      expect(res.status).toBe(200);
    });

    it('a mid-reset user existing on the instance does not affect a token caller', async () => {
      // The flag lives on a row, not on the request. This pins that the gate
      // reads the CALLER's session and nothing else.
      const u = await provisionMustChangeUser();
      const res = await app.request('/api/v1/admin/projects', { headers: adminHeaders() });
      expect(res.status).toBe(200);
      await cleanup(u);
    });
  });

  it('a mid-reset cookie sent ALONGSIDE a valid ADMIN_TOKEN is still refused', async () => {
    // Session outranks bearer (middleware/access.ts:50-70), a deliberate plan
    // 058 decision this feature does not reverse. Documented here as intended
    // behaviour so plan 059 does not discover it as a surprise: the dashboard
    // holds ADMIN_TOKEN server-side and will gain a session cookie.
    const u = await provisionMustChangeUser();
    const cookie = await loginAs(u.email, u.password);
    const res = await app.request('/api/v1/admin/projects', {
      headers: { ...adminHeaders(), Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('password_change_required');
    await cleanup(u);
  });

  it('layer 1 alone still refuses when the gate is mocked out', async () => {
    // Each layer must be proven to bite ALONE, or redundancy masks breakage:
    // the gate always fires first, so layer 1 could be entirely broken and
    // every other test in this file would still pass.
    //
    // Only THIS direction needs its own test. The reverse — "layer 2 alone
    // bites" — is what every test above already proves, because layer 1 is
    // never reached while the gate is mounted.
    //
    // The surface is the admin API on purpose. A read would be a bad choice:
    // GET /api/v1/projects is a LIST route, so layer 1 refusing yields an empty
    // 200, not a refusal — a test asserting 404 there would fail for the wrong
    // reason, and one asserting "not 200" would pass with both layers broken.
    // canEnterAdminApi, by contrast, is a clean permit/deny.
    //
    // Note the contract differs by design: this is `403 Admin access required`
    // with NO code — layer 1 refuses, layer 2 owns the contract. Asserting the
    // exact body is what proves the mock really took effect rather than the
    // real gate having answered.
    const u = await provisionMustChangeUser();
    const cookie = await loginAs(u.email, u.password);

    vi.resetModules();
    vi.doMock('../middleware/password-change', () => ({
      passwordChangeGate: () =>
        Object.assign(async (_c: unknown, next: () => Promise<void>) => await next(), {
          isPasswordChangeGate: true as const,
        }),
    }));
    try {
      const { Hono } = await import('hono');
      const { sessionAuth } = await import('../middleware/session');
      const { default: adminRouter } = await import('./admin');

      const ungated = new Hono();
      ungated.use('*', sessionAuth());
      ungated.route('/api/v1/admin', adminRouter);

      const res = await ungated.request('/api/v1/admin/projects', {
        headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
      });
      expect(res.status, 'with the gate neutralised, layer 1 must still refuse').toBe(403);
      expect(await res.json()).toEqual({ error: 'Admin access required' });
    } finally {
      vi.doUnmock('../middleware/password-change');
      vi.resetModules();
      await cleanup(u);
    }
  });

  it('a refused mid-reset caller is still rate-limited', async () => {
    // The regression test for the mount-order defect. Mounting the gate
    // globally (app.use('*')) rather than per-router runs it before every
    // limiter; because a denial returns without next(), the limiter never
    // counts the request and this test never sees a 429 — an unthrottled path
    // that still pays a session DB lookup per request. Same hazard, same
    // shape, as rate-limit.test.ts:341-361, which is also where this idiom
    // (resetModules, enable the flag, build a MINIMAL app) comes from.
    //
    // Provision and log in FIRST, on the outer app: the limiter is a module
    // singleton, and doing this after enabling it would spend real slots.
    const u = await provisionMustChangeUser();
    const cookie = await loginAs(u.email, u.password);

    vi.resetModules();
    const { __setRateLimitEnabled, API_RATE_LIMIT } = await import('../middleware/rate-limit');
    __setRateLimitEnabled(true);
    try {
      const { Hono } = await import('hono');
      const { sessionAuth } = await import('../middleware/session');
      const { default: projectsRouter } = await import('./projects');

      const limited = new Hono();
      limited.use('*', sessionAuth());
      limited.route('/api/v1/projects', projectsRouter);

      const codes: number[] = [];
      for (let i = 0; i < API_RATE_LIMIT.limit + 3; i++) {
        const res = await limited.request('/api/v1/projects', {
          headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
        });
        codes.push(res.status);
      }
      expect(codes).toContain(429);
      // Sanity: the early requests really did reach the gate, proving the 429s
      // came from exhausting the limiter rather than from everything being
      // rejected outright — the assertion that fails under the global mount.
      expect(codes[0]).toBe(403);
    } finally {
      __setRateLimitEnabled(false);
      vi.resetModules();
      await cleanup(u);
    }
  });
```

Add `vi` to the vitest import at the top of the file: `import { describe, it, expect, beforeAll, vi } from 'vitest';`

- [ ] **Step 2: Run it**

```bash
pnpm --filter api exec vitest run src/routes/password-change-enforcement.test.ts
```

Expected: PASS.

Two failures here are informative rather than fatal, and must be resolved rather than worked around:
- If the layer-1 test returns **403** instead of 404, the mock did not take effect (module resolution / import order). Fix the mock — do not relax the assertion to `not.toBe(200)`, which would pass even with both layers broken.
- If the rate-limit test's `codes[0]` is 429, the limiter is shared module state polluted by an earlier test. `vi.resetModules()` before importing is what isolates it.

- [ ] **Step 3: Run the whole API suite with the database up**

```bash
pnpm --filter api exec vitest run
pnpm --filter api exec tsc --noEmit
pnpm lint
```

Expected: all PASS, 0 type errors, 0 lint errors. Confirm the route suites **ran** rather than skipped — a skip here would hide exactly the regressions this task exists to catch.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/password-change-enforcement.test.ts
git commit -m "test(api): prove non-regression, layer isolation and throttling"
```

---

## Task 6: Documentation

**Files:**
- Modify: `docs/API.md`
- Modify: `AGENTS.md`, `.agent/CONTEXT.md`
- Modify: `plans/README.md`

**Interfaces:**
- Consumes: the finished behaviour from Tasks 1-5.
- Produces: nothing code depends on.

- [ ] **Step 1: Document the error contract in `docs/API.md`**

Two edits, both in `## Error Responses` (line 2203).

First, the section opens with *"All errors follow this format: `{ "error": ... }`"*, which this feature makes false. Qualify it — the `403` below adds a `code`. Then note the `Common Status Codes` table (line 2214) has **no `403` row at all**, even though plan 058 shipped several; add one:

```markdown
| `403` | Forbidden - identified, but not permitted (see `code` where present) |
```

Second, add this subsection under `## Error Responses`, after `### Common Status Codes`:

````markdown
### Password change required

A session belonging to a user whose password was admin-provisioned or
admin-reset, and not yet rotated, is refused on every endpoint except the four
recovery paths below:

```
403 { "error": "Password change required", "code": "password_change_required" }
```

Key off `code`, never the message text. The four paths that remain available are
`POST /api/v1/auth/login`, `POST /api/v1/auth/change-password`,
`GET /api/v1/auth/me` and `POST /api/v1/auth/logout` — enough to complete the
change and to leave the session.

This applies to **session** callers only. `ADMIN_TOKEN`, `READ_TOKEN` and
project tokens never carry the flag and are unaffected. A request presenting
both a mid-reset session cookie *and* a bearer token is refused: the session is
the more specific credential and outranks the token.
````

- [ ] **Step 2: Add the sharp edge to `AGENTS.md` and `.agent/CONTEXT.md`**

Add to the "Sharp edges" list in both files (`.agent/CONTEXT.md` is the deeper version — expand there if it carries more detail per entry):

```markdown
- **`mustChangePassword` is enforced in TWO places, and the gate's mount
  position is load-bearing.** `passwordChangeGate()`
  (`middleware/password-change.ts`) is mounted `use('*')` inside **each** of the
  seven `/api/v1` routers, immediately **after** that router's rate limiter —
  never as a global `app.use()`. A denial returns without `next()`, so a global
  mount would run ahead of every per-router limiter and starve it: a mid-reset
  session could then hammer any path unthrottled, each request still paying the
  session DB lookup. Guarded by `password-change-coverage.test.ts` (seven
  mounts, plus the allowlist matching the auth route table) and by a 429
  regression test. The gate must `return c.json(...)`, **not** throw
  `HTTPException` — the global error handler drops the `code` field, which is
  the one thing plan 059's redirect keys off. Layer 1 (short-circuits in
  `services/auth/access.ts`'s four predicates) is the backstop for a router
  that never mounts the gate; it refuses with a 404 via existence-hiding, which
  is why the gate — not the predicates — owns the error contract.
```

- [ ] **Step 3: Update `plans/README.md`**

Add a row to the `## Execution order & status` table (line 16 onward) **between the 058 row (line 304) and the 059 row (line 305)** — this work ships before 059 so the dashboard builds against a settled contract:

```markdown
| 058b | `mustChangePassword` enforcement: `Access.mustChangePassword` + four predicate short-circuits (layer 1), `passwordChangeGate()` mounted per-router after each rate limiter with a four-path recovery allowlist (layer 2), uniform `403 password_change_required`. Settles the decision plan 058 deferred | P2 | S–M | **058 (hard)** | DONE (see `docs/superpowers/specs/2026-08-14-must-change-password-enforcement-design.md`) |
```

Fill in the real PR number and squash SHA once merged, matching the format the other DONE rows use.

Then amend the 059 row's status cell to note the contract it depends on is now settled: `TODO — last of the A–D chain; the mustChangePassword contract it consumes is settled by 058b`.

Leave follow-up **#24 open** (the reset-delivery atomicity hole) — deliberately out of scope, and the spec's "Out of scope" section says so explicitly. Do not silently close it.

Follow-up **#20** is adjacent and worth reading before this task: it notes `access.ts` had four surviving mutants at floor 90. This plan adds four new branches to that same file — if the nightly `Mutation` run drops below floor, #20's two named gaps are the cheapest place to look first.

- [ ] **Step 4: Verify the docs match the code**

Re-read the `docs/API.md` block against `middleware/password-change.ts` and `PASSWORD_CHANGE_ALLOWLIST`. Every path, the exact `error` string and the exact `code` must match character for character. Three separate false claims in `docs/API.md` were found and fixed during plan 058's review; do not add a fourth.

- [ ] **Step 5: Commit**

```bash
git add docs/API.md AGENTS.md .agent/CONTEXT.md plans/README.md
git commit -m "docs(api): document the password-change enforcement boundary"
```

---

## Final verification

- [ ] **Full suite, database up, both env vars exported**

```bash
pnpm --filter api exec vitest run
pnpm --filter api exec tsc --noEmit
pnpm lint
pnpm build
```

All green, and the route suites must have **run**, not skipped.

- [ ] **Dashboard untouched**

```bash
pnpm --filter dashboard check
```

Expected: 0 errors. If it reports `TS2790` errors on `delete privateEnv.X`, that is the known `svelte-check` environment trap — `svelte-kit sync` generates `$env/dynamic/private` types from the ambient shell, so an **exported** `ADMIN_TOKEN` makes the property required. Unset the exports in a fresh shell and re-run; it is not a regression from this work.

- [ ] **Mutation gate**

Do **not** run Stryker locally. `access.ts` is in the hardened set at floor 90 and this plan adds branches to it; the nightly `Mutation` workflow is the check. If it drops below floor, the fix is a sharper assertion, never a lowered floor.

- [ ] **Push, PR, merge on green**

```bash
git push -u origin feat/must-change-password-enforcement
gh pr create --base main --title "feat(api): enforce mustChangePassword as an authorization boundary"
```

The PR body should state what enforcement buys (it converts silent standing access on a leaked temp password into loud account theft), the mount-position constraint, and that the reset-delivery atomicity hole (follow-up #24) is knowingly out of scope.
