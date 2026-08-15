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
 * Strip the IPv4-mapped IPv6 prefix so a socket address and a configured one
 * compare equal.
 *
 * Node reports an IPv4 connection on a dual-stack listener as
 * '::ffff:172.28.0.10' (measured on this Node version, not assumed). This app
 * sets API_HOST='0.0.0.0' by default (index.ts) and in docker-compose.yml, and
 * a listener bound to an explicit IPv4 host reports a BARE address — so this is
 * forward-compatible hardening, not a fix for a live failure. It becomes
 * load-bearing if API_HOST is ever unset (Node's dual-stack default) or set to
 * '::': there, without this, TRUSTED_PROXY_IPS could never be set to a value
 * that matches, the trust check would silently fail, and every caller behind
 * the proxy would share one bucket.
 *
 * The prefix test is case-insensitive on the OPERATOR's side of the comparison,
 * not Node's: Node only ever emits lowercase, so this fails closed rather than
 * open today. But TRUSTED_PROXY_IPS is hand-typed, and a pasted '::FFFF:…'
 * would otherwise fail to establish trust with no warning anywhere — the same
 * silent shared-bucket outcome, arrived at from the config side.
 */
function normalizeIp(ip: string): string {
  const MAPPED_PREFIX = '::ffff:';
  // Slice the ORIGINAL, not the lowercased copy: only the prefix is matched
  // case-insensitively, and what follows it is a dotted-quad IPv4 with no case
  // to preserve or destroy.
  return ip.toLowerCase().startsWith(MAPPED_PREFIX) ? ip.slice(MAPPED_PREFIX.length) : ip;
}

/**
 * Extract the client IP using a reliable strategy:
 * 1. If TRUSTED_PROXY_IPS is set, trust x-forwarded-for only when the
 *    connecting socket IP is itself trusted.
 * 2. Otherwise use the socket remote address (not spoofable).
 * 3. Last resort: 'unknown' (all unknown clients share one bucket).
 *
 * Both the socket IP and TRUSTED_PROXY_IPS are normalized (IPv4-mapped
 * IPv6 prefix stripped) before comparing, and the return value is normalized
 * too, so one client always occupies exactly one rate-limit bucket regardless
 * of which form the listener reports.
 */
export function getClientIp(c: Context): string {
  const trustedProxies = process.env.TRUSTED_PROXY_IPS?.split(',').map((s) => s.trim());

  const socketIp = (c.env as Record<string, unknown>)?.incoming
    ? ((c.env as Record<string, unknown>).incoming as Record<string, unknown>)?.socket
      ? (((c.env as Record<string, unknown>).incoming as Record<string, unknown>).socket as Record<string, unknown>)?.remoteAddress as string | undefined
      : undefined
    : undefined;

  const normalizedSocketIp = socketIp ? normalizeIp(socketIp) : undefined;

  if (trustedProxies && normalizedSocketIp) {
    const trusted = trustedProxies.map(normalizeIp);
    if (trusted.includes(normalizedSocketIp)) {
      const forwarded = c.req.header('x-forwarded-for')?.split(',')[0].trim();
      if (forwarded) return normalizeIp(forwarded);
    }
  }

  return normalizedSocketIp || 'unknown';
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
 *
 * ONE EXCEPTION, and it is the whole reason this function is not a one-liner:
 * a session holding an unrotated temporary password (`mustChangePassword`) is
 * NOT exempt. `passwordChangeGate()` is about to refuse that request with a
 * 403 no matter what it asks for, and a request the gate will refuse must
 * never buy its way out of throttling — otherwise a mid-reset cookie hammers
 * /api/v1/admin/* unthrottled, paying the session DB lookup sessionAuth does
 * on EVERY request (session.ts:45,49) for each one. That is the exact
 * unthrottled-cookie hazard the "mount the gate AFTER the limiter" rule
 * exists to prevent, arriving through a different door: mount order
 * guarantees the limiter RUNS, but a skip predicate that exempts the very
 * population the gate is about to refuse makes running it a no-op. Ordering
 * is necessary, not sufficient.
 *
 * The flag is checked BEFORE the bearer, deliberately. A mid-reset cookie
 * arriving alongside a valid ADMIN_TOKEN is still refused by the gate —
 * session resolution outranks the bearer (middleware/access.ts:50-70, a plan
 * 058 decision) — so the bearer must not purchase an exemption the gate will
 * not honour. Plan 055's real console path (valid ADMIN_TOKEN, no session at
 * all) is untouched: getSessionUser returns null, `?.` yields undefined, and
 * the bearer check below exempts it exactly as before.
 */
export function hasAdminStanding(c: Context): boolean {
  const sessionUser = getSessionUser(c);
  if (sessionUser?.mustChangePassword) return false;
  return hasValidAdminBearer(c) || sessionUser !== null;
}

/**
 * Rate limiter for admin endpoints. Very restrictive to slow brute force.
 * Limit: 5/min per IP, applied ONLY to a request with neither a valid admin
 * token NOR a signed-in session — either is exempt, EXCEPT a session pending
 * a forced password change, which is throttled regardless of any bearer that
 * accompanies it (see hasAdminStanding). MUST be mounted BEFORE
 * adminOrGlobalAdminAuth (see admin.ts) or it never runs.
 */
export const adminRateLimit = createRateLimit(
  ADMIN_RATE_LIMIT,
  getClientIp,
  'Admin rate limit exceeded.',
  hasAdminStanding
);

/**
 * The boot warning for an unconfigured trusted proxy, or null when configured.
 *
 * A pure function rather than an inline `if` in index.ts so it is unit-testable
 * and mutation-provable — the same extraction the dashboard's $lib helpers use.
 * Without TRUSTED_PROXY_IPS the API ignores X-Forwarded-For (correctly — it is
 * spoofable from an untrusted socket), which means a server-mediated dashboard
 * puts every user in one rate-limit bucket. That degrades at a threshold rather
 * than failing outright, so it must be announced rather than discovered.
 */
export function trustedProxyWarning(trustedProxyIps: string | undefined): string | null {
  if (trustedProxyIps && trustedProxyIps.trim() !== '') return null;
  return (
    'TRUSTED_PROXY_IPS is not set — X-Forwarded-For is ignored and every ' +
    'request is rate-limited by its socket address. If the dashboard reaches ' +
    'this API server-side (the default docker-compose deployment), ALL users ' +
    'share one bucket: ~100 API calls and 10 sign-ins per minute for the whole ' +
    'installation, regardless of how many people are using it. Set ' +
    'TRUSTED_PROXY_IPS to the dashboard container\'s address so each browser ' +
    'gets its own bucket. See docs/GETTING_STARTED.md.'
  );
}
