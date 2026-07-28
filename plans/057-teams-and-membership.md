# Teams & Membership (Phase B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce `teams`, `team_members` and `projects.team_id` with a Default-team backfill so nothing disappears on upgrade, plus admin CRUD for teams, memberships and users — including the show-once temporary-password provisioning flow that bootstraps the first operator account.

**Architecture:** One migration (`0012`) carrying both the DDL and a hand-written data backfill. Two new focused routers (`routes/admin-teams.ts`, `routes/admin-users.ts`) mounted at their own sub-paths rather than bloating the already-830-line `routes/admin.ts`; each carries its own `adminRateLimit` + `adminAuth()` pair. A pure `services/auth/membership.ts` module holds the two invariants worth mutation-testing (temp-password generation, last-global-admin protection). `GET /auth/me` gains its real `teams` array.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL, zod, Node `crypto`, Vitest, Stryker.

**Spec:** `docs/superpowers/specs/2026-07-25-teams-identity-access-control-design.md` (Phase B)

## Global Constraints

Every task's requirements implicitly include this section.

- **Depends hard on plan 056.** `users` and `sessions` must already exist and `0011` must be applied. **Migration-serial:** this plan mints `0012`; do not run it in a parallel worktree with any other plan that generates a migration (`plans/README.md` records three prior collisions of exactly this kind).
- **`projects.team_id` uses `ON DELETE SET NULL`, deliberately breaking the "projects child tables cascade" convention in `AGENTS.md`.** A team is an *organizational* parent, not an ownership parent: deleting a team must never delete project data. Orphaned (`team_id IS NULL`) projects stay visible to global admins only (enforced in plan 058). Every genuinely-owned table here (`team_members`) still cascades.
- **This phase still changes no read scoping.** `ADMIN_TOKEN` continues to drive every admin route; `readAuth` is untouched; no `GET` under `/api/v1` outside `/admin` is added, so `routes-auth-coverage.test.ts` needs **no** edit. Enforcement is plan 058.
- **Temporary passwords are show-once.** The plaintext appears in exactly one API response and is never logged, never re-fetchable, and never stored — only its scrypt hash is. Same contract as project token creation (`routes/admin.ts:270-274`).
- **The last global admin cannot be removed or demoted.** An install with zero global admins is unrecoverable without direct DB access; this is enforced in code and tested.
- **New endpoints follow the API conventions in `AGENTS.md`:** zod-validate every input, apply rate limiting, Drizzle query builder only, update `docs/API.md`, add a route test.
- **New `projects` child tables need `onDelete: 'cascade'`** — `team_members` complies; `projects.team_id` is the documented exception above.
- **Structured logger only.** Never log a temporary password.
- **Commits:** single-line conventional-commit subject; **no `Co-Authored-By` trailers**; never `--no-verify`.

## File Structure

**Create:**
- `apps/api/src/services/auth/membership.ts` — `generateTempPassword`, `canRemoveGlobalAdmin`, `normaliseEmail`, `TEAM_ROLES`.
- `apps/api/src/services/auth/membership.test.ts` — node unit tests.
- `apps/api/src/routes/admin-teams.ts` — team CRUD + membership sub-routes.
- `apps/api/src/routes/admin-teams.test.ts` — route tests.
- `apps/api/src/routes/admin-users.ts` — user CRUD + provisioning.
- `apps/api/src/routes/admin-users.test.ts` — route tests.
- `apps/api/src/db/teams-schema.test.ts` — static schema assertions.
- `apps/api/drizzle/0012_*.sql` — generated, then hand-extended with the backfill.

**Modify:**
- `apps/api/src/db/schema.ts` — add `teams`, `teamMembers`, `projects.teamId`, type exports.
- `apps/api/src/routes/auth.ts` — `GET /me` returns real teams.
- `apps/api/src/routes/auth.test.ts` — assert the populated `teams` array.
- `apps/api/src/routes/admin.ts` — `POST /projects` and `PATCH /projects/:id` accept `teamId`; `GET /projects` returns it.
- `apps/api/src/routes/admin.test.ts` — cover the `teamId` round-trip.
- `apps/api/src/index.ts` — mount the two new routers.
- `scripts/mutation-gate.mjs` — floor for `membership.ts`.
- `docs/API.md`, `docs/GETTING_STARTED.md` — team/user endpoints + the bootstrap procedure.
- `plans/README.md` — plan-057 row.

---

### Task 1: `teams`, `team_members`, `projects.team_id`

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Test: `apps/api/src/db/teams-schema.test.ts` (create)

**Interfaces:**
- Consumes: `users` (plan 056), `projects`.
- Produces: `teams`, `teamMembers` tables; `projects.teamId` column; types `Team`, `NewTeam`, `TeamMember`, `NewTeamMember`.

- [ ] **Step 1: Write the failing schema test**

Create `apps/api/src/db/teams-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { teams, teamMembers, projects } from './schema';

describe('teams schema (plan 057)', () => {
  it('teams.name is unique and not null', () => {
    const name = getTableConfig(teams).columns.find((c) => c.name === 'name')!;
    expect(name.isUnique).toBe(true);
    expect(name.notNull).toBe(true);
  });

  // Regression guard. Plan 056's Task 1 shipped these columns tz-NAIVE by
  // accident — the plan's own code sample had omitted `withTimezone` — and
  // only a review caught it, after the migration had already been generated.
  // `getSQLType()` reflects `withTimezone`, so this assertion bites on the
  // exact mistake rather than on a proxy for it.
  it('teams.created_at and team_members.created_at are timestamptz, not tz-naive', () => {
    const teamCreated = getTableConfig(teams).columns.find((c) => c.name === 'created_at')!;
    const memberCreated = getTableConfig(teamMembers).columns.find((c) => c.name === 'created_at')!;
    expect(teamCreated.getSQLType()).toBe('timestamp with time zone');
    expect(memberCreated.getSQLType()).toBe('timestamp with time zone');
  });

  it('team_members cascades from BOTH parents — a deleted user or team leaves no orphan rows', () => {
    const fks = getTableConfig(teamMembers).foreignKeys;
    expect(fks).toHaveLength(2);
    for (const fk of fks) expect(fk.onDelete).toBe('cascade');
  });

  it('team_members is unique on (user_id, team_id) — a user joins a team at most once', () => {
    const unique = getTableConfig(teamMembers).indexes.find((i) => i.config.unique);
    expect(unique).toBeDefined();
    const cols = unique!.config.columns.map((c) => (c as { name: string }).name);
    expect(cols).toEqual(expect.arrayContaining(['user_id', 'team_id']));
  });

  it('team_members.role is not null', () => {
    const role = getTableConfig(teamMembers).columns.find((c) => c.name === 'role')!;
    expect(role.notNull).toBe(true);
  });

  it('projects.team_id SET NULLs on team delete — deleting a team must never delete project data', () => {
    const fk = getTableConfig(projects).foreignKeys.find((f) =>
      f.reference().foreignTable === teams
    );
    expect(fk, 'projects has no FK to teams').toBeDefined();
    expect(fk!.onDelete).toBe('set null');
  });

  it('projects.team_id is nullable — an orphaned project is a legal state, not a corrupt one', () => {
    const teamId = getTableConfig(projects).columns.find((c) => c.name === 'team_id')!;
    expect(teamId.notNull).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter api exec vitest run src/db/teams-schema.test.ts`
