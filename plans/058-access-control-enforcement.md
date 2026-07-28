# Per-Team Access Control Enforcement (Phase C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn on per-team access control — a signed-in member sees only their teams' projects, a `team_admin` can manage only their teams' projects, and a global admin sees everything — enforced by one central middleware rather than fifteen hand-written predicates, with a CI guard that fails when a new read route skips it.

**Architecture:** A pure `services/auth/access.ts` holds the entire decision table as branch-complete, DB-free functions (`canReadProject`, `canWriteProject`), so every rule is mutation-provable without a database. A `resolveAccess(resolver?)` middleware classifies the caller into an `Access` value, and — when handed a project resolver — performs the scope check itself and `404`s, exactly mirroring the shape of `readAuth`. `routes-auth-coverage.test.ts` is extended to demand both middlewares on every read route.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL, zod, Vitest, Stryker.

**Spec:** `docs/superpowers/specs/2026-07-25-teams-identity-access-control-design.md` (Phase C)

## Global Constraints

Every task's requirements implicitly include this section.

- **Depends hard on plans 056 and 057.** `users`, `sessions`, `teams`, `team_members` and `projects.team_id` must all exist, and the Default-team backfill must have run. This plan mints **no migration**.
- **THE BACKWARD-COMPATIBILITY SEAM — read this before writing any code.** An **anonymous** caller keeps today's behavior: unscoped. Teams scope *identified* callers; they do **not** convert an open deployment into a closed one. Concretely: `readAuth` already decides *whether you may read at all* (it 401s everyone when `READ_TOKEN` is set, and waves everyone through when it is not — plan 041 decision D1, which is a deliberate product posture, not an oversight). `resolveAccess` then decides *which projects*. Composing them means an anonymous caller only exists on a deployment whose operator chose to leave reads open, and on that deployment they see everything, as they do today. **Do not "fix" this by denying anonymous callers** — that silently breaks every existing install on upgrade and re-litigates a settled decision. It is asserted by a test in Task 3 and must stay asserted.
- **Existence-hiding on reads, explicit refusal on writes.** A read for a project outside the caller's teams returns **`404`**, never `403` — consistent with the confused-deputy-safe join pattern already in `projects.ts`. A *mutation* the caller's role forbids on a project they *can* see returns **`403`**. The distinction is deliberate: `404` hides that a resource exists; `403` tells someone who legitimately sees a project that they lack the rank to change it.
- **Machine credentials are unchanged.** Per-project ingest tokens, `ADMIN_TOKEN` and `READ_TOKEN` authenticate exactly as they do today and map onto the existing scopes (`project-token` → that one project; `read-token` → global machine read; `admin-token` → global admin). `POST /api/v1/reports` is not touched.
- **Orphaned projects (`team_id IS NULL`) are visible to global admins only.** They are a legal state produced by team deletion (plan 057); no ordinary user should inherit them by accident.
- **`buildGrepInvert()` and base flakiness measurement are untouched.** Access control gates *who can read what*; it does not change what is measured or what the CI quarantine list contains.
- **Structured logger only**; zod-validate every input; Drizzle query builder only.
- **Commits:** single-line conventional-commit subject; **no `Co-Authored-By` trailers**; never `--no-verify`.

## File Structure

**Create:**
- `apps/api/src/services/auth/access.ts` — the `Access` type + the pure decision functions.
- `apps/api/src/services/auth/access.test.ts` — node unit tests (the full decision matrix).
- `apps/api/src/middleware/access.ts` — `resolveAccess()` middleware + `getAccess()`.
- `apps/api/src/routes/access-scope.test.ts` — the cross-team read/write matrix against a real database.

**Modify:**
- `apps/api/src/index.ts` — mount `sessionAuth()` globally (before the routers).
- `apps/api/src/routes/projects.ts` — `resolveAccess` on all 7 reads; filter `GET /`.
- `apps/api/src/routes/tests.ts` — `resolveAccess` on the 3 reads; role check on `PATCH /flaky/:id`.
- `apps/api/src/routes/admin.ts` — accept a global-admin session; scope to `team_admin`'s teams.
- `apps/api/src/routes/admin-teams.ts`, `admin-users.ts` — accept a global-admin session (global-admin only).
- `apps/api/src/middleware/auth.ts` — extract the shared "is this an admin-token request?" helper.
- `apps/api/src/routes-auth-coverage.test.ts` — demand `resolveAccess` too.
- `scripts/mutation-gate.mjs` — floor for `access.ts`.
- `docs/API.md` — the authorization model.
- `plans/README.md` — plan-058 row.

---

### Task 1: the access decision table (pure)

**Files:**
- Create: `apps/api/src/services/auth/access.ts`
- Test: `apps/api/src/services/auth/access.test.ts`

**Interfaces:**
- Consumes: `TeamRole` from `services/auth/membership.ts` (plan 057).
- Produces:

```ts
export type AccessKind = 'user' | 'project-token' | 'read-token' | 'admin-token' | 'anonymous';

export interface Access {
  kind: AccessKind;
  userId: string | null;
  isGlobalAdmin: boolean;
  teamIds: string[];
  roleByTeam: Record<string, TeamRole>;
  /** Set only for kind === 'project-token': the one project it may touch. */
  projectId: string | null;
}

export interface ScopedProject { id: string; teamId: string | null }

export function anonymousAccess(): Access;
export function canReadProject(access: Access, project: ScopedProject): boolean;
export function canWriteProject(access: Access, project: ScopedProject): boolean;
export function canAdministerTeams(access: Access): boolean;
export function scopesProjectList(access: Access): boolean;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/auth/access.test.ts`. This is the file that has to be exhaustive — every later task leans on it.

