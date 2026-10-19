import { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { db, users, sessions } from '../db';
import { logger } from './logger';
import {
  SESSION_COOKIE,
  generateSessionToken,
  hashSessionToken,
  sessionExpiry,
  isSessionExpired,
  isSessionStale,
  shouldSlideSession,
} from '../services/auth/session';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  isGlobalAdmin: boolean;
  mustChangePassword: boolean;
  /** The session row backing this request — needed by logout. */
  sessionId: string;
}

/**
 * Resolve the `fk_session` cookie into a user, if it names a live session.
 *
 * Never rejects on credential state: an absent, unknown, or expired cookie is
 * simply anonymous. Rejecting on those is the job of whatever guard sits
 * downstream — this middleware only answers "who is this?". Mounting it on
 * `*` therefore cannot break any existing unauthenticated route, which is
 * what makes Phase A a zero-behavior-change increment.
 *
 * The two writes below (the expired-session reap, and the sliding-TTL touch)
 * are best-effort: their errors are caught and logged rather than thrown, so
 * a bookkeeping failure can never fail an otherwise-valid — or otherwise-
 * anonymous — request. The initial SELECT is the deliberate exception and is
 * NOT guarded: its failure means the database itself is unreachable, and
 * every route that needs auth needs the database anyway, so silently
 * downgrading to anonymous here would be a fail-open security regression
 * rather than a graceful degradation.
 */
export function sessionAuth(): MiddlewareHandler {
  return async (c: Context, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return await next();

    const now = new Date();
    const row = await db
      .select({
        sessionId: sessions.id,
        expiresAt: sessions.expiresAt,
        lastSeenAt: sessions.lastSeenAt,
        sessionPasswordVersion: sessions.passwordVersion,
        userPasswordVersion: users.passwordVersion,
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        isGlobalAdmin: users.isGlobalAdmin,
        mustChangePassword: users.mustChangePassword,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.tokenHash, hashSessionToken(token)))
      .limit(1);

    const found = row[0];
    if (!found) return await next();

    // A stale session was minted from a password that has since changed
    // (backlog #29): a login that read the old hash before a change or reset
    // can insert its row AFTER the revoke DELETE. The epoch check kills that
    // row here, without serialising logins. Handled exactly like expiry.
    const expired = isSessionExpired(found, now);
    if (expired || isSessionStale(found)) {
      // Best-effort reap: whether or not the DELETE lands, the session IS
      // dead, so the request proceeds anonymous either way. Treating a
      // failed delete as "still valid" would be a security regression.
      try {
        await db.delete(sessions).where(eq(sessions.id, found.sessionId));
      } catch (err) {
        logger.warn(expired ? 'Failed to reap expired session' : 'Failed to reap stale session', {
          sessionId: found.sessionId,
          error: err instanceof Error ? { name: err.name, message: err.message } : undefined,
        });
      }
      return await next();
    }

    if (shouldSlideSession(found, now)) {
      // Best-effort slide: this is bookkeeping on an already-valid session,
      // not a precondition for it. A failed UPDATE must not fail the request
      // — the session stays valid, just with a stale lastSeenAt/expiresAt.
      try {
        await db
          .update(sessions)
          .set({ lastSeenAt: now, expiresAt: sessionExpiry(now) })
          .where(eq(sessions.id, found.sessionId));
      } catch (err) {
        logger.warn('Failed to slide session TTL', {
          sessionId: found.sessionId,
          error: err instanceof Error ? { name: err.name, message: err.message } : undefined,
        });
      }
    }

    c.set('sessionUser', {
      id: found.id,
      email: found.email,
      displayName: found.displayName,
      isGlobalAdmin: found.isGlobalAdmin,
      mustChangePassword: found.mustChangePassword,
      sessionId: found.sessionId,
    } satisfies SessionUser);

    await next();
  };
}

export function getSessionUser(c: Context): SessionUser | null {
  return (c.get('sessionUser') as SessionUser | undefined) ?? null;
}

/**
 * Insert a session row and return the RAW token for the Set-Cookie header.
 *
 * `passwordVersion` MUST come from the same user row whose hash the caller
 * verified (or from the UPDATE that just set it). Re-reading it here would
 * pick up a newer version and defeat the epoch check in sessionAuth.
 */
export async function issueSession(
  userId: string,
  passwordVersion: number,
  now: Date
): Promise<string> {
  const token = generateSessionToken();
  await db.insert(sessions).values({
    userId,
    passwordVersion,
    tokenHash: hashSessionToken(token),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: sessionExpiry(now),
  });
  return token;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/**
 * Revoke every session a user holds. Called on password change: a credential
 * change that leaves old sessions alive does not actually evict anyone.
 */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
