import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { db, users, teams, teamMembers } from '../db';
import { logger } from '../middleware/logger';
import { adminRateLimit } from '../middleware/rate-limit';
import { adminOrGlobalAdminAuth } from '../middleware/auth';
import { passwordChangeGate } from '../middleware/password-change';
import { getAccess } from '../middleware/access';
import { canAdministerTeams } from '../services/auth/access';
import { revokeAllUserSessions } from '../middleware/session';
import { hashPassword } from '../services/auth/password';
import { generateTempPassword, canRemoveGlobalAdmin, normaliseEmail } from '../services/auth/membership';

const adminUsersRouter = new Hono<{ Variables: { requestId: string } }>();

// Own limiter + gate: this is a separate Hono instance from routes/admin.ts,
// so it does NOT inherit that router's `use('*', ...)` middleware. Mounting a
// sibling router and forgetting these two lines would publish user
// provisioning unauthenticated. Guarded by the "requires an admin token" test
// in the suite for this file.
adminUsersRouter.use('*', adminRateLimit);
adminUsersRouter.use('*', passwordChangeGate());
adminUsersRouter.use('*', adminOrGlobalAdminAuth());

// User CRUD is never delegated to a team_admin — adminOrGlobalAdminAuth()
// alone admits them (they belong on the wider admin API surface for their
// own project routes), so this second gate closes user provisioning back
// down to global-admin only, for every route on this router.
adminUsersRouter.use('*', async (c, next) => {
  if (!canAdministerTeams(getAccess(c))) {
    return c.json({ error: 'Global admin required' }, 403);
  }
  await next();
});

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

/**
 * Serialises the two paths that can REMOVE a global admin — the demote
 * branch of `PATCH /:userId` and `DELETE /:userId` — so that a count-check
 * and its write are atomic against each other. See the block comment below
 * for the full rationale.
 *
 * Deliberately distinct from `GLOBAL_ADMIN_LOCK_KEY` (958_304_501) in
 * `src/test-support/advisory-lock.ts`. That one is a TEST-suite,
 * session-level lock used to park the ambient global-admin set while a
 * fixture runs; this one is a production, transaction-scoped mutex. They sit
 * next to each other in the key space so they are easy to find together, but
 * they must never be the same value — sharing a key would make every user
 * deletion in production block on a test fixture, and vice versa.
 *
 * Exported so the suite can assert this exact key is held while a removal is
 * in flight (`pg_locks`), rather than re-declaring the magic number.
 */
export const GLOBAL_ADMIN_MUTEX = 958_304_502;