```ts
import { describe, it, expect } from 'vitest';
import {
  anonymousAccess,
  canReadProject,
  canWriteProject,
  canAdministerTeams,
  scopesProjectList,
  type Access,
  type ScopedProject,
} from './access';

const TEAM_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TEAM_B = 'bbbbbbbb-0000-0000-0000-000000000002';

const projectInA: ScopedProject = { id: 'p-a', teamId: TEAM_A };
const projectInB: ScopedProject = { id: 'p-b', teamId: TEAM_B };
const orphan: ScopedProject = { id: 'p-orphan', teamId: null };

const base: Access = {
  kind: 'anonymous',
  userId: null,
  isGlobalAdmin: false,
  teamIds: [],
  roleByTeam: {},
  projectId: null,
};

const member = (teams: Record<string, 'team_admin' | 'member'>): Access => ({
  ...base,
  kind: 'user',
  userId: 'u1',
  teamIds: Object.keys(teams),
  roleByTeam: teams,
});

const globalAdminUser: Access = { ...member({}), isGlobalAdmin: true };
const adminToken: Access = { ...base, kind: 'admin-token', isGlobalAdmin: true };
const readToken: Access = { ...base, kind: 'read-token' };
const projectToken = (id: string): Access => ({ ...base, kind: 'project-token', projectId: id });

describe('anonymousAccess', () => {
  it('is unprivileged and un-teamed', () => {
    const a = anonymousAccess();
    expect(a.kind).toBe('anonymous');
    expect(a.isGlobalAdmin).toBe(false);
    expect(a.teamIds).toEqual([]);
    expect(a.userId).toBeNull();
  });
});

describe('canReadProject — user', () => {
  it('allows a project in one of their teams', () => {
    expect(canReadProject(member({ [TEAM_A]: 'member' }), projectInA)).toBe(true);
  });

  it('DENIES a project in another team — this is the whole feature', () => {
    expect(canReadProject(member({ [TEAM_A]: 'member' }), projectInB)).toBe(false);
  });

  it('allows a project in ANY of their teams (multi-team membership)', () => {
    const multi = member({ [TEAM_A]: 'member', [TEAM_B]: 'team_admin' });
    expect(canReadProject(multi, projectInA)).toBe(true);
    expect(canReadProject(multi, projectInB)).toBe(true);
  });

  it('denies an orphaned project — a team deletion must not hand it to everyone', () => {
    expect(canReadProject(member({ [TEAM_A]: 'member' }), orphan)).toBe(false);
  });

  it('denies everything for a user in no teams', () => {
    expect(canReadProject(member({}), projectInA)).toBe(false);
    expect(canReadProject(member({}), orphan)).toBe(false);
  });

  it('team_admin can read, same as member', () => {
    expect(canReadProject(member({ [TEAM_A]: 'team_admin' }), projectInA)).toBe(true);
  });
});

describe('canReadProject — global admin', () => {
  it.each([
    ['global-admin user', globalAdminUser],
    ['ADMIN_TOKEN', adminToken],
  ])('%s reads any project, including orphans', (_label, access) => {
    expect(canReadProject(access, projectInA)).toBe(true);
    expect(canReadProject(access, projectInB)).toBe(true);
    expect(canReadProject(access, orphan)).toBe(true);
  });
});

describe('canReadProject — machine tokens', () => {
  it('READ_TOKEN is a global machine read (unchanged from plan 041)', () => {
    expect(canReadProject(readToken, projectInA)).toBe(true);
    expect(canReadProject(readToken, orphan)).toBe(true);
  });

  it('a project token reads only its own project', () => {
    expect(canReadProject(projectToken('p-a'), projectInA)).toBe(true);
    expect(canReadProject(projectToken('p-a'), projectInB)).toBe(false);
  });

  it('a project token is not widened by the project\'s team', () => {
    // Both projects are in TEAM_A, but the token names only one of them.
    expect(canReadProject(projectToken('p-a'), { id: 'p-sibling', teamId: TEAM_A })).toBe(false);
  });
});

describe('canReadProject — anonymous', () => {
  // THE backward-compatibility seam. An anonymous caller only exists when the
  // operator left READ_TOKEN unset, i.e. chose an open deployment. Teams must
  // not silently close it. See the Global Constraints of plan 058.
  it('reads everything — teams do not turn an open deployment into a closed one', () => {
    expect(canReadProject(anonymousAccess(), projectInA)).toBe(true);
    expect(canReadProject(anonymousAccess(), orphan)).toBe(true);
  });
});

describe('canWriteProject', () => {
  it('team_admin may write in their own team', () => {
    expect(canWriteProject(member({ [TEAM_A]: 'team_admin' }), projectInA)).toBe(true);
  });

  it('team_admin may NOT write in another team', () => {
    expect(canWriteProject(member({ [TEAM_A]: 'team_admin' }), projectInB)).toBe(false);
  });

  it('member is read-only, even in their own team', () => {
    expect(canWriteProject(member({ [TEAM_A]: 'member' }), projectInA)).toBe(false);
  });

  it.each([
    ['global-admin user', globalAdminUser],
    ['ADMIN_TOKEN', adminToken],
  ])('%s may write anywhere', (_label, access) => {
    expect(canWriteProject(access, projectInA)).toBe(true);
    expect(canWriteProject(access, orphan)).toBe(true);
  });

  it('READ_TOKEN may NOT write — the name is the contract', () => {
    expect(canWriteProject(readToken, projectInA)).toBe(false);
  });

  it('a project token may write to its own project (it is the ingest credential)', () => {
    expect(canWriteProject(projectToken('p-a'), projectInA)).toBe(true);
    expect(canWriteProject(projectToken('p-a'), projectInB)).toBe(false);
  });

  it('anonymous may NOT write — open reads never implied open writes (plan 031)', () => {
    expect(canWriteProject(anonymousAccess(), projectInA)).toBe(false);
  });
});

describe('canAdministerTeams', () => {
  it.each([
    ['global-admin user', globalAdminUser, true],
    ['ADMIN_TOKEN', adminToken, true],
    ['team_admin', member({ [TEAM_A]: 'team_admin' }), false],
    ['member', member({ [TEAM_A]: 'member' }), false],
    ['READ_TOKEN', readToken, false],
    ['anonymous', anonymousAccess(), false],
  ])('%s → %s', (_label, access, expected) => {
    expect(canAdministerTeams(access as Access)).toBe(expected);
  });
});

describe('scopesProjectList', () => {
  it('scopes a plain user', () => {
    expect(scopesProjectList(member({ [TEAM_A]: 'member' }))).toBe(true);
  });

  it('scopes a project token to its one project', () => {
    expect(scopesProjectList(projectToken('p-a'))).toBe(true);
  });

  it.each([
    ['global-admin user', globalAdminUser],
    ['ADMIN_TOKEN', adminToken],
    ['READ_TOKEN', readToken],
    ['anonymous', anonymousAccess()],
  ])('does not scope %s', (_label, access) => {
    expect(scopesProjectList(access as Access)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/auth/access.test.ts`
Expected: FAIL — cannot resolve `./access`.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/auth/access.ts`:

```ts
import type { TeamRole } from './membership';

/**
 * How the caller authenticated. Every branch of the authorization model keys
 * off this plus `isGlobalAdmin` — there is no sixth case, and adding one means
 * revisiting every function below.
 */
export type AccessKind = 'user' | 'project-token' | 'read-token' | 'admin-token' | 'anonymous';

export interface Access {
  kind: AccessKind;
  userId: string | null;
  isGlobalAdmin: boolean;
  teamIds: string[];
  roleByTeam: Record<string, TeamRole>;
  /** Set only for kind === 'project-token': the single project it may touch. */
  projectId: string | null;
}

/** The scope-relevant shape of a project. */
export interface ScopedProject {
  id: string;
  teamId: string | null;
}

export function anonymousAccess(): Access {
  return {
    kind: 'anonymous',
    userId: null,
    isGlobalAdmin: false,
    teamIds: [],
    roleByTeam: {},
    projectId: null,
  };
}

/**
 * May this caller READ this project?
 *
 * `anonymous` returns true on purpose. An anonymous caller can only exist on a
 * deployment where the operator left READ_TOKEN unset — i.e. deliberately open
 * reads (plan 041, D1). Teams scope *identified* callers; they do not
 * retroactively close a deployment its owner chose to leave open. Denying here
 * would break every existing install the moment this plan merges.
 */
export function canReadProject(access: Access, project: ScopedProject): boolean {
  if (access.isGlobalAdmin) return true;

  switch (access.kind) {
    case 'admin-token':
      return true;
    case 'read-token':
      return true;
    case 'anonymous':
      return true;
    case 'project-token':
      return access.projectId === project.id;
    case 'user':
      // An orphaned project (teamId === null) is readable by global admins
      // only — deleting a team must not publish its projects to everyone.
      return project.teamId !== null && access.teamIds.includes(project.teamId);
  }
}