Expected: FAIL — `teams` / `teamMembers` are not exported.

- [ ] **Step 3: Add the tables and the column**

In `apps/api/src/db/schema.ts`, add **above** the `projects` table (Drizzle needs `teams` defined before `projects` references it):

```ts
// Organizational grouping of projects (plan 057 / roadmap #5). A project
// belongs to at most one team; a user belongs to many. This is a single-org
// grouping-and-access-control boundary, NOT hard multi-tenant isolation —
// see the spec's "Scope boundaries" section.
export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).unique().notNull(),
  // `withTimezone` like users/sessions, NOT plain `timestamp` like the older
  // tables. The spec specifies timestamptz for every table in this feature
  // (design doc :111), and plan 056's Task 1 review settled the rule: new
  // tables follow the spec while they are still empty, because switching
  // later means an ALTER against live rows. The pre-existing tables stay
  // timezone-naive; a sweep is a recorded follow-up in plans/README.md.
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
```

Then add to the `projects` table definition, after `gitlabProjectId` (line 8):

```ts
  // Organizational owner. NULLABLE and ON DELETE SET NULL by design — a team
  // is not an ownership parent, so deleting a team orphans its projects
  // rather than destroying them. This deliberately breaks the "projects child
  // tables cascade" convention in AGENTS.md; the convention is about tables
  // that hang OFF a project, and this one hangs off a team. An orphaned
  // project is visible to global admins only (plan 058).
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
```

And add after the `users`/`sessions` tables from plan 056:

```ts
// User <-> team membership, with the per-membership role.
//
// 'team_admin' manages their team's projects (config, rules, token rotation);
// 'member' is read-only within the team. Global admin lives on users, not
// here, because it is not scoped to a team.
export const teamMembers = pgTable('team_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  role: varchar('role', { length: 16 }).notNull(), // team_admin | member
  // timestamptz, for the same reason as `teams.created_at` above.
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userTeamUnique: uniqueIndex('team_members_user_team_unique').on(table.userId, table.teamId),
  teamIdIdx: index('team_members_team_id_idx').on(table.teamId),
  userIdIdx: index('team_members_user_id_idx').on(table.userId),
}));
```

Append the type exports:

```ts
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter api exec vitest run src/db/teams-schema.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/src/db/teams-schema.test.ts
git commit -m "feat(db): teams, team members and projects.team_id"
```

---

### Task 2: migration `0012` with the Default-team backfill

**Files:**
- Create: `apps/api/drizzle/0012_*.sql` (generated, then hand-extended)

**Interfaces:**
- Consumes: the schema from Task 1.
- Produces: an applied migration that leaves **every pre-existing project assigned to a team named `Default`**.

**Why the backfill is hand-written:** `drizzle-kit generate` emits DDL only. Without a data step, every existing project would land with `team_id IS NULL` — which, after plan 058, means *invisible to every non-global-admin*. Silently hiding an operator's projects on upgrade is the single worst outcome available in this whole feature, so the backfill is not optional and is verified by its own test.

- [ ] **Step 1: Generate**

Run: `pnpm --filter api db:generate`
Expected: `apps/api/drizzle/0012_<random-name>.sql` with `CREATE TABLE "teams"`, `CREATE TABLE "team_members"`, `ALTER TABLE "projects" ADD COLUMN "team_id" uuid`, the FKs and the indexes.

Read it. Confirm the projects FK reads `ON DELETE set null` — if it says `cascade`, Task 1's schema edit is wrong; fix it and regenerate rather than patching the SQL.

- [ ] **Step 2: Append the backfill**

Append to the **end** of the generated `0012_*.sql` file:

```sql
--> statement-breakpoint
-- Backfill (plan 057). Every project that existed before teams did is assigned
-- to an auto-created "Default" team, so nothing becomes invisible on upgrade
-- once per-team scoping turns on (plan 058).
--
-- Both statements are idempotent: ON CONFLICT covers a re-run, and the UPDATE
-- only touches rows that are still unassigned.
INSERT INTO "teams" ("name") VALUES ('Default') ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
UPDATE "projects"
   SET "team_id" = (SELECT "id" FROM "teams" WHERE "name" = 'Default')
 WHERE "team_id" IS NULL;
```

The `--> statement-breakpoint` markers are Drizzle's statement separator — the generated file already uses them; match the existing style exactly.

**Edit before first apply, never after.** Drizzle records a hash of each migration file when it applies it; editing an already-applied file leaves the database and the journal disagreeing.

- [ ] **Step 3: Write the backfill test**

Create `apps/api/src/db/backfill-0012.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isNull, eq } from 'drizzle-orm';
import { db, projects, teams } from './index';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('migration 0012 backfill', () => {
  it('created the Default team', async () => {
    const found = await db.select().from(teams).where(eq(teams.name, 'Default'));
    expect(found).toHaveLength(1);
  });

  it('left no project unassigned — an orphan on a fresh upgrade would go invisible in plan 058', async () => {
    const orphans = await db.select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(isNull(projects.teamId));
    expect(
      orphans,
      `these projects have no team and will be invisible to non-admins after plan 058: ` +
        orphans.map((p) => p.name).join(', ')
    ).toEqual([]);
  });
});
```

> **Honest limitation:** this asserts the *post-migration state of the current database*, not that the SQL itself does the backfill. A project created after the migration with an explicit `teamId: null` would red it. That is acceptable — it is a canary for the upgrade path, and the API never creates a project with a null team once Task 6 lands. Do not "fix" it by deleting the assertion.

Add the machine-credential half of the spec's backward-compatibility requirement to the same file — a project that existed before teams must still be able to **ingest** after the migration, because the ingest token is the one credential an operator cannot re-issue without touching every CI pipeline they run:

```ts
import { describe, it, expect, beforeAll } from 'vitest';

const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeMachine = hasDatabase && hasAdminToken ? describe : describe.skip;

let app: typeof import('../index').default;
beforeAll(async () => {
  if (hasDatabase) app = (await import('../index')).default;
});

describeMachine('machine credentials survive migration 0012', () => {
  it('a per-project ingest token still ingests', async () => {
    const created = await (
      await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ name: `machine-${crypto.randomUUID().slice(0, 8)}` }),
      })
    ).json();

    const startTime = new Date().toISOString();
    const res = await app.request('/api/v1/reports', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${created.token}`,
      },
      body: JSON.stringify({
        branch: 'main',
        commitSha: 'b'.repeat(40),
        report: {
          suites: [
            {
              title: 'compat.spec.ts',
              file: 'compat.spec.ts',
              specs: [
                {
                  title: 'still ingests',
                  ok: true,
                  tests: [
                    { results: [{ workerIndex: 0, status: 'passed', duration: 5, retry: 0, startTime }] },
                  ],
                },
              ],
            },
          ],
        },
      }),
    });

    expect(res.status).toBe(201);
  });
});
```

- [ ] **Step 4: Apply and verify**

```bash
docker compose up -d postgres
pnpm db:migrate
pnpm --filter api exec vitest run src/db/backfill-0012.test.ts
```
Expected: migration applies; both tests PASS.

If your local database has no projects, seed one first (`pnpm --filter api db:seed`) and re-run the migration on a **fresh** database — a backfill that is never exercised is not verified:

```bash
docker compose down -v && docker compose up -d postgres
pnpm --filter api db:seed   # NOTE: seed against 0011 first if the seed predates teams
pnpm db:migrate
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/drizzle/ apps/api/src/db/backfill-0012.test.ts
git commit -m "feat(db): migration 0012 with Default-team backfill"
```

---

### Task 3: membership invariants (pure module)

**Files:**
- Create: `apps/api/src/services/auth/membership.ts`
- Test: `apps/api/src/services/auth/membership.test.ts`

**Interfaces:**
- Consumes: nothing (Node `crypto` only).
- Produces:
  - `TEAM_ROLES = ['team_admin', 'member'] as const`; `type TeamRole = 'team_admin' | 'member'`
  - `generateTempPassword(): string` — ≥ `MIN_PASSWORD_LENGTH`, URL-safe, high entropy.
  - `canRemoveGlobalAdmin(currentGlobalAdminCount: number): boolean`
  - `normaliseEmail(email: string): string`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/auth/membership.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MIN_PASSWORD_LENGTH } from './password';
import {
  TEAM_ROLES,
  generateTempPassword,
  canRemoveGlobalAdmin,
  normaliseEmail,
} from './membership';

describe('team roles', () => {
  it('is exactly team_admin and member (global admin lives on users, not memberships)', () => {
    expect([...TEAM_ROLES]).toEqual(['team_admin', 'member']);
  });
});

describe('generateTempPassword', () => {
  it('satisfies the policy it will immediately be checked against', () => {
    expect(generateTempPassword().length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  });

  it('is URL-safe so it survives being copied out of a terminal or a form field', () => {
    expect(generateTempPassword()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('does not repeat', () => {
    const generated = new Set(Array.from({ length: 100 }, generateTempPassword));
    expect(generated.size).toBe(100);
  });
});

describe('canRemoveGlobalAdmin', () => {
  it('refuses when this is the last one — a zero-admin install is unrecoverable', () => {
    expect(canRemoveGlobalAdmin(1)).toBe(false);
  });

  it('refuses on a nonsensical count rather than opening the door', () => {
    expect(canRemoveGlobalAdmin(0)).toBe(false);
  });

  it('allows when another global admin remains', () => {
    expect(canRemoveGlobalAdmin(2)).toBe(true);
  });
});

describe('normaliseEmail', () => {
  it('lower-cases', () => {
    expect(normaliseEmail('Ada@Example.IO')).toBe('ada@example.io');
  });

  it('trims surrounding whitespace (pasted addresses carry it)', () => {
    expect(normaliseEmail('  ada@example.io \n')).toBe('ada@example.io');
  });

  it('leaves an already-normal address alone', () => {
    expect(normaliseEmail('ada@example.io')).toBe('ada@example.io');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/auth/membership.test.ts`
Expected: FAIL — cannot resolve `./membership`.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/auth/membership.ts`:

```ts
import { randomBytes } from 'crypto';

