import { env } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { SESSION_COOKIE, SESSION_COOKIE_PATH } from '../session';
import type { SessionUser, TeamSummary } from '../../app.d';

const API_URL = env.PUBLIC_API_URL || 'http://localhost:8080';

/**
 * Validate a session token against the API and return who it belongs to.
 *
 * Returns null for an invalid/expired session AND for an unreachable API. The
 * dashboard is not the security boundary — when it cannot confirm an identity
 * it must fail closed, and the caller redirects to /login. A five-second
 * timeout keeps a hung API from hanging every page load.
 */
export async function fetchMe(
  sessionToken: string,
  clientIp: string | null
): Promise<{ user: SessionUser; teams: TeamSummary[] } | null> {
  try {
    const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${sessionToken}` };
    // Delta §D1.2. This call runs in hooks.server.ts on EVERY request, so it is
    // the single largest contributor to the shared-bucket problem Task 0 fixes.
    if (clientIp) headers['X-Forwarded-For'] = clientIp;

    const res = await fetch(`${API_URL}/api/v1/auth/me`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { user: SessionUser; teams: TeamSummary[] };
  } catch {
    return null;
  }
}

/**
 * The full cookie-options object every session-cookie write must use.
 *
 * Extracted so login's `cookies.set` and change-password's re-issued-cookie
 * `cookies.set` cannot independently drift (Task 5 review, plan 059) — this
 * will be the fourth session-cookie site once Task 6 adds `/logout`. Lives
 * here rather than in the pure `lib/session.ts` because `secure` reads
 * `$env/dynamic/private`, which the browser-safe module must never import.
 */
export function sessionCookieOptions() {
  return {
    // Load-bearing, and must stay identical to the gate's
    // `cookies.delete(SESSION_COOKIE, { path: SESSION_COOKIE_PATH })` in
    // hooks.server.ts — both now read the same exported constant
    // (lib/session.ts) instead of independently hand-typed '/' literals,
    // so they cannot drift apart the way two local literals could. A
    // cookie deletion only matches a cookie with the same path, so a
    // mismatch here would silently resurrect the stale-credential loop
    // that delete exists to break: the API keeps rejecting the dead
    // session and the browser keeps presenting it, one wasted round-trip
    // per page view, forever. Noted 2026-08-15 by the Task 3 review.
    path: SESSION_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'lax' as const,
    // Deliberately two-way (unset → not secure) — this does NOT mirror the
    // API's isCookieSecure() (apps/api/src/routes/auth.ts), which is
    // three-way and falls back to NODE_ENV === 'production' when unset.
    // That fallback is safe for the API's own cookie because it's consumed
    // server-side by parseSessionCookie and never reaches a browser. This
    // cookie is the one the browser actually holds: docker-compose.yml
    // sets NODE_ENV=production with a plain-http ORIGIN, so adopting the
    // API's default here would mark this cookie Secure over plain http —
    // the browser silently drops it, and login breaks on that documented
    // deployment. Read via $env/dynamic/private (not process.env, which
    // appears nowhere else in src/) so this is stubbable the same way
    // every other server module's env read is.
    secure: privateEnv.COOKIE_SECURE === 'true',
    maxAge: 7 * 24 * 60 * 60,
  };
}