/**
 * May this caller MUTATE this project (settings, rules, token rotation, mute)?
 *
 * Note the asymmetry with reads: `read-token` and `anonymous` are read-only.
 * Plan 031 closed a confused deputy that let an unauthenticated POST mute a
 * test — and a muted test feeds the CI skip-list. Open reads never implied
 * open writes, and must not start to here.
 */
export function canWriteProject(access: Access, project: ScopedProject): boolean {
  if (access.isGlobalAdmin) return true;

  switch (access.kind) {
    case 'admin-token':
      return true;
    case 'project-token':
      return access.projectId === project.id;
    case 'user':
      return project.teamId !== null && access.roleByTeam[project.teamId] === 'team_admin';
    case 'read-token':
    case 'anonymous':
      return false;
  }
}

/** Team CRUD and user CRUD are global-admin only — never delegated per team. */
export function canAdministerTeams(access: Access): boolean {
  return access.isGlobalAdmin || access.kind === 'admin-token';
}

/**
 * Should a project LIST be filtered for this caller?
 *
 * The complement of "sees everything". Kept as its own function so a list
 * route cannot drift from the per-project rule by re-deriving the condition
 * inline.
 */
export function scopesProjectList(access: Access): boolean {
  if (access.isGlobalAdmin) return false;
  return access.kind === 'user' || access.kind === 'project-token';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter api exec vitest run src/services/auth/access.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/auth/access.ts apps/api/src/services/auth/access.test.ts
git commit -m "feat(auth): pure per-team access decision table"
```

---

### Task 2: the `resolveAccess()` middleware

**Files:**
- Create: `apps/api/src/middleware/access.ts`
- Modify: `apps/api/src/index.ts` (mount `sessionAuth()` globally)
- Test: exercised end-to-end by Task 3's matrix suite.

**Interfaces:**
- Consumes: `Access` and the decision functions (Task 1); `getSessionUser` (plan 056); `extractBearerToken`, `tokensMatch`, `hashToken` (existing `middleware/token.ts` / `middleware/auth.ts`).
- Produces:
  - `interface ResolveAccessMiddleware extends MiddlewareHandler { isResolveAccess: true }`
  - `resolveAccess(resolveProjectId?: (c: Context) => string | null | undefined): ResolveAccessMiddleware`
  - `getAccess(c: Context): Access`
  - `loadScopedProject(projectId: string): Promise<ScopedProject | null>`
  - `assertProjectReadable(c: Context, projectId: string): Promise<ScopedProject | null>` — for the two routes that cannot supply a resolver.

- [ ] **Step 1: Implement**

Create `apps/api/src/middleware/access.ts`:

```ts
import { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { db, projects, teamMembers } from '../db';
import { getSessionUser } from './session';
import { extractBearerToken, tokensMatch } from './token';
import { hashToken } from './auth';
import {
  anonymousAccess,
  canReadProject,
  type Access,
  type ScopedProject,
} from '../services/auth/access';
import type { TeamRole } from '../services/auth/membership';

/**
 * Tagged, for the same reason readAuth is (middleware/auth.ts:102-113): every
 * call returns a fresh closure, so routes-auth-coverage.test.ts cannot
 * identify mounted scope-guards by reference. Removing `isResolveAccess`
 * makes that guard pass over an empty set — the exact failure mode it exists
 * to eliminate.
 */
export interface ResolveAccessMiddleware extends MiddlewareHandler {
  isResolveAccess: true;
}

/**
 * Classify the caller. Order matters and mirrors readAuth's reasoning: the
 * cheap in-memory comparisons come first, the database lookup last, because
 * the dashboard emits several API calls per page view.
 *
 * A user session outranks a bearer token when both are present: the session is
 * the more specific credential, and the dashboard forwards both.
 *
 * EXPORTED because the admin gate (middleware/auth.ts's
 * adminOrGlobalAdminAuth, Task 5) must classify callers identically. Two
 * classifiers that drift apart is how a scope check silently disagrees with
 * the gate in front of it — do not write a second one.
 */
export async function resolveAccessValue(c: Context): Promise<Access> {
  const sessionUser = getSessionUser(c);
  if (sessionUser) {
    const memberships = await db
      .select({ teamId: teamMembers.teamId, role: teamMembers.role })
      .from(teamMembers)
      .where(eq(teamMembers.userId, sessionUser.id));

    const roleByTeam: Record<string, TeamRole> = {};
    for (const m of memberships) roleByTeam[m.teamId] = m.role as TeamRole;

    return {
      kind: 'user',
      userId: sessionUser.id,
      isGlobalAdmin: sessionUser.isGlobalAdmin,
      teamIds: memberships.map((m) => m.teamId),
      roleByTeam,
      projectId: null,
    };
  }

  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) return anonymousAccess();

  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && tokensMatch(token, adminToken)) {
    return { ...anonymousAccess(), kind: 'admin-token', isGlobalAdmin: true };
  }

  const readToken = process.env.READ_TOKEN;
  if (readToken && tokensMatch(token, readToken)) {
    return { ...anonymousAccess(), kind: 'read-token' };
  }

  // readAuth may already have resolved and cached the project for this token.
  const cached = c.get('project') as { id: string } | undefined;
  if (cached) {
    return { ...anonymousAccess(), kind: 'project-token', projectId: cached.id };
  }

  const project = await db.query.projects.findFirst({
    where: eq(projects.tokenHash, hashToken(token)),
  });
  if (project) {
    return { ...anonymousAccess(), kind: 'project-token', projectId: project.id };
  }

  // An unrecognised bearer is no better than none. Note this cannot be a
  // credential that readAuth would have accepted — readAuth runs first and
  // 401s an unknown token when READ_TOKEN is set.
  return anonymousAccess();
}

