import { rateLimiter } from 'hono-rate-limiter';
import { createMiddleware } from 'hono/factory';
import type { Context, MiddlewareHandler } from 'hono';
import { extractBearerToken, tokensMatch } from './token';
import { getSessionUser } from './session';

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
 * Login/change-password throttle. Stricter than the API limiter (100/min)
 * because each request is a password guess; looser than the admin limiter
 * (5/min) because a human retyping a password must not lock themselves out.
 */
export const AUTH_RATE_LIMIT = { windowMs: 60 * 1000, limit: 10 };

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
  message: string,
  skip?: (c: Context) => boolean
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
    // A request the caller marks as exempt bypasses the bucket entirely — it is
    // never counted, so exempt traffic can't exhaust the limit for anyone else.
    if (skip?.(c)) return next();
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
 * Rate limiter for the login/auth endpoints. Limit: 10/min per IP. Plain
 * per-IP throttling with no bearer exemption — unlike adminRateLimit, a login
 * request never carries a valid credential to exempt (that's the whole point
 * of the request), so every attempt counts against the bucket.
 */
export const authRateLimit = createRateLimit(
  AUTH_RATE_LIMIT,
  getClientIp,
  'Too many login attempts. Please wait before retrying.'
);

/**
 * True when the request carries a bearer token that matches ADMIN_TOKEN. The
 * admin limiter skips these: brute-force protection exists to throttle wrong or
 * absent tokens, not an already-authenticated admin whose token IS the auth
 * boundary. Throttling valid admin traffic only breaks the legitimate
 * server-mediated dashboard console, whose calls all share one dashboard-server
 * IP and would otherwise exhaust a per-IP bucket.
 *
 * MUST mirror adminAuth's extraction/compare exactly — it reuses the same
 * ./token helpers — so a request is never classed valid here yet rejected by
 * auth (or vice versa). Returns false (never throws) on a missing header via
 * the `token !== null` guard, and false when ADMIN_TOKEN is unconfigured.
 * Exported for direct, deterministic unit testing of each branch.
 */
export function hasValidAdminBearer(c: Context): boolean {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return false;
  const token = extractBearerToken(c.req.header('Authorization'));
  return token !== null && tokensMatch(token, adminToken);
}

/**
 * True when the request is either a valid ADMIN_TOKEN bearer OR a
 * signed-in session (ANY session — not just global-admin, per fix-round-1
 * ruling on plan 058 Task 5). The admin limiter exempts both: brute-force
 * protection exists to throttle wrong or absent credentials, not a caller
 * who already holds one.
 *
 * Exempting every session, not only global-admin ones, does not reopen the
 * brute-force hole the limiter exists to close — a session was never
 * guessed at this endpoint. It was minted by POST /auth/login, which sits
 * behind its OWN throttle (authRateLimit, 10/min per IP) and a valid
 * password. This limiter's 5/min ceiling was sized for anonymous bearer
 * guesses against ADMIN_TOKEN; once a caller has a session, the credential
 * that would need brute-forcing is a password, not this endpoint.
 *
 * Also fixes a real production gap, not just a test nicety: every
 * session-authenticated admin call carries no bearer at all, so before this
 * fix EVERY such call (dashboard console traffic from plan 059, all sharing
 * one SSR-server IP) landed in the SAME 5-per-minute-per-IP bucket as
 * anonymous brute-force traffic.
 *
 * getSessionUser(c) reads `c.get('sessionUser')`, populated synchronously by
 * sessionAuth() (mounted globally in index.ts, ahead of every router) — no
 * async plumbing needed here despite this predicate itself being sync.
 */
export function hasAdminStanding(c: Context): boolean {
  return hasValidAdminBearer(c) || getSessionUser(c) !== null;
}

/**
 * Rate limiter for admin endpoints. Very restrictive to slow brute force.
 * Limit: 5/min per IP, applied ONLY to a request with neither a valid admin
 * token NOR a signed-in session — either is exempt (see hasAdminStanding).
 * MUST be mounted BEFORE adminOrGlobalAdminAuth (see admin.ts) or it never
 * runs.
 */
export const adminRateLimit = createRateLimit(
  ADMIN_RATE_LIMIT,
  getClientIp,
  'Admin rate limit exceeded.',
  hasAdminStanding
);
