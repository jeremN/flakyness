import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq, and, ne, count, sql } from 'drizzle-orm';
import { db, teams, teamMembers, users, projects } from '../db';
import { logger } from '../middleware/logger';
import { adminRateLimit } from '../middleware/rate-limit';
import { adminOrGlobalAdminAuth } from '../middleware/auth';
import { getAccess } from '../middleware/access';
import { canAdministerTeams } from '../services/auth/access';
import { TEAM_ROLES } from '../services/auth/membership';

const adminTeamsRouter = new Hono<{ Variables: { requestId: string } }>();

// Own limiter + gate — same reasoning as admin-users.ts: this is a separate
// Hono instance from routes/admin.ts, so it does NOT inherit that router's
// `use('*', ...)` middleware. Guarded by the "requires an admin token" test.
adminTeamsRouter.use('*', adminRateLimit);
adminTeamsRouter.use('*', adminOrGlobalAdminAuth());

// Team CRUD is never delegated to a team_admin (see canAdministerTeams'
// doc comment) — adminOrGlobalAdminAuth() alone would let a team_admin
// through, since they belong on the wider admin API surface for their own
// project routes. This second gate closes that back down to global-admin
// only, for every route on this router.
adminTeamsRouter.use('*', async (c, next) => {
  if (!canAdministerTeams(getAccess(c))) {
    return c.json({ error: 'Global admin required' }, 403);
  }
  await next();
});

const uuidSchema = z.string().uuid();

const createTeamSchema = z.object({ name: z.string().min(1).max(255) });
const patchTeamSchema = z.object({ name: z.string().min(1).max(255) });
const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(TEAM_ROLES),
});
const patchMemberSchema = z.object({ role: z.enum(TEAM_ROLES) });

/**
 * GET /api/v1/admin/teams
 *
 * List all teams with member and project counts (subqueries, no N+1 —
 * the shape of the pattern at admin.ts:190-198).
 *
 * DEVIATION from the brief's literal code: the brief's snippet correlates
 * via `${teams.id}` interpolated into the `sql` template. Verified against
 * a real row (insert a team + a member, list, assert count) that this
 * renders as a BARE `"id"`, not `"teams"."id"` — because `.from(teams)` is
 * a single-table select, Drizzle only qualifies column references when it
 * detects a join at the outer query, not when the reference is re-used
 * inside a hand-written subquery string. Postgres then resolves that bare
 * `"id"` against the SUBQUERY's own FROM list first (`team_members.id` /
 * `projects.id`, both real columns), silently comparing `team_id` to the
 * child row's own id instead of the parent team's — so the count is always
 * 0 regardless of real membership. The same shadowing affects admin.ts's
 * `totalRuns`/`totalTests`/`activeFlakyTests` subqueries, which reference
 * `${projects.id}` from a single-table `.from(projects)` the same way;
 * `admin.test.ts:127` only asserts `typeof ... === 'number'`, which 0
 * satisfies, so it doesn't catch this. Flagged for the coordinator — not
 * fixed here, out of this task's file list. Here, the outer reference is
 * written as unquoted, unparameterised `teams.id` text (matching the
 * existing unquoted `team_members.team_id` / `projects.team_id` style in
 * the same fragment) instead of `${teams.id}`, which correlates correctly.
 */
adminTeamsRouter.get('/', async (c) => {
  const rows = await db
    .select({
      id: teams.id,
      name: teams.name,
      createdAt: teams.createdAt,
      memberCount: sql<number>`coalesce((
        select count(*)::int from team_members where team_members.team_id = teams.id
      ), 0)`,
      projectCount: sql<number>`coalesce((
        select count(*)::int from projects where projects.team_id = teams.id
      ), 0)`,
    })
    .from(teams)
    .orderBy(teams.name);

  return c.json({ teams: rows });
});

/**
 * POST /api/v1/admin/teams
 */
adminTeamsRouter.post('/', zValidator('json', createTeamSchema), async (c) => {
  const { name } = c.req.valid('json');

  const existing = await db.query.teams.findFirst({ where: eq(teams.name, name) });
  if (existing) {
    return c.json({ error: 'A team with this name already exists' }, 409);
  }

  const [team] = await db.insert(teams).values({ name }).returning();

  logger.info('Team created', { teamId: team.id, teamName: name, requestId: c.get('requestId') });
  return c.json({ team }, 201);
});