/** The scope-relevant columns only — never the token hash. */
export async function loadScopedProject(projectId: string): Promise<ScopedProject | null> {
  const [row] = await db
    .select({ id: projects.id, teamId: projects.teamId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}

export function getAccess(c: Context): Access {
  return (c.get('access') as Access | undefined) ?? anonymousAccess();
}

/**
 * Resolve the caller into `c.get('access')` and, when a resolver is supplied,
 * enforce the read scope for the project that resolver names.
 *
 * Mounted AFTER readAuth on every read route. The division of labour:
 *   readAuth      — may you read AT ALL?  (READ_TOKEN posture, plan 041)
 *   resolveAccess — WHICH projects?       (team membership, this plan)
 *
 * A project the caller may not read yields 404, never 403: 403 confirms the
 * project exists, which is precisely the fact team scoping is hiding. This
 * matches how the pre-existing cross-project guard already behaves.
 *
 * @param resolveProjectId Reads the target project id out of the request. Omit
 *   on routes not scoped to a single project (list routes, and the two routes
 *   whose project is only discoverable after a database lookup — those call
 *   assertProjectReadable() in the handler instead).
 */
export function resolveAccess(
  resolveProjectId?: (c: Context) => string | null | undefined
): ResolveAccessMiddleware {
  const mw: MiddlewareHandler = async (c, next) => {
    const access = await resolveAccessValue(c);
    c.set('access', access);

    if (resolveProjectId) {
      const wanted = resolveProjectId(c);
      if (wanted) {
        const project = await loadScopedProject(wanted);
        // A malformed or unknown id falls through to the handler, which owns
        // the 400-vs-404 distinction it already implements. We only reject the
        // case that is unambiguously ours: the project exists and is not yours.
        if (project && !canReadProject(access, project)) {
          throw new HTTPException(404, { message: 'Project not found' });
        }
      }
    }

    await next();
  };

  return Object.assign(mw, { isResolveAccess: true as const });
}

/**
 * Handler-side scope check, for routes whose project id is not in the request.
 *
 * Returns the project when readable, null otherwise — so the caller writes
 * `if (!project) return c.json({ error: 'Not found' }, 404)` and cannot
 * accidentally distinguish "absent" from "forbidden".
 */
export async function assertProjectReadable(
  c: Context,
  projectId: string
): Promise<ScopedProject | null> {
  const project = await loadScopedProject(projectId);
  if (!project) return null;
  return canReadProject(getAccess(c), project) ? project : null;
}
```

- [ ] **Step 2: Mount `sessionAuth()` globally**

`resolveAccess` reads `c.get('sessionUser')`, which only exists if `sessionAuth()` ran. In plan 056 it was mounted on the auth router only. Promote it in `apps/api/src/index.ts`, immediately after the `bodyLimit` middleware (line 37) and **before** any `app.route(...)` call:

```ts
import { sessionAuth } from './middleware/session';
// …
// Resolve the session cookie for every request. It never rejects on
// CREDENTIAL STATE — absent, unknown and expired cookies are all simply
// anonymous — so mounting it globally cannot 401 an unauthenticated route.
// It is NOT unconditionally throw-free: the session-lookup SELECT is
// deliberately left to propagate (plan 056 Task 4, human ruling).
app.use('*', sessionAuth());
```

**Decide deliberately where this mount sits relative to `/health` and `/metrics`.** As written above it goes in ahead of both (`index.ts:56` and `:66`), which turns the health check into a DB liveness probe *for any request carrying an `fk_session` cookie*: if Postgres is down, `/health` 500s and an orchestrator restart-loops the container during the outage. Cookie-less probes short-circuit before any query, so most real probes are unaffected — but if your deployment's health check might carry a cookie, mount `sessionAuth()` **after** the health and metrics routes.

Then remove the now-redundant `authRouter.use('*', sessionAuth())` from `routes/auth.ts` (the global mount covers it).

**Do NOT restore a wildcard `authRouter.use('*', authRateLimit)`.** An earlier draft of this plan said to keep one; that was corrected during plan 056's Task 6 review. `authRateLimit` is 10/min keyed on the client IP, and plan 059's `hooks.server.ts` calls `GET /auth/me` **server-side on every page view** — so every dashboard user shares one bucket keyed to the dashboard container's IP. The 11th page view in any minute would 429, `fetchMe` would read that as unauthenticated, and the user would be bounced to `/login`. Random logouts under trivial load.

`authRateLimit` is therefore scoped to the password-bearing POSTs only (`/login`, `/change-password`); `/me` and `/logout` carry the normal `apiRateLimit`. Preserve that split.

- [ ] **Step 3: Typecheck and run the existing suites**

```bash
pnpm --filter api exec tsc --noEmit
pnpm --filter api test
```
Expected: clean, and **every pre-existing suite still green** — nothing consumes `access` yet.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/middleware/access.ts apps/api/src/index.ts apps/api/src/routes/auth.ts
git commit -m "feat(auth): resolveAccess scope-guard middleware"
```

---

### Task 3: enforce scope on the project read routes

**Files:**
- Modify: `apps/api/src/routes/projects.ts` (7 read routes + the list route)
- Test: `apps/api/src/routes/access-scope.test.ts` (create)

**Interfaces:**
- Consumes: `resolveAccess`, `getAccess` (Task 2); `scopesProjectList` (Task 1).
- Produces: every `/api/v1/projects/*` read is team-scoped; `GET /api/v1/projects` is filtered.

- [ ] **Step 1: Write the failing matrix test**

Create `apps/api/src/routes/access-scope.test.ts`. This is the suite that proves the feature.

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { db, users, sessions } from '../db';
import { SESSION_COOKIE } from '../services/auth/session';

const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeScope = hasDatabase && hasAdminToken ? describe : describe.skip;

let app: typeof import('../index').default;
beforeAll(async () => {
  if (hasDatabase) app = (await import('../index')).default;
});

const adminHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
});
const uniq = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;

async function json(res: Response) {
  return res.json();
}

/** Create a team, a project inside it, and a user with the given role. */
async function fixture(role: 'team_admin' | 'member') {
  const team = (await json(await app.request('/api/v1/admin/teams', {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ name: uniq('t') }),
  }))).team;

  const created = await json(await app.request('/api/v1/admin/projects', {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({ name: uniq('p'), teamId: team.id }),
  }));

  const user = (await json(await app.request('/api/v1/admin/users', {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({ email: `${uniq('u')}@example.test` }),
  })));

  await app.request(`/api/v1/admin/teams/${team.id}/members`, {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({ userId: user.user.id, role }),
  });

  const loginRes = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.user.email, password: user.temporaryPassword }),
  });
  const cookie = (loginRes.headers.get('set-cookie') ?? '')
    .match(new RegExp(`${SESSION_COOKIE}=([^;]*)`))?.[1];

  return { team, project: created.project, projectToken: created.token, user: user.user, cookie: cookie! };
}

const as = (cookie: string) => ({ headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } });

// Every project-scoped read route, so a new one cannot be added without a
// deliberate decision about whether it belongs here.
const READ_PATHS = (id: string) => [
  `/api/v1/projects/${id}/stats`,
  `/api/v1/projects/${id}/flaky-tests`,
  `/api/v1/projects/${id}/quarantine`,
  `/api/v1/projects/${id}/runs`,
  `/api/v1/projects/${id}/analysis`,
  `/api/v1/projects/${id}/trend`,
];

describeScope('per-team read scoping', () => {
  it('a member reads their own team\'s project on every read route', async () => {
    const f = await fixture('member');
    for (const path of READ_PATHS(f.project.id)) {
      const res = await app.request(path, as(f.cookie));
      expect(res.status, `${path} should be readable by its own team`).toBe(200);
    }
  });

  it('a member gets 404 — NOT 403 — for another team\'s project, on every read route', async () => {
    const mine = await fixture('member');
    const theirs = await fixture('member');

    for (const path of READ_PATHS(theirs.project.id)) {
      const res = await app.request(path, as(mine.cookie));
      expect(res.status, `${path} must hide another team's project`).toBe(404);
    }
  });

  it('a global admin reads any team\'s project', async () => {
    const theirs = await fixture('member');

    const adminUser = await json(await app.request('/api/v1/admin/users', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ email: `${uniq('ga')}@example.test`, isGlobalAdmin: true }),
    }));
    const loginRes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminUser.user.email, password: adminUser.temporaryPassword }),
    });
    const cookie = (loginRes.headers.get('set-cookie') ?? '')
      .match(new RegExp(`${SESSION_COOKIE}=([^;]*)`))?.[1]!;

    const res = await app.request(`/api/v1/projects/${theirs.project.id}/stats`, as(cookie));
    expect(res.status).toBe(200);
  });

  it('a user in no team sees nothing', async () => {
    const theirs = await fixture('member');
    const loner = await json(await app.request('/api/v1/admin/users', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ email: `${uniq('lone')}@example.test` }),
    }));
    const loginRes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: loner.user.email, password: loner.temporaryPassword }),
    });
    const cookie = (loginRes.headers.get('set-cookie') ?? '')
      .match(new RegExp(`${SESSION_COOKIE}=([^;]*)`))?.[1]!;

    const res = await app.request(`/api/v1/projects/${theirs.project.id}/stats`, as(cookie));
    expect(res.status).toBe(404);
  });
});

