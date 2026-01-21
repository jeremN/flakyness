import { createHash, randomBytes } from 'crypto';
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
 * Use this to protect admin endpoints.
 */
export function adminAuth(): MiddlewareHandler {
  return async (c: Context, next) => {
    const adminToken = process.env.ADMIN_TOKEN;
    
    if (!adminToken) {
      throw new HTTPException(500, { 
        message: 'Admin functionality not configured. Set ADMIN_TOKEN environment variable.' 
      });
    }

    const authHeader = c.req.header('Authorization');
    
    if (!authHeader) {
      throw new HTTPException(401, { message: 'Authorization header required' });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      throw new HTTPException(401, { message: 'Invalid authorization format. Use: Bearer <token>' });
    }

    const token = parts[1];
    
    // Constant-time comparison to prevent timing attacks
    if (token.length !== adminToken.length || !timingSafeEqual(token, adminToken)) {
      throw new HTTPException(401, { message: 'Invalid admin token' });
    }
    
    await next();
  };
}

/**
 * Constant-time string comparison
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
