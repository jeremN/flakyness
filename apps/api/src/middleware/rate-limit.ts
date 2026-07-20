import { rateLimiter } from 'hono-rate-limiter';
import { createMiddleware } from 'hono/factory';
import type { Context, MiddlewareHandler } from 'hono';

// Rate limiting is disabled under the test runner by default (hammering
// endpoints in tests would otherwise trip the limits). Unlike the previous
// build-time `const isTest` branch — which made the no-op permanent and hid a
// mounting bug from every test — this is a runtime flag a dedicated test can
// flip on to exercise the real limiters. Production (`!VITEST`) is unchanged.
let rateLimitEnabled = !process.env.VITEST;

/** Test-only: enable/disable the real limiters at runtime. Do not call in prod. */
export function __setRateLimitEnabled(value: boolean): void {
  rateLimitEnabled = value;
}

// Single source of truth for the limits. Tests assert against these so a copy
// can't drift from what production uses.
export const REPORT_RATE_LIMIT = { windowMs: 60 * 1000, limit: 60 };
export const API_RATE_LIMIT = { windowMs: 60 * 1000, limit: 100 };
export const ADMIN_RATE_LIMIT = { windowMs: 60 * 1000, limit: 5 };

/**
 * Extract the client IP using a reliable strategy:
 * 1. If TRUSTED_PROXY_IPS is set, trust x-forwarded-for only when the
 *    connecting socket IP is itself trusted.
 * 2. Otherwise use the socket remote address (not spoofable).
 * 3. Last resort: 'unknown' (all unknown clients share one bucket).
 */
export function getClientIp(c: Context): string {
  const trustedProxies = process.env.TRUSTED_PROXY_IPS?.split(',').map((s) => s.trim());

  const socketIp = (c.env as Record<string, unknown>)?.incoming
    ? ((c.env as Record<string, unknown>).incoming as Record<string, unknown>)?.socket
      ? (((c.env as Record<string, unknown>).incoming as Record<string, unknown>).socket as Record<string, unknown>)?.remoteAddress as string | undefined
      : undefined
    : undefined;

  if (trustedProxies && socketIp && trustedProxies.includes(socketIp)) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0].trim();
    if (forwarded) return forwarded;
  }

  return socketIp || 'unknown';
}

/**
 * The single limiter builder. Wraps a real `rateLimiter` behind the runtime
 * flag: when disabled (default under VITEST) it is a pass-through; when enabled
 * it enforces `config`. Each call owns a fresh in-memory store.
 */
export function createRateLimit(
  config: { windowMs: number; limit: number },
  keyGenerator: (c: Context) => string,
  message: string
): MiddlewareHandler {
  const real = rateLimiter({
    windowMs: config.windowMs,
    limit: config.limit,
    standardHeaders: 'draft-7',
    keyGenerator,
    handler: (c: Context) => c.json({ error: message, retryAfter: 60 }, 429),
  });
  return createMiddleware(async (c, next) => {
    if (!rateLimitEnabled) return next();
    return real(c, next);
  });
}

/**
 * Rate limiter for report ingestion. Limit: 60/min per project token.
 */
export const reportRateLimit = createRateLimit(
  REPORT_RATE_LIMIT,
  (c: Context) => {
    const project = c.get('project');
    return project?.id || 'anonymous';
  },
  'Too many report uploads. Please wait before retrying.'
);

/**
 * Rate limiter for general read endpoints. Limit: 100/min per IP.
 */
export const apiRateLimit = createRateLimit(
  API_RATE_LIMIT,
  getClientIp,
  'Rate limit exceeded. Please slow down.'
);

/**
 * Rate limiter for admin endpoints. Very restrictive to slow brute force.
 * Limit: 5/min per IP. MUST be mounted BEFORE adminAuth (see admin.ts) or it
 * never runs.
 */
export const adminRateLimit = createRateLimit(
  ADMIN_RATE_LIMIT,
  getClientIp,
  'Admin rate limit exceeded.'
);