describeScope('GET /api/v1/projects list filtering', () => {
  it('lists only the caller\'s teams\' projects', async () => {
    const mine = await fixture('member');
    const theirs = await fixture('member');

    const body = await json(await app.request('/api/v1/projects', as(mine.cookie)));
    const ids = body.projects.map((p: { id: string }) => p.id);

    expect(ids).toContain(mine.project.id);
    expect(ids).not.toContain(theirs.project.id);
  });

  it('is unfiltered for a caller with no session (open deployment unchanged)', async () => {
    // Only meaningful when READ_TOKEN is unset, which is the default in the
    // test environment. This is the backward-compatibility seam: teams must
    // not silently close a deployment the operator left open.
    if (process.env.READ_TOKEN) return;

    const a = await fixture('member');
    const b = await fixture('member');
    const body = await json(await app.request('/api/v1/projects'));
    const ids = body.projects.map((p: { id: string }) => p.id);

    expect(ids).toContain(a.project.id);
    expect(ids).toContain(b.project.id);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/access-scope.test.ts`
Expected: FAIL — cross-team reads return `200`, and the list is unfiltered.

- [ ] **Step 3: Mount `resolveAccess` on the six project-scoped reads**

In `apps/api/src/routes/projects.ts`, add the import:

```ts
import { resolveAccess, getAccess } from '../middleware/access';
import { scopesProjectList } from '../services/auth/access';
```

Then, for each of the routes at lines 81, 101, 154, 210, 270, 367 and 420, insert `resolveAccess` immediately after the existing `readAuth`, sharing the same resolver:

```ts
projectsRouter.get(
  '/:id/stats',
  readAuth((c) => c.req.param('id')),
  resolveAccess((c) => c.req.param('id')),
  async (c) => { /* handler unchanged */ }
);
```

Do **not** collapse the two into one middleware. They answer different questions (see the comment in `middleware/access.ts`), they were introduced by different plans with different tests, and `read-auth.test.ts` asserts on `readAuth`'s behavior in isolation.

**The handlers need no change.** The middleware 404s before they run — which is the point of putting the check there rather than in seven handlers.

- [ ] **Step 4: Filter the list route**

Replace the body of `GET /` (line 63):

```ts
projectsRouter.get('/', readAuth(), resolveAccess(), async (c) => {
  const access = getAccess(c);

  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      createdAt: projects.createdAt,
      teamId: projects.teamId,
    })
    .from(projects)
    .orderBy(projects.name);

  // Filtered in JS against the same predicate the per-project guard uses, so
  // the list and the detail routes cannot disagree about what is visible. The
  // project count on a single-org install is small; if that ever stops being
  // true, push this into SQL — but keep one shared predicate.
  const visible = scopesProjectList(access)
    ? rows.filter((p) => canReadProject(access, p))
    : rows;

  return c.json({ projects: visible });
});
```

Add `canReadProject` to the `services/auth/access` import.

**`teamId` is returned, additively.** Existing consumers ignore an extra field, and the dashboard's team switcher (plan 059) needs it to group the list client-side. Returning it is safe precisely because the array is already scoped: a caller can only see the team ids of projects they may already read. Add `teamId` to this endpoint's response documentation in `docs/API.md` (Task 7, Step 2) and to the dashboard's `Project` interface when plan 059 lands.

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm --filter api exec vitest run src/routes/access-scope.test.ts
pnpm --filter api exec vitest run src/routes/projects.test.ts
```
Expected: both PASS. The pre-existing `projects.test.ts` must stay green — it exercises the anonymous/READ_TOKEN paths, which this plan does not change.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/projects.ts apps/api/src/routes/access-scope.test.ts
git commit -m "feat(api): team-scope the project read routes"
```

---

### Task 4: scope the test routes and gate the mute mutation

**Files:**
- Modify: `apps/api/src/routes/tests.ts`
- Test: `apps/api/src/routes/access-scope.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveAccess`, `assertProjectReadable`, `getAccess`, `loadScopedProject`; `canWriteProject`.
- Produces: `/tests/:testName/history` and `/tests/:testName/trend` team-scoped by resolver; `/tests/flaky/:id` scoped in-handler; `PATCH /tests/flaky/:id` role-gated with `403`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/access-scope.test.ts`:

```ts
describeScope('flaky-test mute authorization', () => {
  /**
   * Ingest one report so the project has a flaky_tests row to mute.
   *
   * `?wait=true` awaits the reconcile (plan 032). Without it the ingest returns
   * 201 BEFORE updateFlakyTests has run and this helper would race it —
   * the exact bug plan 027 chased in this repo's own suite. Never sleep here.
   */
  async function seedFlaky(projectToken: string) {
    const startTime = new Date().toISOString();
    const attempt = (status: 'passed' | 'failed') => ({
      workerIndex: 0,
      status,
      duration: 10,
      retry: 0,
      startTime,
    });

    // Real reporter nesting: suites[].specs[].tests[].results[] (AGENTS.md).
    // Fails then passes on retry => Playwright's definition of flaky.
    const report = {
      suites: [
        {
          title: 'scope.spec.ts',
          file: 'scope.spec.ts',
          specs: [
            {
              title: 'always flaky test',
              ok: true,
              tests: [
                {
                  results: [attempt('failed'), { ...attempt('passed'), retry: 1 }],
                  status: 'flaky',
                },
              ],
            },
          ],
        },
      ],
    };

    const res = await app.request('/api/v1/reports?wait=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${projectToken}` },
      body: JSON.stringify({ branch: 'main', commitSha: 'a'.repeat(40), report }),
    });
    expect(res.status).toBe(201);
  }

  it('a team_admin may mute a test in their own team', async () => {
    const f = await fixture('team_admin');
    await seedFlaky(f.projectToken);
    const list = await json(await app.request(`/api/v1/projects/${f.project.id}/flaky-tests`, as(f.cookie)));
    const flakyId = list.flakyTests[0].id;

    const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${f.cookie}` },
      body: JSON.stringify({ status: 'ignored' }),
    });
    expect(res.status).toBe(200);
  });

  it('a member gets 403 — they can SEE the project, so hiding it would be a lie', async () => {
    const f = await fixture('member');
    await seedFlaky(f.projectToken);
    const list = await json(await app.request(`/api/v1/projects/${f.project.id}/flaky-tests`, as(f.cookie)));
    const flakyId = list.flakyTests[0].id;

    const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${f.cookie}` },
      body: JSON.stringify({ status: 'ignored' }),
    });
    expect(res.status).toBe(403);
  });

  it('a team_admin of ANOTHER team gets 404 — they cannot see it at all', async () => {
    const mine = await fixture('team_admin');
    const theirs = await fixture('team_admin');
    await seedFlaky(theirs.projectToken);
    const list = await json(
      await app.request(`/api/v1/projects/${theirs.project.id}/flaky-tests`, as(theirs.cookie))
    );
    const flakyId = list.flakyTests[0].id;

    const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${mine.cookie}` },
      body: JSON.stringify({ status: 'ignored' }),
    });
    expect(res.status).toBe(404);
  });

  it('ADMIN_TOKEN still mutes anything (break-glass unchanged)', async () => {
    const f = await fixture('member');
    await seedFlaky(f.projectToken);
    const list = await json(await app.request(`/api/v1/projects/${f.project.id}/flaky-tests`, as(f.cookie)));
    const flakyId = list.flakyTests[0].id;

    const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
      method: 'PATCH', headers: adminHeaders(), body: JSON.stringify({ status: 'ignored' }),
    });
    expect(res.status).toBe(200);
  });

  it('GET /tests/flaky/:id hides another team\'s row', async () => {
    const mine = await fixture('member');
    const theirs = await fixture('member');
    await seedFlaky(theirs.projectToken);
    const list = await json(
      await app.request(`/api/v1/projects/${theirs.project.id}/flaky-tests`, as(theirs.cookie))
    );
    const flakyId = list.flakyTests[0].id;

    const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, as(mine.cookie));
    expect(res.status).toBe(404);
  });
});
```

If the ingest 400s, compare `seedFlaky`'s report against `buildFlakinessReport()` at `apps/api/src/routes/admin.test.ts:38` — that is the known-good fixture shape, and the parser is strict about the real reporter's `suites[].specs[].tests[].results[]` nesting.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/access-scope.test.ts`
Expected: FAIL — the mute succeeds for a `member` and for another team's `team_admin` (both currently 401 on `adminAuth`, or 200 with `ADMIN_TOKEN`).

- [ ] **Step 3: Scope the two resolver-friendly reads**

In `apps/api/src/routes/tests.ts` (lines 136 and 222), add `resolveAccess` with the same resolver `readAuth` already uses:

```ts
testsRouter.get(
  '/:testName/history',
  readAuth((c) => c.req.query('project') ?? null),
  resolveAccess((c) => c.req.query('project') ?? null),
  async (c) => { /* unchanged */ }
);
```

- [ ] **Step 4: Scope `GET /flaky/:id` in the handler**

This route's project is only knowable after loading the `flaky_tests` row, so no resolver can supply it. Mount `resolveAccess()` with no resolver, and check in the handler:

```ts
testsRouter.get('/flaky/:id', readAuth(), resolveAccess(), async (c) => {
  // …existing load of the flaky_tests row…
  if (!flakyTest) return c.json({ error: 'Flaky test not found' }, 404);

  // Scope check lives here, not in the middleware: the project id is a
  // property of the row we just loaded, not of the request. Same 404-not-403
  // existence-hiding as the middleware path.
  if (!(await assertProjectReadable(c, flakyTest.projectId))) {
    return c.json({ error: 'Flaky test not found' }, 404);
  }

  // …existing response…
});
```

**Record this exception where it will be seen.** Add it to the comment block in `routes-auth-coverage.test.ts` alongside `READ_TOKEN_ONLY`, so the next author knows the static guard cannot verify this one:

```ts
// Routes whose scope check CANNOT be verified statically: the target project
// is a property of a row, not of the request, so resolveAccess() is mounted
// without a resolver and the check lives in the handler
// (assertProjectReadable). Covered behaviourally by access-scope.test.ts.
const HANDLER_SCOPED = ['/api/v1/tests/flaky/:id'];
```

- [ ] **Step 5: Role-gate the mute**

Replace `adminAuth()` on `PATCH /flaky/:id` (line 316) with `resolveAccess()`, and gate in the handler:

```ts
testsRouter.patch('/flaky/:id', resolveAccess(), async (c) => {
  // …existing uuid parse + load of the flaky_tests row…
  if (!flakyTest) return c.json({ error: 'Flaky test not found' }, 404);

  const project = await loadScopedProject(flakyTest.projectId);
  const access = getAccess(c);

  // 404 when they cannot even see it; 403 when they can see it but lack the
  // rank. Telling a member of the right team "forbidden" is honest; telling
  // a stranger the same thing confirms the project exists.
  if (!project || !canReadProject(access, project)) {
    return c.json({ error: 'Flaky test not found' }, 404);
  }
  if (!canWriteProject(access, project)) {
    return c.json({ error: 'You do not have permission to change this test' }, 403);
  }

  // …existing mute/unmute logic, unchanged — including the mute_source +
  // quarantine_events audit append required by AGENTS.md…
});
```

**Do not touch the audit-trail write.** `AGENTS.md`: any mute/unmute path must set `flaky_tests.mute_source` and append a `quarantine_events` row. This change alters *who may call*, not *what is recorded*.

- [ ] **Step 6: Run to verify it passes**

```bash
pnpm --filter api exec vitest run src/routes/access-scope.test.ts src/routes/tests.test.ts
```
Expected: PASS. `tests.test.ts` exercises the `ADMIN_TOKEN` mute path — it must stay green, which is the break-glass guarantee.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/tests.ts apps/api/src/routes/access-scope.test.ts apps/api/src/routes-auth-coverage.test.ts
git commit -m "feat(api): team-scope the test routes and role-gate the mute"
```

---

### Task 5: accept global-admin sessions on the admin API

**Files:**
- Modify: `apps/api/src/middleware/auth.ts` (add `adminOrGlobalAdminAuth()`)
- Modify: `apps/api/src/routes/admin.ts`, `admin-teams.ts`, `admin-users.ts`
- Test: `apps/api/src/routes/access-scope.test.ts` (extend)

**Why:** without this, the dashboard console in plan 059 has no way to work except by holding `ADMIN_TOKEN` — the exact ambient authority the account system exists to replace. `ADMIN_TOKEN` keeps working as break-glass.

**Interfaces:**
- Produces: `adminOrGlobalAdminAuth(): MiddlewareHandler` — accepts a valid `ADMIN_TOKEN` bearer **or** a session whose user is a global admin; 401 otherwise. Sets `c.set('access', …)` either way.

- [ ] **Step 1: Write the failing tests**

Append to `access-scope.test.ts`:

```ts
describeScope('admin API accepts a global-admin session', () => {
  async function globalAdminCookie() {
    const created = await json(await app.request('/api/v1/admin/users', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ email: `${uniq('ga')}@example.test`, isGlobalAdmin: true }),
    }));
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: created.user.email, password: created.temporaryPassword }),
    });
    return (res.headers.get('set-cookie') ?? '').match(new RegExp(`${SESSION_COOKIE}=([^;]*)`))?.[1]!;
  }

  it('a global admin session can list projects without ADMIN_TOKEN', async () => {
    const cookie = await globalAdminCookie();
    const res = await app.request('/api/v1/admin/projects', as(cookie));
    expect(res.status).toBe(200);
  });

  it('a global admin session can administer teams', async () => {
    const cookie = await globalAdminCookie();
    const res = await app.request('/api/v1/admin/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${cookie}` },
      body: JSON.stringify({ name: uniq('ga-team') }),
    });
    expect(res.status).toBe(201);
  });

  it('a team_admin session is REFUSED on team CRUD (never delegated)', async () => {
    const f = await fixture('team_admin');
    const res = await app.request('/api/v1/admin/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${f.cookie}` },
      body: JSON.stringify({ name: uniq('nope') }),
    });
    expect([401, 403]).toContain(res.status);
  });

  it('a team_admin session is REFUSED on user provisioning', async () => {
    const f = await fixture('team_admin');
    const res = await app.request('/api/v1/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${f.cookie}` },
      body: JSON.stringify({ email: `${uniq('x')}@example.test` }),
    });
    expect([401, 403]).toContain(res.status);
  });

  it('a plain member session is refused everywhere on the admin API', async () => {
    const f = await fixture('member');
    const res = await app.request('/api/v1/admin/projects', as(f.cookie));
    expect([401, 403]).toContain(res.status);
  });

  it('GET /admin/projects is filtered for a team_admin', async () => {
    const mine = await fixture('team_admin');
    const theirs = await fixture('team_admin');
    const body = await json(await app.request('/api/v1/admin/projects', as(mine.cookie)));
    const ids = body.projects.map((p: { id: string }) => p.id);
    expect(ids).toContain(mine.project.id);
    expect(ids).not.toContain(theirs.project.id);
  });

  it('a team_admin may PATCH their own project\'s settings but not another team\'s', async () => {
    const mine = await fixture('team_admin');
    const theirs = await fixture('team_admin');

    const ok = await app.request(`/api/v1/admin/projects/${mine.project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${mine.cookie}` },
      body: JSON.stringify({ minRuns: 7 }),
    });
    expect(ok.status).toBe(200);

    const denied = await app.request(`/api/v1/admin/projects/${theirs.project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${mine.cookie}` },
      body: JSON.stringify({ minRuns: 7 }),
    });
    expect(denied.status).toBe(404);
  });

  it('a team_admin may NOT delete a project (destructive ops stay global-admin)', async () => {
    const mine = await fixture('team_admin');
    const res = await app.request(`/api/v1/admin/projects/${mine.project.id}`, {
      method: 'DELETE',
      headers: { Cookie: `${SESSION_COOKIE}=${mine.cookie}` },
    });
    expect(res.status).toBe(403);
  });

  it('ADMIN_TOKEN still does everything (break-glass unchanged)', async () => {
    const res = await app.request('/api/v1/admin/projects', { headers: adminHeaders() });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — every session-authenticated admin call 401s (`adminAuth` demands a bearer).

- [ ] **Step 3: Implement the combined guard**

In `apps/api/src/middleware/auth.ts`, add beside `adminAuth`:

```ts
/**
 * Admin-API gate that accepts EITHER a valid ADMIN_TOKEN bearer OR a session
 * belonging to a global admin.
 *
 * Note the deliberate asymmetry with adminAuth(): an unset ADMIN_TOKEN is no
 * longer a 500. Once accounts exist, "the operator did not configure a static
 * admin token" is a legitimate, in fact preferable, deployment — the account
 * system is the intended path and the static token is break-glass. A session
 * must still be able to get in.
 *
 * A team_admin passes this gate and is then scoped per-project by the route.
 * Team CRUD and user CRUD call canAdministerTeams() on top, because those are
 * never delegated.
 */
export function adminOrGlobalAdminAuth(): MiddlewareHandler {
  return async (c: Context, next) => {
    const access = await resolveAccessValue(c);
    c.set('access', access);

    if (access.kind === 'admin-token' || access.kind === 'user') {
      await next();
      return;
    }

    throw new HTTPException(401, { message: 'Admin authentication required' });
  };
}
```

`resolveAccessValue` is already exported from `middleware/access.ts` (Task 2) — import it, do **not** write a second classifier.

Beware the import cycle: `middleware/auth.ts` currently has no dependency on `middleware/access.ts`. Put `resolveAccessValue` in `middleware/access.ts` and import it into `auth.ts`; `access.ts` already imports `hashToken` from `auth.ts`, so if TypeScript complains about the cycle, move `hashToken` down into `middleware/token.ts` (where `extractBearerToken`/`tokensMatch` already live) and re-export it from `auth.ts` — the file's existing comment at :8-12 shows this exact move has been made before.

- [ ] **Step 4: Apply it to the three admin routers**

Replace `adminAuth()` with `adminOrGlobalAdminAuth()` in the `use('*', …)` line of `routes/admin.ts` (:20), `routes/admin-teams.ts` and `routes/admin-users.ts`.

Then add the per-router authorization:

**`admin-teams.ts` and `admin-users.ts`** — global-admin only. Add one more middleware after the gate:

```ts
adminTeamsRouter.use('*', async (c, next) => {
  if (!canAdministerTeams(getAccess(c))) {
    return c.json({ error: 'Global admin required' }, 403);
  }
  await next();
});
```

**`admin.ts`** — per-project scoping. Add a helper and use it in every `/projects/:id*` route:

```ts
/**
 * Load the project this admin request targets, enforcing scope.
 *
 * Returns null when the caller may not see it — the caller then 404s, so a
 * team_admin cannot probe another team's project ids.
 */
async function scopedAdminProject(c: Context, projectId: string) {
  const project = await loadScopedProject(projectId);
  if (!project) return null;
  const access = getAccess(c);
  return canReadProject(access, project) && canWriteProject(access, project) ? project : null;
}
```

Apply it in `POST /projects/:id/rotate-token`, `PATCH /projects/:id`, `POST /projects/:id/prune`, and all four `/projects/:id/rules*` routes: `if (!(await scopedAdminProject(c, projectId))) return c.json({ error: 'Project not found' }, 404);`

Filter `GET /projects` with the same predicate used in Task 3.

**`DELETE /projects/:id` and `POST /projects` stay global-admin only** — creating and destroying projects is an operator act, not a team act:

```ts
  if (!canAdministerTeams(getAccess(c))) {
    return c.json({ error: 'Global admin required' }, 403);
  }
```

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm --filter api exec vitest run src/routes/access-scope.test.ts src/routes/admin.test.ts src/routes/admin-teams.test.ts src/routes/admin-users.test.ts
```
Expected: PASS. The pre-existing `admin.test.ts` uses `ADMIN_TOKEN` throughout and must stay green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/middleware/auth.ts apps/api/src/middleware/access.ts apps/api/src/routes/admin.ts apps/api/src/routes/admin-teams.ts apps/api/src/routes/admin-users.ts apps/api/src/routes/access-scope.test.ts
git commit -m "feat(api): accept global-admin sessions on the admin API"
```

---

### Task 6: extend the coverage guard to demand `resolveAccess`

**Files:**
- Modify: `apps/api/src/routes-auth-coverage.test.ts`

**Interfaces:**
- Consumes: the `isResolveAccess` tag (Task 2).
- Produces: CI fails when a `GET` under `/api/v1` (outside `/admin` and the self-gated allowlist) lacks `readAuth` **or** `resolveAccess`.

**Why this is its own task:** this guard is the reason the feature stays true. Plan 041 built it because "every author must remember the scope predicate" had already failed twice in this repo (ECharts series registration, Dependabot directory coverage), both silently. Team scoping is a third instance of the same shape, with a worse failure mode: a forgotten `resolveAccess` is a cross-team data leak that no test would notice, because the route still returns `200` with correct-looking data.

- [ ] **Step 1: Write the failing assertion**

In `routes-auth-coverage.test.ts`, add beside `isReadAuthHandler`:

```ts
function isResolveAccessHandler(handler: unknown): boolean {
  return (
    typeof handler === 'function' &&
    (handler as { isResolveAccess?: boolean }).isResolveAccess === true
  );
}

const resolveAccessPaths = new Set(
  app.routes.filter((r) => r.method === 'GET' && isResolveAccessHandler(r.handler)).map((r) => r.path)
);
```

and a second `it.each` beside the existing one:

```ts
  it.each(readRoutes.map((r) => r.path))('has resolveAccess mounted: GET %s', (path) => {
    expect(
      resolveAccessPaths.has(path),
      `GET ${path} has no resolveAccess mounted. Every read endpoint must be mounted as\n` +
        `  router.get('<path>', readAuth(<resolver>), resolveAccess(<resolver>), handler)\n` +
        `sharing the SAME resolver. readAuth answers "may you read at all?" (READ_TOKEN\n` +
        `posture); resolveAccess answers "which projects?" (team membership).\n\n` +
        `Without it this endpoint returns another team's data to any signed-in user —\n` +
        `a 200 with plausible content, which no behavioural test will flag. See plan 058.\n\n` +
        `If the target project is only knowable after a database lookup, mount\n` +
        `resolveAccess() with no resolver, call assertProjectReadable() in the handler,\n` +
        `and add the path to HANDLER_SCOPED above with a covering test in\n` +
        `access-scope.test.ts.`
    ).toBe(true);
  });
