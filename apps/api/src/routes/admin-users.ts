import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq, count } from 'drizzle-orm';
import { db, users, teams, teamMembers, sessions } from '../db';
import { logger } from '../middleware/logger';
import { adminRateLimit } from '../middleware/rate-limit';
import { adminAuth } from '../middleware/auth';
import { hashPassword } from '../services/auth/password';
import { generateTempPassword, canRemoveGlobalAdmin, normaliseEmail } from '../services/auth/membership';

const adminUsersRouter = new Hono<{ Variables: { requestId: string } }>();

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
