import { createHash, randomBytes } from 'crypto';

/** Cookie name. Referenced by the dashboard (plan 059) and docs/API.md. */
export const SESSION_COOKIE = 'fk_session';

/**
 * Inactivity window, not an absolute lifetime — the slide below pushes it out
 * on use, so an active session never expires and there is deliberately NO
 * hard cap on total age. Do not go looking for one.
 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Only refresh `last_seen_at`/`expires_at` once the stamp is older than this.
 *
 * Without a threshold, every authenticated request would issue an UPDATE — and
 * the dashboard emits 2–5 API calls per page view (see the readAuth comment in
 * middleware/auth.ts). One hour keeps an active session permanently alive
 * while making the write rare.
 */
export const SESSION_SLIDE_AFTER_MS = 60 * 60 * 1000;

/** 256 bits, hex-encoded. Delivered raw in the cookie; never stored raw. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

/** SHA-256 hex — same shape and column width as projects.token_hash. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sessionExpiry(now: Date): Date {
  return new Date(now.getTime() + SESSION_TTL_MS);
}

/**
 * Expiry is inclusive: a session whose `expires_at` is exactly now is dead.
 * Erring toward dead is the safe direction for a credential.
 */
export function isSessionExpired(session: { expiresAt: Date }, now: Date): boolean {
  return session.expiresAt.getTime() <= now.getTime();
}

export function shouldSlideSession(session: { lastSeenAt: Date }, now: Date): boolean {
  return now.getTime() - session.lastSeenAt.getTime() > SESSION_SLIDE_AFTER_MS;
}