export const TEAM_ROLES = ['team_admin', 'member'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/**
 * A show-once temporary password for an admin-provisioned account.
 *
 * base64url of 18 random bytes = 24 characters, 144 bits — twice the length
 * MIN_PASSWORD_LENGTH demands, and URL-safe so it survives a copy/paste out
 * of a terminal, a form field, or a chat message without escaping surprises.
 */
export function generateTempPassword(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * Guard against removing (or demoting) the final global admin.
 *
 * An install with zero global admins cannot create one back through the API —
 * `POST /admin/users` is itself global-admin-gated — so the only recovery is
 * hand-editing Postgres. Refusing on a count of 0 as well as 1 is deliberate:
 * a count we cannot explain is a reason to stop, not to proceed.
 */
export function canRemoveGlobalAdmin(currentGlobalAdminCount: number): boolean {
  return currentGlobalAdminCount > 1;
}

/** Login identity is case-insensitive and whitespace-insensitive. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter api exec vitest run src/services/auth/membership.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Reuse `normaliseEmail` in the login route**

`routes/auth.ts` (plan 056) inlines `email.trim().toLowerCase()`. Replace it with the imported `normaliseEmail(email)` so provisioning and login cannot ever drift apart in how they normalise.

Run: `pnpm --filter api exec vitest run src/routes/auth.test.ts`
Expected: still PASS (the case-normalisation test covers this).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/auth/membership.ts apps/api/src/services/auth/membership.test.ts apps/api/src/routes/auth.ts
git commit -m "feat(auth): membership invariants and temp-password generation"
```

---

### Task 4: user provisioning API

**Files:**
- Create: `apps/api/src/routes/admin-users.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/routes/admin-users.test.ts`

**Interfaces:**
- Consumes: `hashPassword`, `MIN_PASSWORD_LENGTH` (plan 056); `generateTempPassword`, `canRemoveGlobalAdmin`, `normaliseEmail` (Task 3); `adminRateLimit`, `adminAuth` (existing).
- Produces: default-exported `adminUsersRouter`, mounted at `/api/v1/admin/users`:
  - `GET /` → `{ users: [{ id, email, displayName, isGlobalAdmin, mustChangePassword, createdAt, lastLoginAt, teams: [{ id, name, role }] }] }`
  - `POST /` → `201 { user, temporaryPassword, warning }`
  - `PATCH /:userId` → `{ user }`
  - `POST /:userId/reset-password` → `{ temporaryPassword, warning }`
  - `DELETE /:userId` → `{ success: true }`

- [ ] **Step 1: Write the failing route tests**

Create `apps/api/src/routes/admin-users.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, users, sessions } from '../db';

const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeAdmin = hasDatabase && hasAdminToken ? describe : describe.skip;

let app: typeof import('../index').default;
beforeAll(async () => {
  if (hasDatabase) app = (await import('../index')).default;
});

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
});

const uniqueEmail = () => `admin-users-${crypto.randomUUID()}@example.test`;

async function createUserViaApi(body: Record<string, unknown> = {}) {
  const res = await app.request('/api/v1/admin/users', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ email: uniqueEmail(), displayName: 'Provisioned', ...body }),
  });
  return { res, body: await res.json() };
}

describeAdmin('POST /api/v1/admin/users', () => {
  it('requires an admin token', async () => {
    const res = await app.request('/api/v1/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: uniqueEmail() }),
    });
    expect(res.status).toBe(401);
  });

  it('returns a temporary password exactly once and stores only its hash', async () => {
    const { res, body } = await createUserViaApi();
    expect(res.status).toBe(201);
    expect(typeof body.temporaryPassword).toBe('string');
    expect(body.temporaryPassword.length).toBeGreaterThanOrEqual(12);

    const [row] = await db.select().from(users).where(eq(users.id, body.user.id));
    expect(row.passwordHash).not.toContain(body.temporaryPassword);
    expect(row.passwordHash.startsWith('scrypt$')).toBe(true);
  });

  it('never returns the password hash', async () => {
    const { body } = await createUserViaApi();
    expect(JSON.stringify(body)).not.toContain('scrypt$');
  });

  it('forces a reset on first login', async () => {
    const { body } = await createUserViaApi();
    const [row] = await db.select().from(users).where(eq(users.id, body.user.id));
    expect(row.mustChangePassword).toBe(true);
  });

  it('the temporary password actually logs in', async () => {
    const { body } = await createUserViaApi();
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: body.user.email, password: body.temporaryPassword }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).mustChangePassword).toBe(true);
  });

  it('normalises the email on creation', async () => {
    const email = uniqueEmail().toUpperCase();
    const { body } = await createUserViaApi({ email });
    expect(body.user.email).toBe(email.toLowerCase());
  });

  it('409s on a duplicate email regardless of case', async () => {
    const email = uniqueEmail();
    await createUserViaApi({ email });
    const { res } = await createUserViaApi({ email: email.toUpperCase() });
    expect(res.status).toBe(409);
  });

  it('creates a non-admin by default', async () => {
    const { body } = await createUserViaApi();
    expect(body.user.isGlobalAdmin).toBe(false);
  });

  it('can create a global admin on request', async () => {
    const { body } = await createUserViaApi({ isGlobalAdmin: true });
    expect(body.user.isGlobalAdmin).toBe(true);
  });

  it('400s on an invalid email', async () => {
    const res = await app.request('/api/v1/admin/users', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ email: 'nope' }),
    });
    expect(res.status).toBe(400);
  });
});

describeAdmin('POST /api/v1/admin/users/:userId/reset-password', () => {
  it('issues a new temp password, forces a reset, and kills every live session', async () => {
    const { body } = await createUserViaApi();
    const userId = body.user.id;

    // Sign in so there is a session to kill.
    await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: body.user.email, password: body.temporaryPassword }),
    });
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).not.toHaveLength(0);

    const res = await app.request(`/api/v1/admin/users/${userId}/reset-password`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const reset = await res.json();
    expect(reset.temporaryPassword).not.toBe(body.temporaryPassword);

    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row.mustChangePassword).toBe(true);
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(0);

    // The old password no longer works; the new one does.
    const old = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: body.user.email, password: body.temporaryPassword }),
    });
    expect(old.status).toBe(401);
  });

  it('404s for an unknown user', async () => {
    const res = await app.request(`/api/v1/admin/users/${crypto.randomUUID()}/reset-password`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

describeAdmin('PATCH /api/v1/admin/users/:userId', () => {
  it('updates the display name', async () => {
    const { body } = await createUserViaApi();
    const res = await app.request(`/api/v1/admin/users/${body.user.id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ displayName: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).user.displayName).toBe('Renamed');
  });

  it('refuses to demote the last global admin', async () => {
    // Ensure exactly one global admin exists for this assertion.
    const admins = await db.select().from(users).where(eq(users.isGlobalAdmin, true));
    for (const extra of admins.slice(1)) {
      await db.update(users).set({ isGlobalAdmin: false }).where(eq(users.id, extra.id));
    }
    const [onlyAdmin] = admins.length
      ? admins
      : [(await createUserViaApi({ isGlobalAdmin: true })).body.user];

    const res = await app.request(`/api/v1/admin/users/${onlyAdmin.id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ isGlobalAdmin: false }),
    });
    expect(res.status).toBe(409);

    const [after] = await db.select().from(users).where(eq(users.id, onlyAdmin.id));
    expect(after.isGlobalAdmin).toBe(true);
  });
});

describeAdmin('DELETE /api/v1/admin/users/:userId', () => {
  it('deletes the user and cascades their sessions', async () => {
    const { body } = await createUserViaApi();
    await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: body.user.email, password: body.temporaryPassword }),
    });

    const res = await app.request(`/api/v1/admin/users/${body.user.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(await db.select().from(users).where(eq(users.id, body.user.id))).toHaveLength(0);
    expect(await db.select().from(sessions).where(eq(sessions.userId, body.user.id))).toHaveLength(0);
  });

  it('refuses to delete the last global admin', async () => {
    const admins = await db.select().from(users).where(eq(users.isGlobalAdmin, true));
    for (const extra of admins.slice(1)) {
      await db.update(users).set({ isGlobalAdmin: false }).where(eq(users.id, extra.id));
    }
    const [onlyAdmin] = admins.length
      ? admins
      : [(await createUserViaApi({ isGlobalAdmin: true })).body.user];

    const res = await app.request(`/api/v1/admin/users/${onlyAdmin.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(res.status).toBe(409);
    expect(await db.select().from(users).where(eq(users.id, onlyAdmin.id))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/admin-users.test.ts`
Expected: FAIL — every request 404s.

- [ ] **Step 3: Implement the router**

Create `apps/api/src/routes/admin-users.ts`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq, and, count } from 'drizzle-orm';
import { db, users, teams, teamMembers, sessions } from '../db';
import { logger } from '../middleware/logger';
import { adminRateLimit } from '../middleware/rate-limit';
import { adminAuth } from '../middleware/auth';
import { hashPassword } from '../services/auth/password';
import { generateTempPassword, canRemoveGlobalAdmin, normaliseEmail } from '../services/auth/membership';

const adminUsersRouter = new Hono();

// Own limiter + gate: this is a separate Hono instance from routes/admin.ts,
// so it does NOT inherit that router's `use('*', ...)` middleware. Mounting a
// sibling router and forgetting these two lines would publish user
// provisioning unauthenticated. Guarded by the "requires an admin token" test
// in the suite for this file.
adminUsersRouter.use('*', adminRateLimit);
adminUsersRouter.use('*', adminAuth());

const uuidSchema = z.string().uuid();

const createUserSchema = z.object({
  email: z.string().email().max(255),
  displayName: z.string().max(255).optional(),
  isGlobalAdmin: z.boolean().optional().default(false),
});

const patchUserSchema = z.object({
  displayName: z.string().max(255).nullable().optional(),
  isGlobalAdmin: z.boolean().optional(),
});

function publicUser(u: {
  id: string;
  email: string;
  displayName: string | null;
  isGlobalAdmin: boolean;
  mustChangePassword: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
}) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    isGlobalAdmin: u.isGlobalAdmin,
    mustChangePassword: u.mustChangePassword,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

async function globalAdminCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users).where(eq(users.isGlobalAdmin, true));
  return Number(row?.n ?? 0);
}

/**
 * GET /api/v1/admin/users
 */
adminUsersRouter.get('/', async (c) => {
  const rows = await db.select().from(users).orderBy(users.email);

  const memberships = await db
    .select({
      userId: teamMembers.userId,
      teamId: teams.id,
      teamName: teams.name,
      role: teamMembers.role,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id));

  const byUser = new Map<string, { id: string; name: string; role: string }[]>();
  for (const m of memberships) {
    const list = byUser.get(m.userId) ?? [];
    list.push({ id: m.teamId, name: m.teamName, role: m.role });
    byUser.set(m.userId, list);
  }

  return c.json({
    users: rows.map((u) => ({ ...publicUser(u), teams: byUser.get(u.id) ?? [] })),
  });
});

/**
 * POST /api/v1/admin/users
 *
 * Provisions an account with a SHOW-ONCE temporary password. The plaintext is
 * in this response and nowhere else — not in the database, not in the log.
 * Same contract as project-token creation.
 */
adminUsersRouter.post('/', zValidator('json', createUserSchema), async (c) => {
  const { email, displayName, isGlobalAdmin } = c.req.valid('json');
  const normalisedEmail = normaliseEmail(email);

  const existing = await db.query.users.findFirst({ where: eq(users.email, normalisedEmail) });
  if (existing) {
    return c.json({ error: 'A user with this email already exists' }, 409);
  }

  const temporaryPassword = generateTempPassword();
  const [user] = await db
    .insert(users)
    .values({
      email: normalisedEmail,
      passwordHash: await hashPassword(temporaryPassword),
      displayName: displayName ?? null,
      isGlobalAdmin,
      mustChangePassword: true,
    })
    .returning();

  logger.info('User provisioned', {
    userId: user.id,
    isGlobalAdmin,
    requestId: c.get('requestId'),
  });

  return c.json({
    user: publicUser(user),
    temporaryPassword, // Only returned on creation!
    warning: 'Save this password securely. It will not be shown again. The user must change it on first sign-in.',
  }, 201);
});

/**
 * PATCH /api/v1/admin/users/:userId
 */
adminUsersRouter.patch('/:userId', zValidator('json', patchUserSchema), async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('userId'));
  if (!parsed.success) return c.json({ error: 'Invalid user ID format' }, 400);

  const body = c.req.valid('json');
  const user = await db.query.users.findFirst({ where: eq(users.id, parsed.data) });
  if (!user) return c.json({ error: 'User not found' }, 404);

  if (body.isGlobalAdmin === false && user.isGlobalAdmin) {
    if (!canRemoveGlobalAdmin(await globalAdminCount())) {
      return c.json({ error: 'Cannot demote the last global admin' }, 409);
    }
  }

  const columns: Partial<typeof users.$inferInsert> = {};
  if ('displayName' in body) columns.displayName = body.displayName ?? null;
  if ('isGlobalAdmin' in body && body.isGlobalAdmin !== undefined) {
    columns.isGlobalAdmin = body.isGlobalAdmin;
  }

  const [updated] = await db.update(users).set(columns).where(eq(users.id, user.id)).returning();
  logger.info('User updated', { userId: user.id, requestId: c.get('requestId') });
  return c.json({ user: publicUser(updated) });
});

