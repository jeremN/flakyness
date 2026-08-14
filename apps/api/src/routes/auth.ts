import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { setCookie, deleteCookie } from 'hono/cookie';
import { db, users, teams, teamMembers } from '../db';
import { logger } from '../middleware/logger';
import { authRateLimit, apiRateLimit } from '../middleware/rate-limit';
import { passwordChangeGate } from '../middleware/password-change';
import {
  getSessionUser,
  issueSession,
  revokeSession,
  revokeAllUserSessions,
} from '../middleware/session';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../services/auth/password';
import { normaliseEmail } from '../services/auth/membership';
import { SESSION_COOKIE, SESSION_TTL_MS } from '../services/auth/session';

const authRouter = new Hono<{ Variables: { requestId: string } }>();

// Brute-force throttle on the two password-bearing endpoints ONLY. An
// earlier revision mounted `authRateLimit` on '*', which also capped
// GET /me at 10/min per IP — and plan 059's dashboard `hooks.server.ts`
// calls /me on every server-rendered page view, so every user behind the
// dashboard container's one IP shares that bucket: the 11th page view in
// any minute would 429, `fetchMe` reads a non-2xx response as "not signed
// in", and the user is silently bounced to /login under completely
// ordinary load. /login and /change-password are the only two requests
// that ARE a password guess; /me and /logout carry no credential to guess
// and get the normal, much looser `apiRateLimit` instead — never
// exempted outright, never widened past that limiter's own bound.
//
// The `'*'` baseline below is load-bearing and must not be removed: it is the
// only thing covering paths that match NO handler. `sessionAuth()` is mounted
// globally on the root app now (index.ts, plan 058), ahead of every router
// including this one, so an unmatched URL like /api/v1/auth/nope still costs
// a SHA-256 plus an indexed sessions↔users SELECT before it 404s. Without a
// wildcard limiter that is an unauthenticated, unthrottled DB path — which is
// exactly what every sibling router avoids by mounting its limiter on `'*'`
// (projects.ts:31, tests.ts:13, admin.ts:19, reports.ts:63).
//
// Do NOT also mount `apiRateLimit` on `/me` or `/logout`. It is a module
// singleton over ONE store, so a second mount on the same path makes a single
// request consume TWO slots and silently halves that route's budget to 50/min
// — a weaker rerun of the very bug this split exists to prevent.
authRouter.use('*', apiRateLimit);
authRouter.use('/login', authRateLimit);
authRouter.use('/change-password', authRateLimit);
// All four current auth routes are allowlisted, so this mount changes nothing
// today. That is the point: it is what makes a FUTURE auth route refused by
// default rather than silently exempt.
authRouter.use('*', passwordChangeGate());

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(1024),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
});

/**
 * A real scrypt hash of a value nobody knows, used to burn the same CPU on an
 * unknown-email login as on a known one. Without it, "unknown account" returns
 * in microseconds while "wrong password" takes ~100 ms, and that gap is a
 * user-enumeration oracle for anything with a stopwatch.
 *
 * Computed lazily and cached: hashing at module load would slow every import,
 * including the ones in unit tests that never touch this route.
 *
 * The cache is reset on rejection: `??=` alone would happily cache a
 * REJECTED promise forever, so one transient scrypt failure would make
 * every later unknown-email login re-await that same rejection — a
 * permanent, stopwatch-free "unknown account" vs "wrong password" oracle
 * (500 vs 401), which is strictly worse than the timing gap this function
 * exists to close. The caller (below) also treats a dummy-hash failure as
 * a normal failed login rather than letting it surface as a 500.
 */
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword('flackyness-dummy-password-for-timing-equalisation');
    dummyHashPromise.catch(() => {
      dummyHashPromise = null;
    });
  }
  return dummyHashPromise;
}

/**
 * Resolves whether the session cookie's `Secure` attribute is set.
 * `COOKIE_SECURE` is an explicit escape hatch that can force it either way
 * (e.g. a TLS-terminating reverse proxy in front of a plain-HTTP container,
 * or a deliberately plain-HTTP self-hosted eval deployment); absent it,
 * defaults to `NODE_ENV === 'production'` — secure by default in production,
 * off elsewhere so the docker-compose default and the E2E build (both plain
 * HTTP) keep working without extra configuration.
 */
