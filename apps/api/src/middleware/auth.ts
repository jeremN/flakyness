import { createHash, randomBytes } from 'crypto';
import { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { db, projects } from '../db';
import { extractBearerToken, tokensMatch } from './token';
import { resolveAccessValue } from './access';
import { canEnterAdminApi } from '../services/auth/access';

// extractBearerToken/tokensMatch moved to the DB-free ./token module (so the
// rate limiter can reuse them without importing the database). Re-exported here
// to keep existing `./middleware/auth` importers (e.g. index.ts's /metrics
// check) working unchanged.
export { extractBearerToken, tokensMatch } from './token';

/**
 * Hash a token using SHA-256
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a secure random token
 */
export function generateToken(): string {
  return `flackyness_${randomBytes(24).toString('hex')}`;
}

/**
 * Bearer token authentication middleware for project tokens
 *
 * Extracts the Bearer token from Authorization header,
 * hashes it, and looks up the corresponding project.
 * Sets `c.set('project', project)` on success.
 */
export function projectAuth(): MiddlewareHandler {
  return async (c: Context, next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader) {
      throw new HTTPException(401, { message: 'Authorization header required' });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      throw new HTTPException(401, { message: 'Invalid authorization format. Use: Bearer <token>' });
    }

    const token = parts[1];
    const tokenHash = hashToken(token);

    const project = await db.query.projects.findFirst({
      where: eq(projects.tokenHash, tokenHash),
    });

    if (!project) {
      throw new HTTPException(401, { message: 'Invalid project token' });
    }

    // Store project in context for use in route handlers
    c.set('project', project);

    await next();
  };
}

/**
 * Admin authentication middleware
 *
 * Validates the ADMIN_TOKEN from environment variables.
 * Comparison is done by hashing both tokens so the comparison is always
 * constant-time and doesn't leak the token length.
 */
export function adminAuth(): MiddlewareHandler {
  return async (c: Context, next) => {
    const adminToken = process.env.ADMIN_TOKEN;

    if (!adminToken) {
      throw new HTTPException(500, {
        message: 'Admin functionality not configured. Set ADMIN_TOKEN environment variable.',
      });
    }

    const authHeader = c.req.header('Authorization');

    if (!authHeader) {
      throw new HTTPException(401, { message: 'Authorization header required' });
    }

    const token = extractBearerToken(authHeader);
    if (!token) {
      throw new HTTPException(401, { message: 'Invalid authorization format. Use: Bearer <token>' });
    }

    if (!tokensMatch(token, adminToken)) {
      throw new HTTPException(401, { message: 'Invalid admin token' });
    }

    await next();
  };
}

/**
 * Admin-API gate that accepts EITHER a valid ADMIN_TOKEN bearer OR a session
 * with standing on this surface (global admin, or team_admin in some team).
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

    if (canEnterAdminApi(access)) {
      await next();
      return;
    }

    // 401 and 403 are different facts and the split is deliberate: 403 means
    // "we know who you are and the answer is no", which is only sayable to
    // someone identified. Answering an anonymous caller 403 would both tell
    // them to stop retrying when logging in would in fact help, and confirm
    // the endpoint exists.
    if (access.kind === 'user') {
      throw new HTTPException(403, { message: 'Admin access required' });
    }

    // Below this point the caller could not be identified as a session or a
    // recognised token — the same territory adminAuth() used to cover alone.
    // Mirror its exact message text for these two sub-cases: admin.test.ts
    // (predates this plan, out of scope for this task, "fix the handler, not
    // the test") pins both strings verbatim.
    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      throw new HTTPException(401, { message: 'Authorization header required' });
    }
    if (!extractBearerToken(authHeader)) {
      throw new HTTPException(401, {
        message: 'Invalid authorization format. Use: Bearer <token>',
      });
    }
    throw new HTTPException(401, { message: 'Invalid admin token' });
  };
}

/**
 * A readAuth middleware, tagged so the route-coverage guard can recognise it.
 *
 * The tag is part of the contract, not a convenience: every readAuth() call
 * returns a fresh closure, so routes-auth-coverage.test.ts cannot identify
 * mounted read-auth by reference identity. Removing `isReadAuth` makes that
 * guard silently pass over an empty set — exactly the failure mode it exists
 * to eliminate.
 */
export interface ReadAuthMiddleware extends MiddlewareHandler {
  isReadAuth: true;
}

/**
 * Read authorization middleware (plan 041, design decisions D1–D6).
 *
 * An unset READ_TOKEN means "reads are open" — identical to the behaviour
 * before this plan. That is deliberate (D1): closing by default would break
 * every existing install on upgrade, and in a self-hosted product the
 * operator, not us, knows whether their network is trusted. The boot warning
 * in index.ts is what makes the choice conscious rather than accidental; this
 * middleware stays silent.
 *
 * Evaluation order is load-bearing for performance (D3), not just for
 * readability. The dashboard presents READ_TOKEN on every SSR request and
 * emits 2–5 API calls per page view, including GET /api/v1/projects on every
 * single page via +layout.server.ts. That path must not touch the database,
 * so the READ_TOKEN comparison — constant-time, in memory — comes first. Only
 * the project-token fallback pays a lookup, and that path is the CI Action:
 * roughly once per pipeline run, against an existing index
 * (projects_token_hash_idx, schema.ts:27).
 *
 * @param resolveProjectId Reads the project this request targets out of the
 *   request. Omit it on routes that are not scoped to a single project — they
 *   then accept READ_TOKEN only. Two routes deliberately omit it:
 *   GET /api/v1/projects (D6) and GET /api/v1/tests/flaky/:id (D5).
 */
export function readAuth(
  resolveProjectId?: (c: Context) => string | null | undefined
): ReadAuthMiddleware {
  const mw: MiddlewareHandler = async (c, next) => {
    const readToken = process.env.READ_TOKEN;
    if (!readToken) return await next();

    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) {
      throw new HTTPException(401, { message: 'Authorization header required' });
    }

    if (tokensMatch(token, readToken)) return await next();

    if (resolveProjectId) {
      const wanted = resolveProjectId(c);
      if (wanted) {
        const project = await db.query.projects.findFirst({
          where: eq(projects.tokenHash, hashToken(token)),
        });
        // Both predicates matter: a valid project token that targets a
        // DIFFERENT project must be rejected. This is what closes the
        // cross-project read at the middleware, rather than relying on each
        // handler to remember.
        if (project && project.id === wanted) {
          c.set('project', project);
          return await next();
        }
      }
    }

    // Deliberately generic: do not reveal whether the token was unknown or
    // simply pointed at another project.
    throw new HTTPException(401, { message: 'Invalid read credentials' });
  };

  return Object.assign(mw, { isReadAuth: true as const });
}
