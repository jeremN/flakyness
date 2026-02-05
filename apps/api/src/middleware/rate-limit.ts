import { rateLimiter } from 'hono-rate-limiter';
import type { Context } from 'hono';

/**
 * Extract the client IP address using a reliable strategy:
 * 1. If TRUSTED_PROXY_IPS is set, use x-forwarded-for only when the connecting IP is trusted
 * 2. Otherwise, fall back to the socket remote address (not spoofable)
 * 3. Last resort: 'unknown' (all unknown clients share one bucket — safe default)
 */
function getClientIp(c: Context): string {
  const trustedProxies = process.env.TRUSTED_PROXY_IPS?.split(',').map(s => s.trim());

  // Get the real socket IP from the Node.js request (not spoofable)
  const socketIp = (c.env as Record<string, unknown>)?.incoming
    ? ((c.env as Record<string, unknown>).incoming as Record<string, unknown>)?.socket
      ? (((c.env as Record<string, unknown>).incoming as Record<string, unknown>).socket as Record<string, unknown>)?.remoteAddress as string | undefined
      : undefined
    : undefined;

  // Only trust proxy headers if the connection comes from a trusted proxy
  if (trustedProxies && socketIp && trustedProxies.includes(socketIp)) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0].trim();
    if (forwarded) return forwarded;
  }

  // Use the socket IP directly (not spoofable)
  return socketIp || 'unknown';
}

/**
 * Rate limiter for report ingestion endpoint.
 * Prevents CI loops and accidental spam.
 *
 * Limit: 60 requests per minute per project token
 */
export const reportRateLimit = rateLimiter({
  windowMs: 60 * 1000, // 1 minute
  limit: 60,
  standardHeaders: 'draft-7',
  keyGenerator: (c: Context) => {
    const project = c.get('project');
    return project?.id || 'anonymous';
  },
  handler: (c: Context) => {
    return c.json(
      {
        error: 'Too many report uploads. Please wait before retrying.',
        retryAfter: 60,
      },
      429
    );
  },
});

/**
 * Rate limiter for general API read endpoints.
 * Prevents dashboard API abuse and scraping.
 *
 * Limit: 100 requests per minute per IP
 */
export const apiRateLimit = rateLimiter({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  keyGenerator: (c: Context) => getClientIp(c),
  handler: (c: Context) => {
    return c.json(
      {
        error: 'Rate limit exceeded. Please slow down.',
        retryAfter: 60,
      },
      429
    );
  },
});

/**
 * Rate limiter for admin endpoints.
 * Very restrictive to prevent brute force attacks.
 *
 * Limit: 5 requests per minute per IP
 */
export const adminRateLimit = rateLimiter({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  keyGenerator: (c: Context) => getClientIp(c),
  handler: (c: Context) => {
    return c.json(
      {
        error: 'Admin rate limit exceeded.',
        retryAfter: 60,
      },
      429
    );
  },
});