/**
 * POST /api/v1/admin/users/:userId/reset-password
 *
 * Revokes every live session: an admin resetting a password is very often
 * responding to a compromise, and leaving the attacker's session alive would
 * make the reset cosmetic.
 */
adminUsersRouter.post('/:userId/reset-password', async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('userId'));
  if (!parsed.success) return c.json({ error: 'Invalid user ID format' }, 400);

  const user = await db.query.users.findFirst({ where: eq(users.id, parsed.data) });
  if (!user) return c.json({ error: 'User not found' }, 404);

  const temporaryPassword = generateTempPassword();
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true })
    .where(eq(users.id, user.id));
  await db.delete(sessions).where(eq(sessions.userId, user.id));

  logger.info('User password reset by admin', { userId: user.id, requestId: c.get('requestId') });

  return c.json({
    temporaryPassword,
    warning: 'Save this password securely. It will not be shown again. All of this user\'s sessions have been revoked.',
  });
});

/**
 * DELETE /api/v1/admin/users/:userId
 *
 * Sessions and team memberships cascade (schema.ts).
 */
adminUsersRouter.delete('/:userId', async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('userId'));
  if (!parsed.success) return c.json({ error: 'Invalid user ID format' }, 400);

  const user = await db.query.users.findFirst({ where: eq(users.id, parsed.data) });
  if (!user) return c.json({ error: 'User not found' }, 404);

  if (user.isGlobalAdmin && !canRemoveGlobalAdmin(await globalAdminCount())) {
    return c.json({ error: 'Cannot delete the last global admin' }, 409);
  }

  await db.delete(users).where(eq(users.id, user.id));
  logger.info('User deleted', { userId: user.id, requestId: c.get('requestId') });
  return c.json({ success: true });
});

export default adminUsersRouter;
```

- [ ] **Step 4: Mount it**

In `apps/api/src/index.ts`, beside the other route imports and mounts:

```ts
import adminUsersRouter from './routes/admin-users';
// …
app.route('/api/v1/admin/users', adminUsersRouter);
```

**Mount it BEFORE `app.route('/api/v1/admin', adminRouter)`** so the more specific path is matched first. Verify by running the suite — if `GET /api/v1/admin/users` returns the project list, the ordering is wrong.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter api exec vitest run src/routes/admin-users.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/admin-users.ts apps/api/src/routes/admin-users.test.ts apps/api/src/index.ts
git commit -m "feat(api): admin user provisioning with show-once temp passwords"
```

---

### Task 5: team & membership CRUD API

**Files:**
- Create: `apps/api/src/routes/admin-teams.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/routes/admin-teams.test.ts`

**Interfaces:**
- Consumes: `TEAM_ROLES` (Task 3); `adminRateLimit`, `adminAuth`.
- Produces: default-exported `adminTeamsRouter`, mounted at `/api/v1/admin/teams`:
  - `GET /` → `{ teams: [{ id, name, createdAt, memberCount, projectCount }] }`
  - `POST /` `{ name }` → `201 { team }`
  - `PATCH /:teamId` `{ name }` → `{ team }`
  - `DELETE /:teamId` → `{ success: true, orphanedProjects: number }`
  - `GET /:teamId/members` → `{ members: [{ userId, email, displayName, role }] }`
  - `POST /:teamId/members` `{ userId, role }` → `201 { member }`
  - `PATCH /:teamId/members/:userId` `{ role }` → `{ member }`
  - `DELETE /:teamId/members/:userId` → `{ success: true }`

- [ ] **Step 1: Write the failing route tests**

Create `apps/api/src/routes/admin-teams.test.ts`. Cover, at minimum:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, teams, teamMembers, projects } from '../db';

const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeAdmin = hasDatabase && hasAdminToken ? describe : describe.skip;

let app: typeof import('../index').default;
beforeAll(async () => {
  if (hasDatabase) app = (await import('../index')).default;
});

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
});

const uniqueName = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