```

Exclude the `HANDLER_SCOPED` paths (added in Task 4) from **this** assertion only — they legitimately mount `resolveAccess()` with no resolver, which the tag still marks, so in practice they pass. Verify that empirically rather than assuming: if `/api/v1/tests/flaky/:id` shows up in `resolveAccessPaths`, no exclusion is needed and `HANDLER_SCOPED` stays purely documentary.

- [ ] **Step 2: Add the anti-vacuity assertion**

```ts
  it('detects a known-covered route for resolveAccess (guard is not vacuous)', () => {
    expect(resolveAccessPaths.has('/api/v1/projects/:id/stats')).toBe(true);
  });
```

- [ ] **Step 3: Prove it bites**

Remove `resolveAccess(...)` from **one** route in `projects.ts`, run the guard, and confirm it fails naming that exact path. Restore it. Then run `git diff --stat` and confirm only the coverage test file is modified.

Run: `pnpm --filter api exec vitest run src/routes-auth-coverage.test.ts`
Expected: PASS after restoring.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes-auth-coverage.test.ts
git commit -m "test(api): fail CI when a read route skips resolveAccess"
```

---

### Task 7: mutation floor and documentation

**Files:**
- Modify: `scripts/mutation-gate.mjs`, `docs/API.md`, `plans/README.md`, `AGENTS.md`

