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