export function isCookieSecure(): boolean {
  const override = process.env.COOKIE_SECURE;
  if (override === 'true') return true;
  if (override === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

/** Never leaks passwordHash — the shape every auth response uses. */
function publicUser(u: {
  id: string;
  email: string;
  displayName: string | null;
  isGlobalAdmin: boolean;
}) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    isGlobalAdmin: u.isGlobalAdmin,
  };
}

function setSessionCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    // `secure` is off over plain HTTP or the browser silently drops the
    // cookie — which is how the docker-compose default and the E2E build run
    // (same class of trap as plan 053's ORIGIN discovery). See
    // isCookieSecure() above for the resolution order.
    secure: isCookieSecure(),
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/**
 * POST /api/v1/auth/login
 */
authRouter.post('/login', zValidator('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json');
  const normalisedEmail = normaliseEmail(email);

  const user = await db.query.users.findFirst({
    where: eq(users.email, normalisedEmail),
  });

  // Same branch shape for both failure modes — see dummyHash() above. An
  // unknown email still runs verifyPassword (against the dummy hash) so its
  // wall-clock cost matches a wrong-password rejection; skipping it here
  // would reopen the timing oracle the comment above describes.
  let ok: boolean;
  if (user) {
    ok = await verifyPassword(password, user.passwordHash);
  } else {
    try {
      await verifyPassword(password, await dummyHash());
    } catch (err) {
      // A scrypt/dummy-hash failure here must not surface as a 500 — that
      // would be a binary, stopwatch-free "this account exists (or the
      // server broke)" oracle, strictly worse than the timing gap
      // dummyHash() exists to close. Fall through exactly like a wrong
      // password; the cache reset in dummyHash() gives the NEXT call a
      // fresh attempt.
      logger.error('Dummy-hash timing equalisation failed during login', {
        requestId: c.get('requestId'),
        error: err instanceof Error ? { name: err.name, message: err.message } : undefined,
      });
    }
    ok = false;
  }

  if (!user || !ok) {
    logger.warn('Failed login attempt', { email: normalisedEmail, requestId: c.get('requestId') });
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  const now = new Date();
  const token = await issueSession(user.id, now);
  await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));

  setSessionCookie(c, token);
  logger.info('User signed in', { userId: user.id, requestId: c.get('requestId') });

  return c.json({
    user: publicUser(user),
    mustChangePassword: user.mustChangePassword,
  });
});

/**
 * POST /api/v1/auth/logout
 *
 * Idempotent: logging out without a session is a success, not a 401. The
 * caller's goal ("I am not signed in") is already true.
 */
authRouter.post('/logout', async (c) => {
  const sessionUser = getSessionUser(c);
  if (sessionUser) {
    await revokeSession(sessionUser.sessionId);
    logger.info('User signed out', { userId: sessionUser.id, requestId: c.get('requestId') });
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ success: true });
});

/**
 * GET /api/v1/auth/me
 *
 * The dashboard's source of truth for scoping its UI. `teams` is always
 * present and is `[]` until plan 057 introduces teams — so the response
 * contract does not change shape between phases.
 */
authRouter.get('/me', async (c) => {
  const sessionUser = getSessionUser(c);
  if (!sessionUser) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const memberships = await db
    .select({ id: teams.id, name: teams.name, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, sessionUser.id))
    .orderBy(teams.name);

  return c.json({
    user: {
      ...publicUser(sessionUser),
      mustChangePassword: sessionUser.mustChangePassword,
    },
    teams: memberships,
  });
});

/**
 * POST /api/v1/auth/change-password
 *
 * Serves both the forced first-login reset and a voluntary change. Revokes
 * every session the user holds and re-issues one for the caller: a password
 * change that leaves other devices signed in has not actually revoked
 * anything.
 */
authRouter.post('/change-password', zValidator('json', changePasswordSchema), async (c) => {
  const sessionUser = getSessionUser(c);
  if (!sessionUser) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const { currentPassword, newPassword } = c.req.valid('json');

  const user = await db.query.users.findFirst({ where: eq(users.id, sessionUser.id) });
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
    logger.warn('Failed password change', { userId: sessionUser.id, requestId: c.get('requestId') });
    return c.json({ error: 'Current password is incorrect' }, 401);
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), mustChangePassword: false })
    .where(eq(users.id, user.id));

  await revokeAllUserSessions(user.id);
  setSessionCookie(c, await issueSession(user.id, new Date()));

  logger.info('Password changed', { userId: user.id, requestId: c.get('requestId') });
  return c.json({ success: true });
});

export default authRouter;