- [ ] **Step 1: Calibrate the `access.ts` floor**

Same procedure as plan 056 Task 8 — `access.ts` is pure and DB-free, so it should score high; a low score means the decision matrix in Task 1 has a hole worth closing rather than a floor worth lowering.

```bash
docker run --rm -d --name stryker-pg -e POSTGRES_PASSWORD=stryker -p 55432:5432 postgres:17
cd apps/api
DATABASE_URL=postgres://postgres:stryker@localhost:55432/postgres \
  pnpm exec stryker run --mutate 'src/services/auth/access.ts'
```

Run twice, take the lower, add the row with `floor = floor(reliableLow) - 5`.

- [ ] **Step 2: Document the authorization model in `docs/API.md`**

Add an `### Authorization model` subsection under the authentication material, containing this table verbatim:

| Caller | Reads | Writes |
|---|---|---|
| Global admin (user or `ADMIN_TOKEN`) | every project, including unassigned ones | everything |
| `team_admin` | their teams' projects | their teams' projects (settings, rules, token rotation, mute) |
| `member` | their teams' projects | none |
| Project token | its own project | its own project (ingest) |
| `READ_TOKEN` | every project | none |
| Anonymous (only when `READ_TOKEN` is unset) | every project | none |

plus this note:

```markdown
A read for a project outside your scope returns **`404`**, not `403` — the API
does not confirm that a project you cannot see exists. A write you lack the
*role* for, on a project you *can* see, returns **`403`**.

**Setting `READ_TOKEN` is still what closes an instance to anonymous readers.**
Teams scope users; they do not retroactively close a deployment whose operator
chose to leave reads open. See `docs/API.md` § Authentication.
```