// Last-global-admin guard (plan 058 Global Constraint: "the last-admin
// guard's TOCTOU must be closed in the SAME change that strips ADMIN_TOKEN
// of superuser status"). Reaching zero global admins is unrecoverable
// through the API on a token-less install — a supported deployment shape
// since Task 5 removed adminAuth()'s 500 on an unset ADMIN_TOKEN — so the
// count-check and the write must be atomic with respect to every OTHER path
// that can remove a global admin.
//
// There are exactly two such paths: the demote branch of `PATCH /:userId`
// and `DELETE /:userId` (nothing else in the codebase clears
// `is_global_admin` or deletes a user row). They serialise against each
// other on ONE transaction-scoped advisory lock, GLOBAL_ADMIN_MUTEX, taken
// as the first statement inside the transaction. `pg_advisory_xact_lock`
// releases automatically at COMMIT or ROLLBACK — never hand-unlock it, and
// never use the session-level `pg_advisory_lock` here, which would leak onto
// a pooled connection and outlive the request. The PROMOTE paths (`POST /`,
// and `PATCH` with `isGlobalAdmin: true`) deliberately do NOT take it.
//
// With every remover serialised, each guard's own read is a PLAIN,
// NON-LOCKING `SELECT`. That is the point of the design, not an oversight:
//
//   - Its snapshot is taken AFTER the mutex is held: `pg_advisory_xact_lock`
//     is the FIRST snapshot-taking statement in the transaction, so the
//     guard's `SELECT` sees everything committed while this transaction was
//     parked. Measured to hold under read committed, repeatable read and
//     serializable alike. Do NOT add a read before the lock: under repeatable
//     read that fixes the transaction snapshot pre-block and reopens the
//     round-4 hole. And no other remover can be mid-transaction at that
//     moment: they are all still parked on the mutex, before their own first
//     read. So its rows are committed truth as far as removals are concerned.
//   - A concurrent promote can commit after that snapshot, since it takes no
//     lock. It can only ADD to the admin set, so both a stale-low count and
//     a target that looks like a non-admin are conservative, never
//     permissive: the true count at write time is >= the count the guard
//     saw, and removing a target the snapshot did not contain leaves that
//     count intact. The invariant that matters — an install with >= 1 global
//     admin never reaches 0 — holds in both cases.
//
// Why NOT `SELECT ... FOR UPDATE` over the admin set, which is what fix
// rounds 2 and 3 used: a locking read fixes its row set from its own
// statement snapshot and only then blocks. A row promoted after that
// snapshot is invisible to it — neither counted nor lockable — and a row
// that WAS in the snapshot but is concurrently demoted is dropped by
// Postgres' EvalPlanQual recheck when the lock is finally granted. When both
// happen while one such read is blocked (e.g. behind an unrelated row lock
// on an admin's own row), it returns an EMPTY set while a committed global
// admin exists: `locked.some(...)` is then false for every row, the guard
// never fires, and the handler blind-writes. Reproduced 3/3 against a live
// database. The mutex removes the blocking read altogether, so there is no
// pre-block snapshot left to carry into the guard.
//
// Kept from fix round 3: WHETHER a removal is happening is decided from the
// request's own intent (`body.isGlobalAdmin === false` in PATCH; DELETE is
// always a removal), never from the pre-transaction `findFirst` read — and
// the target's admin membership is decided from the in-transaction read, so
// a target promoted between the two is still guarded.

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

  const columns: Partial<typeof users.$inferInsert> = {};
  if ('displayName' in body) columns.displayName = body.displayName ?? null;
  if ('isGlobalAdmin' in body && body.isGlobalAdmin !== undefined) {
    columns.isGlobalAdmin = body.isGlobalAdmin;
  }

  // Count-check-then-write, in ONE transaction, serialised against the other
  // removal path on GLOBAL_ADMIN_MUTEX — see the block comment above
  // GET /api/v1/admin/users for why this is a mutex plus a plain read rather
  // than a `SELECT ... FOR UPDATE` (TOCTOU close, plan 058 Global
  // Constraint).
  //
  // Gated on the request's INTENT (`body.isGlobalAdmin === false`), never on
  // the target's state as of the pre-transaction `findFirst`: a target
  // promoted to global admin between that read and this transaction would
  // otherwise skip the guard entirely and be demoted anyway. Membership
  // likewise comes from the in-transaction read (`admins.some(...)`).
  const result = await db.transaction(async (tx) => {
    if (body.isGlobalAdmin === false) {
      await tx.execute(sql`select pg_advisory_xact_lock(${GLOBAL_ADMIN_MUTEX})`);
      const admins = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.isGlobalAdmin, true));
      if (admins.some((r) => r.id === user.id) && !canRemoveGlobalAdmin(admins.length)) {
        return { refused: true as const };
      }
    }

    // A body of `{}`, unknown-keys-only (zod strips them), or no body at
    // all all land here with zero columns to set. drizzle's `.set()` throws
    // "No values to set" on an empty object — a no-op PATCH is not an error
    // per docs/API.md ("fields omitted are left unchanged"), so skip the
    // write and echo the user back unchanged instead of letting that throw
    // surface as a 500.
    const updated =
      Object.keys(columns).length > 0
        ? (await tx.update(users).set(columns).where(eq(users.id, user.id)).returning())[0]
        : user;
    return { refused: false as const, updated };
  });

  if (result.refused) {
    return c.json({ error: 'Cannot demote the last global admin' }, 409);
  }
  const updated = result.updated;
  // Fix round 3 (Minor): the target may have been deleted by a concurrent
  // request between the `findFirst` above and this transaction's write,
  // making `.returning()` come back empty. Without this check,
  // `publicUser(undefined)` throws on `u.id` and a legitimate concurrent-
  // delete race surfaces as a 500 instead of a 404.
  if (!updated) return c.json({ error: 'User not found' }, 404);

  // Privilege changes must be distinguishable in the log from a display-name
  // edit — granting or revoking global admin is a security-relevant event.
  // Only logged when the request actually changed the field (i.e. it made it
  // into the SET clause above), never merely because it was present in the
  // request body. Never log anything sensitive (password hash, temp password).
  logger.info('User updated', {
    userId: user.id,
    ...('isGlobalAdmin' in columns ? { isGlobalAdmin: columns.isGlobalAdmin } : {}),
    requestId: c.get('requestId'),
  });
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
  await revokeAllUserSessions(user.id);

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

  // Count-check-then-write, in ONE transaction, serialised against the other
  // removal path on GLOBAL_ADMIN_MUTEX — see the block comment above
  // GET /api/v1/admin/users for why this is a mutex plus a plain read rather
  // than a `SELECT ... FOR UPDATE` (TOCTOU close, plan 058 Global
  // Constraint).
  //
  // The mutex is taken UNCONDITIONALLY, not gated on `user.isGlobalAdmin`
  // from the pre-transaction `findFirst`: a target promoted after that read
  // would otherwise skip the guard entirely and be deleted anyway. Both
  // "does this target count as a global admin" and "is it safe to remove"
  // come from the in-transaction read. Every user deletion therefore
  // serialises globally, which is fine — this is an admin-only, low-rate
  // endpoint, and the transaction holds the mutex for two statements.
  const refused = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${GLOBAL_ADMIN_MUTEX})`);
    const admins = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isGlobalAdmin, true));
    if (admins.some((r) => r.id === user.id) && !canRemoveGlobalAdmin(admins.length)) {
      return true;
    }
    await tx.delete(users).where(eq(users.id, user.id));
    return false;
  });
  if (refused) {
    return c.json({ error: 'Cannot delete the last global admin' }, 409);
  }

  logger.info('User deleted', { userId: user.id, requestId: c.get('requestId') });
  return c.json({ success: true });
});

export default adminUsersRouter;
