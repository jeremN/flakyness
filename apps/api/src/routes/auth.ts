import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { setCookie, deleteCookie } from 'hono/cookie';
import { db, users } from '../db';
import { logger } from '../middleware/logger';
import { authRateLimit } from '../middleware/rate-limit';
import {
  sessionAuth,
  getSessionUser,
  issueSession,
  revokeSession,
  revokeAllUserSessions,
} from '../middleware/session';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../services/auth/password';
import { SESSION_COOKIE, SESSION_TTL_MS } from '../services/auth/session';

const authRouter = new Hono<{ Variables: { requestId: string } }>();

// Brute-force throttle FIRST, then session resolution. Order matters for the
// same reason it did in plan 043: a limiter mounted after the thing it
// protects is decorative.
authRouter.use('*', authRateLimit);
authRouter.use('*', sessionAuth());

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
 */
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('flackyness-dummy-password-for-timing-equalisation');
  return dummyHashPromise;
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
    // (same class of trap as plan 053's ORIGIN discovery). Operators serving
    // over TLS should set COOKIE_SECURE=true.
    secure: process.env.COOKIE_SECURE === 'true',
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
  const normalisedEmail = email.trim().toLowerCase();

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
    await verifyPassword(password, await dummyHash());
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

  return c.json({
    user: {
      ...publicUser(sessionUser),
      mustChangePassword: sessionUser.mustChangePassword,
    },
    teams: [] as { id: string; name: string; role: 'team_admin' | 'member' }[],
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
