import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db, users, teams, teamMembers } from '../db';
import { logger } from '../middleware/logger';
import { adminRateLimit } from '../middleware/rate-limit';
import { adminOrGlobalAdminAuth } from '../middleware/auth';
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

// Fix round 2, plan 058 Global Constraint ("the last-admin guard's TOCTOU
// must be closed in the SAME change that strips ADMIN_TOKEN of superuser
// status"): the demote (PATCH) and delete (DELETE) handlers below used to
// do a bare, unlocked `SELECT count(*) ... WHERE is_global_admin = true`,
// then an unconditioned write. Two concurrent requests — demoting/deleting
// two DIFFERENT admins, or even ONE admin session firing a self-demote and
// an other-demote at the same time — could both read the same count, both
// pass canRemoveGlobalAdmin, and both write, reaching zero global admins
// with no ADMIN_TOKEN break-glass left once a deployment runs session-only
// (which adminOrGlobalAdminAuth, Task 5, now fully supports).
//
// Both handlers below wrap their count-check-then-write in ONE transaction
// and lock the WHOLE global-admin set with `.for('update')` before counting
// — not just the target row. Locking only the target row is not enough: two
// transactions targeting two DIFFERENT admins would each see themselves as
// "not the row being contended," both read count 2, and both proceed.
// Locking every row in the admin set is what makes the second transaction
// block until the first commits.
//
// READ COMMITTED (Postgres' default; no isolation level is configured
// anywhere in this codebase), not SERIALIZABLE + retry: under READ
// COMMITTED, a `SELECT ... FOR UPDATE` that blocks on a row a concurrent
// transaction is about to modify re-evaluates that row's WHERE-clause
// membership against the POST-COMMIT version once unblocked. So the second
// transaction to run doesn't see the stale pre-commit count — if the first
// transaction's write took that row out of `isGlobalAdmin = true`, the
// second transaction's lock acquisition excludes it and returns the
// correctly reduced count. This holds even for two different target rows,
// not just contention on the same row. Chosen over SERIALIZABLE + retry
// because it's simpler and sufficient here: nothing else in either
// transaction needs a serializable snapshot, and there's no other
// concurrent write these handlers could conflict with that FOR UPDATE
// wouldn't already serialise.
//
// Fix round 3: round 2 still decided WHETHER to take the lock (`isDemote`
// in PATCH, `user.isGlobalAdmin` in DELETE) from a value read BEFORE the
// transaction opened. A target promoted to global admin in the window
// between that read and `BEGIN` would cause the handler to skip the lock
// and the guard entirely, then write anyway — reachable with three
// interleaved requests (promote target, demote another admin down to the
// last one, then the stale-read demote/delete on the now-promoted target)
// instead of two. Both handlers below now take the set-wide lock
// unconditionally (PATCH: whenever the request's body intends a demote;
// DELETE: always) and decide the target's admin membership from the
// LOCKED read, never the pre-transaction one.

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

  // Count-check-then-write, in ONE transaction, with the whole global-admin
  // set row-locked before counting — see the "Fix round 2" comment above
  // GET /api/v1/admin/users for why (TOCTOU close, plan 058 Global
  // Constraint).
  //
  // Fix round 3: the guard used to be gated on `isDemote`, computed from
  // `user.isGlobalAdmin` — a value read from the DB BEFORE this transaction
  // opens. If the target was promoted to global admin by a different
  // request after that read but before this transaction's lock, this
  // handler would skip the lock and the guard entirely on stale
  // information and demote anyway, reaching zero admins via three
  // interleaved requests instead of two. Gate on the request's INTENT
  // (`body.isGlobalAdmin === false`) instead, and decide membership from
  // the LOCKED set (`locked.some(...)`), never from the pre-transaction
  // read.
  const result = await db.transaction(async (tx) => {
    if (body.isGlobalAdmin === false) {
      const locked = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.isGlobalAdmin, true))
        .for('update');
      if (locked.some((r) => r.id === user.id) && !canRemoveGlobalAdmin(locked.length)) {
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

  // Count-check-then-write, in ONE transaction, with the whole global-admin
  // set row-locked before counting — see the "Fix round 2" comment above
  // GET /api/v1/admin/users for why (TOCTOU close, plan 058 Global
  // Constraint).
  //
  // Fix round 3: the lock used to be gated on `user.isGlobalAdmin`, read
  // BEFORE this transaction opens. If the target was promoted after that
  // read but before this transaction started, this handler would skip the
  // lock and guard entirely on stale information and delete anyway. Take
  // the set-wide lock unconditionally, then decide both "does this target
  // count as a global admin" and "is it safe to remove" from the LOCKED
  // set — never from the pre-transaction read.
  const refused = await db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isGlobalAdmin, true))
      .for('update');
    if (locked.some((r) => r.id === user.id) && !canRemoveGlobalAdmin(locked.length)) {
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
