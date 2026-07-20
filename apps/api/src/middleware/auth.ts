import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { db, projects } from '../db';

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
 * Extract the token from a `Bearer <token>` Authorization header.
 * Returns null if the header is missing or not in the expected format.
 */
export function extractBearerToken(authHeader: string | undefined | null): string | null {
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;

  return parts[1];
}

/**
 * Constant-time token comparison, shared by adminAuth and any other route
 * gated by a bearer token compared against a single expected value (e.g. the
 * /metrics endpoint's METRICS_TOKEN).
 *
 * Hashing both tokens before comparing ensures:
 * 1. Both buffers are always the same length (32 bytes SHA-256)
 * 2. No timing leak on token length
 * 3. Uses Node.js native crypto.timingSafeEqual (constant-time)
 */
export function tokensMatch(candidate: string, expected: string): boolean {
  const candidateHash = createHash('sha256').update(candidate).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
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
    if (!readToken) return next();

    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) {
      throw new HTTPException(401, { message: 'Authorization header required' });
    }

    if (tokensMatch(token, readToken)) return next();

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
          return next();
        }
      }
    }

    // Deliberately generic: do not reveal whether the token was unknown or
    // simply pointed at another project.
    throw new HTTPException(401, { message: 'Invalid read credentials' });
  };

  return Object.assign(mw, { isReadAuth: true as const });
}
