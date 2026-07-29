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