/**
 * PATCH /api/v1/admin/teams/:teamId
 *
 * Renames a team. The duplicate-name check mirrors POST's — `teams.name`
 * carries a DB unique constraint, and without this check a rename to an
 * in-use name would surface as a raw 500 instead of a purposeful 409.
 */
adminTeamsRouter.patch('/:teamId', zValidator('json', patchTeamSchema), async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('teamId'));
  if (!parsed.success) return c.json({ error: 'Invalid team ID format' }, 400);

  const { name } = c.req.valid('json');
  const team = await db.query.teams.findFirst({ where: eq(teams.id, parsed.data) });
  if (!team) return c.json({ error: 'Team not found' }, 404);

  const conflict = await db.query.teams.findFirst({
    where: and(eq(teams.name, name), ne(teams.id, team.id)),
  });
  if (conflict) return c.json({ error: 'A team with this name already exists' }, 409);

  const [updated] = await db.update(teams).set({ name }).where(eq(teams.id, team.id)).returning();

  logger.info('Team renamed', { teamId: team.id, teamName: name, requestId: c.get('requestId') });
  return c.json({ team: updated });
});

/**
 * DELETE /api/v1/admin/teams/:teamId
 */
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

/**
 * GET /api/v1/admin/teams/:teamId/members
 *
 * An explicit column select (never `select()` on `users`) so `passwordHash`
 * is structurally unreachable here, not just omitted by convention.
 */
adminTeamsRouter.get('/:teamId/members', async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('teamId'));
  if (!parsed.success) return c.json({ error: 'Invalid team ID format' }, 400);

  const team = await db.query.teams.findFirst({ where: eq(teams.id, parsed.data) });
  if (!team) return c.json({ error: 'Team not found' }, 404);

  const members = await db
    .select({
      userId: teamMembers.userId,
      email: users.email,
      displayName: users.displayName,
      role: teamMembers.role,
    })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, team.id));

  return c.json({ members });
});

/**
 * POST /api/v1/admin/teams/:teamId/members
 *
 * The FK-existence check and the duplicate check are explicit, so both
 * produce a purposeful status instead of a 500 from the database.
 */
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

/**
 * PATCH /api/v1/admin/teams/:teamId/members/:userId
 */
adminTeamsRouter.patch(
  '/:teamId/members/:userId',
  zValidator('json', patchMemberSchema),
  async (c) => {
    const parsedTeam = uuidSchema.safeParse(c.req.param('teamId'));
    if (!parsedTeam.success) return c.json({ error: 'Invalid team ID format' }, 400);
    const parsedUser = uuidSchema.safeParse(c.req.param('userId'));
    if (!parsedUser.success) return c.json({ error: 'Invalid user ID format' }, 400);

    const { role } = c.req.valid('json');

    const team = await db.query.teams.findFirst({ where: eq(teams.id, parsedTeam.data) });
    if (!team) return c.json({ error: 'Team not found' }, 404);

    const membership = await db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, parsedUser.data)),
    });
    if (!membership) return c.json({ error: 'Membership not found' }, 404);

    const [updated] = await db
      .update(teamMembers)
      .set({ role })
      .where(eq(teamMembers.id, membership.id))
      .returning();

    logger.info('Team member role changed', {
      teamId: team.id,
      userId: parsedUser.data,
      role,
      requestId: c.get('requestId'),
    });
    return c.json({ member: updated });
  }
);

/**
 * DELETE /api/v1/admin/teams/:teamId/members/:userId
 *
 * Removes the membership only — the user account itself is untouched.
 */
adminTeamsRouter.delete('/:teamId/members/:userId', async (c) => {
  const parsedTeam = uuidSchema.safeParse(c.req.param('teamId'));
  if (!parsedTeam.success) return c.json({ error: 'Invalid team ID format' }, 400);
  const parsedUser = uuidSchema.safeParse(c.req.param('userId'));
  if (!parsedUser.success) return c.json({ error: 'Invalid user ID format' }, 400);

  const team = await db.query.teams.findFirst({ where: eq(teams.id, parsedTeam.data) });
  if (!team) return c.json({ error: 'Team not found' }, 404);

  const membership = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, parsedUser.data)),
  });
  if (!membership) return c.json({ error: 'Membership not found' }, 404);

  await db.delete(teamMembers).where(eq(teamMembers.id, membership.id));

  logger.info('Team member removed', {
    teamId: team.id,
    userId: parsedUser.data,
    requestId: c.get('requestId'),
  });
  return c.json({ success: true });
});

export default adminTeamsRouter;