- [ ] **Step 3: Add the sharp edge to `AGENTS.md`**

Append to the "Sharp edges" list:

```markdown
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
```

- [ ] **Step 4: Add the plan row to `plans/README.md`**

```markdown
| 058 | Roadmap #5+#6 Phase C: authorization enforcement — pure `services/auth/access.ts` decision table, `resolveAccess()` scope guard on every read route (404 existence-hiding), role-gated mutations (403), filtered project lists, global-admin sessions accepted on the admin API, coverage guard extended to demand `resolveAccess`. **Anonymous stays unscoped** so an open deployment is unchanged | P2 | M–L | **057 (hard)** | TODO |
```

- [ ] **Step 5: Full verification**

```bash
pnpm lint
pnpm --filter api exec tsc --noEmit
pnpm --filter api test          # with DATABASE_URL and ADMIN_TOKEN
node scripts/mutation-gate.mjs
```

- [ ] **Step 6: Commit**

```bash
git add scripts/mutation-gate.mjs docs/API.md AGENTS.md plans/README.md
git commit -m "docs(api): document the per-team authorization model"
```

---

## Definition of done

- [ ] A `member` of team A gets `404` on **every** read route for a team-B project, and `200` for their own.
- [ ] A `member` gets `403` (not 404) muting a test in their own team; a `team_admin` gets `200`; another team's `team_admin` gets `404`.
- [ ] `GET /api/v1/projects` and `GET /api/v1/admin/projects` are filtered by team for users, unfiltered for global admins and anonymous.
- [ ] An orphaned project (`team_id IS NULL`) is invisible to every non-global-admin.
- [ ] `ADMIN_TOKEN`, `READ_TOKEN` and per-project ingest tokens behave exactly as before — proven by the pre-existing suites staying green untouched.
- [ ] `routes-auth-coverage.test.ts` demands both middlewares and was **manually proven to bite** by removing one mount (Task 6, Step 3).
- [ ] `node scripts/mutation-gate.mjs` passes with the `access.ts` floor.
- [ ] `pnpm lint`, `tsc --noEmit`, and the full API suite (with a database) all pass.

## Follow-ups this plan deliberately does not do

- **The dashboard still authenticates with `DASHBOARD_PASSWORD`** and still spends `ADMIN_TOKEN` server-side. It keeps working because `ADMIN_TOKEN` is unchanged. Plan 059 switches it to user sessions.
- **No per-user audit trail.** Who muted what is still only `quarantine_events.source` (`auto`/`manual`) — attributing it to a user id is a named out-of-scope item in the spec.
- **No external OIDC.** The `Access` type is the seam an IdP would plug into (a `kind: 'user'` from a different issuer), which is what "OIDC-ready" means in the spec — but nothing here wires one.