async function createTeam(name = uniqueName('team')) {
  const res = await app.request('/api/v1/admin/teams', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name }),
  });
  return { res, body: await res.json() };
}

async function createUser() {
  const res = await app.request('/api/v1/admin/users', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ email: `member-${crypto.randomUUID()}@example.test` }),
  });
  return (await res.json()).user;
}

describeAdmin('team CRUD', () => {
  it('requires an admin token', async () => {
    const res = await app.request('/api/v1/admin/teams', { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('creates a team', async () => {
    const { res, body } = await createTeam();
    expect(res.status).toBe(201);
    expect(body.team.id).toBeTruthy();
  });

  it('409s on a duplicate name', async () => {
    const name = uniqueName('dup');
    await createTeam(name);
    const { res } = await createTeam(name);
    expect(res.status).toBe(409);
  });

  it('400s on an empty name', async () => {
    const res = await app.request('/api/v1/admin/teams', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('lists teams with member and project counts', async () => {
    const { body: created } = await createTeam();
    const user = await createUser();
    await app.request(`/api/v1/admin/teams/${created.team.id}/members`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId: user.id, role: 'member' }),
    });

    const res = await app.request('/api/v1/admin/teams', { headers: authHeaders() });
    const listed = (await res.json()).teams.find((t: { id: string }) => t.id === created.team.id);
    expect(listed.memberCount).toBe(1);
    expect(listed.projectCount).toBe(0);
  });

  it('renames a team', async () => {
    const { body } = await createTeam();
    const next = uniqueName('renamed');
    const res = await app.request(`/api/v1/admin/teams/${body.team.id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ name: next }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).team.name).toBe(next);
  });

  it('404s for an unknown team', async () => {
    const res = await app.request(`/api/v1/admin/teams/${crypto.randomUUID()}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ name: uniqueName('x') }),
    });
    expect(res.status).toBe(404);
  });
});

describeAdmin('DELETE /api/v1/admin/teams/:teamId', () => {
  it('ORPHANS its projects instead of deleting them, and reports how many', async () => {
    const { body: team } = await createTeam();

    const projectRes = await app.request('/api/v1/admin/projects', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: uniqueName('proj'), teamId: team.team.id }),
    });
    const projectId = (await projectRes.json()).project.id;

    const res = await app.request(`/api/v1/admin/teams/${team.team.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).orphanedProjects).toBe(1);

    // The project survives, unowned. This is THE load-bearing assertion of the
    // SET NULL decision — if it ever flips to cascade, this test is what says so.
    const [survivor] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(survivor).toBeDefined();
    expect(survivor.teamId).toBeNull();
  });

  it('cascades its memberships', async () => {
    const { body: team } = await createTeam();
    const user = await createUser();
    await app.request(`/api/v1/admin/teams/${team.team.id}/members`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId: user.id, role: 'member' }),
    });

    await app.request(`/api/v1/admin/teams/${team.team.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });

    const left = await db.select().from(teamMembers).where(eq(teamMembers.teamId, team.team.id));
    expect(left).toHaveLength(0);
  });
});

describeAdmin('membership sub-routes', () => {
  it('adds a member with a role', async () => {
    const { body: team } = await createTeam();
    const user = await createUser();
    const res = await app.request(`/api/v1/admin/teams/${team.team.id}/members`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId: user.id, role: 'team_admin' }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).member.role).toBe('team_admin');
  });

  it('rejects an unknown role', async () => {
    const { body: team } = await createTeam();
    const user = await createUser();
    const res = await app.request(`/api/v1/admin/teams/${team.team.id}/members`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId: user.id, role: 'superuser' }),
    });
    expect(res.status).toBe(400);
  });

  it('409s when the user is already a member (the unique index, surfaced honestly)', async () => {
    const { body: team } = await createTeam();
    const user = await createUser();
    const add = () =>
      app.request(`/api/v1/admin/teams/${team.team.id}/members`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ userId: user.id, role: 'member' }),
      });
    expect((await add()).status).toBe(201);
    expect((await add()).status).toBe(409);
  });

  it('404s when adding an unknown user', async () => {
    const { body: team } = await createTeam();
    const res = await app.request(`/api/v1/admin/teams/${team.team.id}/members`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId: crypto.randomUUID(), role: 'member' }),
    });
    expect(res.status).toBe(404);
  });

  it('changes a role', async () => {
    const { body: team } = await createTeam();
    const user = await createUser();
    await app.request(`/api/v1/admin/teams/${team.team.id}/members`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId: user.id, role: 'member' }),
    });
    const res = await app.request(`/api/v1/admin/teams/${team.team.id}/members/${user.id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ role: 'team_admin' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).member.role).toBe('team_admin');
  });

  it('removes a member without deleting the user', async () => {
    const { body: team } = await createTeam();
    const user = await createUser();
    await app.request(`/api/v1/admin/teams/${team.team.id}/members`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId: user.id, role: 'member' }),
    });
    const res = await app.request(`/api/v1/admin/teams/${team.team.id}/members/${user.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);

    const memberships = await db.select().from(teamMembers).where(eq(teamMembers.userId, user.id));
    expect(memberships).toHaveLength(0);

    const stillListed = await app.request('/api/v1/admin/users', { headers: authHeaders() });
    const found = (await stillListed.json()).users.find((u: { id: string }) => u.id === user.id);
    expect(found).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/admin-teams.test.ts`
Expected: FAIL (404s everywhere).

- [ ] **Step 3: Implement the router**

Create `apps/api/src/routes/admin-teams.ts` following the same skeleton as `admin-users.ts` (own `adminRateLimit` + `adminAuth()` mounted on `*`, zod schemas, uuid parsing, `logger.info` on every mutation). The pieces that carry real decisions:

```ts
const createTeamSchema = z.object({ name: z.string().min(1).max(255) });
const patchTeamSchema = z.object({ name: z.string().min(1).max(255) });
const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(TEAM_ROLES),
});
const patchMemberSchema = z.object({ role: z.enum(TEAM_ROLES) });
```

The list route's counts, as subqueries (mirroring `admin.ts:190-198`, which is the established no-N+1 pattern in this codebase):

```ts
adminTeamsRouter.get('/', async (c) => {
  const rows = await db
    .select({
      id: teams.id,
      name: teams.name,
      createdAt: teams.createdAt,
      memberCount: sql<number>`coalesce((
        select count(*)::int from team_members where team_members.team_id = ${teams.id}
      ), 0)`,
      projectCount: sql<number>`coalesce((
        select count(*)::int from projects where projects.team_id = ${teams.id}
      ), 0)`,
    })
    .from(teams)
    .orderBy(teams.name);

  return c.json({ teams: rows });
});
```

The delete route, which must report the blast radius:

```ts
adminTeamsRouter.delete('/:teamId', async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('teamId'));
  if (!parsed.success) return c.json({ error: 'Invalid team ID format' }, 400);

  const team = await db.query.teams.findFirst({ where: eq(teams.id, parsed.data) });
  if (!team) return c.json({ error: 'Team not found' }, 404);

  // Counted BEFORE the delete: afterwards the FK has already SET NULL these
  // rows and they are indistinguishable from projects that were never owned.
  const [{ n }] = await db
    .select({ n: count() })
    .from(projects)
    .where(eq(projects.teamId, team.id));

  await db.delete(teams).where(eq(teams.id, team.id));

  logger.warn('Team deleted', {
    teamId: team.id,
    teamName: team.name,
    orphanedProjects: Number(n),
    requestId: c.get('requestId'),
  });

  // Projects are NOT deleted — the FK is ON DELETE SET NULL. They become
  // orphans, visible to global admins only (plan 058), until reassigned.
  return c.json({ success: true, orphanedProjects: Number(n) });
});
```

The add-member route needs the FK-existence check and the duplicate check to be **explicit**, so both produce a purposeful status instead of a 500 from the database:

```ts
adminTeamsRouter.post('/:teamId/members', zValidator('json', addMemberSchema), async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('teamId'));
  if (!parsed.success) return c.json({ error: 'Invalid team ID format' }, 400);
  const { userId, role } = c.req.valid('json');

  const team = await db.query.teams.findFirst({ where: eq(teams.id, parsed.data) });
  if (!team) return c.json({ error: 'Team not found' }, 404);

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return c.json({ error: 'User not found' }, 404);

  const existing = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, userId)),
  });
  if (existing) return c.json({ error: 'User is already a member of this team' }, 409);

  const [member] = await db
    .insert(teamMembers)
    .values({ teamId: team.id, userId, role })
    .returning();

  logger.info('Team member added', { teamId: team.id, userId, role, requestId: c.get('requestId') });
  return c.json({ member }, 201);
});
```

Write `GET /:teamId/members`, `PATCH /:teamId/members/:userId` and `DELETE /:teamId/members/:userId` to the same shape: parse the uuid → 400, load and 404, act, log, return.

- [ ] **Step 4: Mount it**

In `apps/api/src/index.ts`, before the `/api/v1/admin` mount:

```ts
import adminTeamsRouter from './routes/admin-teams';
// …
app.route('/api/v1/admin/teams', adminTeamsRouter);
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter api exec vitest run src/routes/admin-teams.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/admin-teams.ts apps/api/src/routes/admin-teams.test.ts apps/api/src/index.ts
git commit -m "feat(api): team and membership admin CRUD"
```

---

### Task 6: assign projects to teams

**Files:**
- Modify: `apps/api/src/routes/admin.ts` (`GET /projects` :172, `POST /projects` :234, `PATCH /projects/:id` :330)
- Test: `apps/api/src/routes/admin.test.ts` (extend)

**Interfaces:**
- Consumes: `teams` table.
- Produces: `teamId` accepted on create and patch, returned on list.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/admin.test.ts`, inside the admin describe block:

```ts
  it('creates a project assigned to a team', async () => {
    const teamRes = await app.request('/api/v1/admin/teams', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: `assign-${crypto.randomUUID().slice(0, 8)}` }),
    });
    const teamId = (await teamRes.json()).team.id;

    const res = await app.request('/api/v1/admin/projects', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: `p-${crypto.randomUUID().slice(0, 8)}`, teamId }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).project.teamId).toBe(teamId);
  });

  it('400s on a teamId that does not exist (rather than a 500 from the FK)', async () => {
    const res = await app.request('/api/v1/admin/projects', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: `p-${crypto.randomUUID().slice(0, 8)}`, teamId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(400);
  });

  it('reassigns a project to another team via PATCH', async () => {
    const makeTeam = async () => {
      const res = await app.request('/api/v1/admin/teams', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: `re-${crypto.randomUUID().slice(0, 8)}` }),
      });
      return (await res.json()).team.id;
    };
    const teamA = await makeTeam();
    const teamB = await makeTeam();

    const created = await app.request('/api/v1/admin/projects', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: `p-${crypto.randomUUID().slice(0, 8)}`, teamId: teamA }),
    });
    const projectId = (await created.json()).project.id;

    const res = await app.request(`/api/v1/admin/projects/${projectId}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ teamId: teamB }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(row.teamId).toBe(teamB);
  });

  it('unassigns a project when teamId is explicitly null', async () => {
    const teamRes = await app.request('/api/v1/admin/teams', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: `un-${crypto.randomUUID().slice(0, 8)}` }),
    });
    const teamId = (await teamRes.json()).team.id;

    const created = await app.request('/api/v1/admin/projects', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: `p-${crypto.randomUUID().slice(0, 8)}`, teamId }),
    });
    const projectId = (await created.json()).project.id;

    const res = await app.request(`/api/v1/admin/projects/${projectId}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ teamId: null }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(row.teamId).toBeNull();
  });

  it('returns teamId in the admin project list', async () => {
    const teamRes = await app.request('/api/v1/admin/teams', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: `list-${crypto.randomUUID().slice(0, 8)}` }),
    });
    const teamId = (await teamRes.json()).team.id;

    const created = await app.request('/api/v1/admin/projects', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: `p-${crypto.randomUUID().slice(0, 8)}`, teamId }),
    });
    const projectId = (await created.json()).project.id;

    const list = await app.request('/api/v1/admin/projects', { headers: authHeaders() });
    const found = (await list.json()).projects.find((p: { id: string }) => p.id === projectId);
    expect(found.teamId).toBe(teamId);
  });
```

This suite needs `projects` and `eq` — add them to the existing `../db` and `drizzle-orm` imports at the top of `admin.test.ts` if they are not already there.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter api exec vitest run src/routes/admin.test.ts`
Expected: FAIL — `teamId` is not accepted or returned.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/admin.ts`:

1. Add `teamId: z.string().uuid().optional()` to `createProjectSchema` (:23).
2. Add `teamId: z.string().uuid().nullable().optional()` to `projectConfigPatchSchema` (:28). Blank/`null` means "unassigned", consistent with the "blank ⇒ null ⇒ default" convention used by every other field on that route.
3. Add a shared existence check, used by both handlers:

```ts
/**
 * Resolve a supplied teamId, or 400.
 *
 * Without this, an unknown teamId reaches Postgres and comes back as an FK
 * violation — a 500 that tells the operator "internal server error" for what
 * is plainly their typo.
 */
async function assertTeamExists(teamId: string): Promise<boolean> {
  return !!(await db.query.teams.findFirst({ where: eq(teams.id, teamId) }));
}
```

4. In `POST /projects`, after the name-conflict check:

```ts
    if (teamId && !(await assertTeamExists(teamId))) {
      return c.json({ error: 'Team not found' }, 400);
    }
```
and add `teamId: teamId ?? null` to the `.values({...})` and `teamId: projects.teamId` to the `.returning({...})`.

5. In `PATCH /projects/:id`, run the same check when `teamId` is a non-null string, and map `teamId` into the update columns (`columns.teamId = body.teamId ?? null`).
6. In `GET /projects`, add `teamId: projects.teamId` to the select and to the mapped result object.

Import `teams` from `../db` at the top of the file.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter api exec vitest run src/routes/admin.test.ts`
Expected: PASS (the whole suite, not just the new tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin.ts apps/api/src/routes/admin.test.ts
git commit -m "feat(api): assign projects to teams on create and patch"
```

---

### Task 7: populate `teams` in `GET /auth/me`

**Files:**
- Modify: `apps/api/src/routes/auth.ts`
- Test: `apps/api/src/routes/auth.test.ts` (extend)

**Interfaces:**
- Consumes: `teamMembers`, `teams`.
- Produces: `GET /me` → `{ user, teams: [{ id, name, role }] }` — same shape plan 056 stubbed, now real. This is the dashboard's source of truth for scoping its UI (plan 059).

- [ ] **Step 1: Write the failing test**

Replace the plan-056 assertion `expect(body.teams).toEqual([])` in `auth.test.ts` with real coverage:

```ts
  it('returns the user\'s teams and per-team roles', async () => {
    const user = await createUser();
    const teamRes = await app.request('/api/v1/admin/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
      body: JSON.stringify({ name: `me-${crypto.randomUUID().slice(0, 8)}` }),
    });
    const team = (await teamRes.json()).team;

    await app.request(`/api/v1/admin/teams/${team.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
      body: JSON.stringify({ userId: user.id, role: 'team_admin' }),
    });

    const cookie = sessionCookieFrom(await login(user.email))!;
    const res = await app.request('/api/v1/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });

    expect((await res.json()).teams).toEqual([{ id: team.id, name: team.name, role: 'team_admin' }]);
  });

  it('returns an empty team list for a user in no team (not an error)', async () => {
    const user = await createUser();
    const cookie = sessionCookieFrom(await login(user.email))!;
    const res = await app.request('/api/v1/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).teams).toEqual([]);
  });
```

This suite now needs `ADMIN_TOKEN`; change its guard to `const describeAuth = hasDatabase && hasAdminToken ? describe : describe.skip;` and add the `hasAdminToken` constant, matching `admin.test.ts:6-8`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/auth.test.ts`
Expected: FAIL — `teams` is `[]` for a user who is in a team.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/auth.ts`, replace the hardcoded empty array in `GET /me`:

```ts
  const memberships = await db
    .select({ id: teams.id, name: teams.name, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, sessionUser.id))
    .orderBy(teams.name);

  return c.json({
    user: {
      ...publicUser(sessionUser),
      mustChangePassword: sessionUser.mustChangePassword,
    },
    teams: memberships,
  });
```

Add `teams, teamMembers` to the `../db` import.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter api exec vitest run src/routes/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/src/routes/auth.test.ts
git commit -m "feat(auth): return the caller's teams and roles from /auth/me"
```

---

### Task 8: mutation floor, docs, bootstrap procedure

**Files:**
- Modify: `scripts/mutation-gate.mjs`, `docs/API.md`, `docs/GETTING_STARTED.md`, `plans/README.md`

- [ ] **Step 1: Calibrate the `membership.ts` floor**

Same procedure as plan 056, Task 8:

```bash
docker run --rm -d --name stryker-pg -e POSTGRES_PASSWORD=stryker -p 55432:5432 postgres:17
cd apps/api
DATABASE_URL=postgres://postgres:stryker@localhost:55432/postgres \
  pnpm exec stryker run --mutate 'src/services/auth/membership.ts'
```

Run twice, take the lower score, add the row to `HARDENED` in `scripts/mutation-gate.mjs` with `floor = floor(reliableLow) - 5` and a `// baseline: <score>% (plan 057)` comment. Then `docker rm -f stryker-pg`.

- [ ] **Step 2: Document the endpoints in `docs/API.md`**

Extend the `## Admin Endpoints` section with `### Teams`, `### Team Membership` and `### Users` subsections in the existing house style (request/response bodies, status codes, `curl`). State explicitly on the delete-team entry:

```markdown
Deleting a team does **not** delete its projects. They become unassigned
(`teamId: null`) and, once per-team access control is enabled (plan 058), are
visible to global admins only until reassigned. The response reports how many
projects were orphaned.
```

- [ ] **Step 3: Document the bootstrap in `docs/GETTING_STARTED.md`**

Add a section — this is the procedure that makes the whole feature usable, and it is the one thing an upgrading operator cannot guess:

````markdown
### Creating your first user account

After running the migrations, create the first global admin with your
`ADMIN_TOKEN`. There is no seeded account and no self-signup — deliberately:
a migration that plants a default password is a migration that ships one to
everybody.

```bash
curl -X POST http://localhost:8080/api/v1/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","displayName":"Your Name","isGlobalAdmin":true}'
```

The response contains a **temporary password shown exactly once**. Save it, then
sign in — you will be required to change it immediately.

`ADMIN_TOKEN` remains valid as a break-glass machine credential; user accounts
do not replace it.
````

- [ ] **Step 4: Add the plan row to `plans/README.md`**

```markdown
| 057 | Roadmap #5+#6 Phase B: teams & membership — `teams` + `team_members` + `projects.team_id` (migration `0012`, Default-team backfill so nothing goes invisible on upgrade), admin team/membership CRUD, user provisioning with show-once temp passwords, last-global-admin protection, real `teams` in `GET /auth/me`. **Still no read-scoping change** | P2 | M | **056 (hard — needs `users`; migration-serial)** | TODO |
```

- [ ] **Step 5: Full verification**

```bash
pnpm lint
pnpm --filter api exec tsc --noEmit
pnpm --filter api test          # with DATABASE_URL and ADMIN_TOKEN set
node scripts/mutation-gate.mjs  # against a fresh report
```

- [ ] **Step 6: Commit**

```bash
git add scripts/mutation-gate.mjs docs/API.md docs/GETTING_STARTED.md plans/README.md
git commit -m "docs(api): teams, membership and user provisioning"
```

---

## Definition of done

- [ ] Migration `0012` applies on top of `0011` and leaves **zero** projects with `team_id IS NULL` on a database that had projects before it ran.
- [ ] Deleting a team leaves its projects intact and unassigned — proven by an assertion that reads the surviving row, not just the response body.
- [ ] The last global admin can be neither deleted nor demoted.
- [ ] A provisioned user's temp password logs in once, forces a reset, and never appears in the database or the logs.
- [ ] `routes-auth-coverage.test.ts` is **unchanged** and still green (this phase adds no non-admin `GET`).
- [ ] `pnpm lint`, `tsc --noEmit`, the full API suite (with a database), and the mutation gate all pass.

## Follow-ups this plan deliberately does not do

- **Membership still grants nothing.** A `member` of a team sees exactly what an anonymous caller sees — plan 058 is what makes roles bite. Do not add scoping here; splitting "model the data" from "enforce on it" is what makes 058 reviewable.
- **No dashboard UI** for teams or users — plan 059.
- **No per-user audit trail** (spec §Scope boundaries): `quarantine_events` is unchanged, and user-action auditing stays out of scope.
