import type { SessionUser } from '../app.d';

/** Must match the API's SESSION_COOKIE (apps/api/src/services/auth/session.ts). */
export const SESSION_COOKIE = 'fk_session';

/**
 * The path every session-cookie write and delete must use — login's
 * cookies.set, the gate's cookies.delete, and /logout.
 *
 * A cookie deletion only matches a cookie set with the identical path, so
 * this MUST be a single shared constant, not a literal repeated at each call
 * site: two independently-edited `'/'` literals can drift into a mismatch
 * with each side's own tests staying green (each test only pins its own
 * file's literal), silently resurrecting the stale-credential loop the
 * delete exists to break. See the Task 4 review, plan 059.
 */
export const SESSION_COOKIE_PATH = '/';

/**
 * Lift the session token out of the API's `Set-Cookie` response header.
 *
 * The API's cookie is scoped to the API's origin and never reaches the
 * browser — the dashboard sets its own cookie on its own origin. The word
 * boundary in the pattern matters: without it, a cookie named
 * `not_fk_session` would match.
 */
export function parseSessionCookie(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(new RegExp(`(?:^|[;,\\s])${SESSION_COOKIE}=([^;,\\s]+)`));
  return match?.[1] ?? null;
}

/**
 * Pages reachable without a completed password change.
 *
 * Exported so session.test.ts can assert every entry here has a matching row
 * in its ESCAPE_HATCH_API_CALLS contract table — otherwise a new hatch route
 * ships with no check that its API calls are on the password-change
 * allowlist.
 */
export const ESCAPE_HATCHES = ['/change-password', '/logout'];

/**
 * Where should this request be redirected, or null to let it through?
 *
 * Extracted from hooks.server.ts so the routing rules are unit-testable
 * without a running server — the same reasoning that made plan 031's
 * now-removed `checkBasicAuth` a pure module.
 */
export function redirectTargetFor(user: SessionUser | null, pathname: string): string | null {
  if (!user) return pathname === '/login' ? null : '/login';
  if (pathname === '/login') return '/';
  if (user.mustChangePassword && !ESCAPE_HATCHES.includes(pathname)) return '/change-password';
  return null;
}
