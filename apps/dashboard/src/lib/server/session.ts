import { env } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { SESSION_COOKIE, SESSION_COOKIE_PATH } from '../session';
import type { SessionUser, TeamSummary } from '../../app.d';

const API_URL = env.PUBLIC_API_URL || 'http://localhost:8080';

/**
 * The three possible outcomes of validating a session token against the API.
 *
 * `rejected: true` means the API positively refused this credential — it is
 * dead and re-presenting it will only be refused again, so the caller may
 * delete the cookie. `rejected: false` means the API gave no answer at all
 * (rate-limited, erroring, unreachable, timed out) — the credential's
 * validity is simply unknown, so the caller must NOT delete the cookie: the
 * same session may well be valid the moment the API answers again. Found
 * 2026-08-15 (Task 8 fix round 1): collapsing these two into one `null` made
 * `hooks.server.ts` delete a live session's cookie on a transient 429/5xx,
 * signing a user out permanently for a problem that would have cleared
 * itself on the next request.
 */
export type MeResult =
  | { ok: true; user: SessionUser; teams: TeamSummary[] }
  | { ok: false; rejected: true }
  | { ok: false; rejected: false };

/**
 * Validate a session token against the API and return who it belongs to.
 *
 * `ok: false` covers both an invalid/expired session AND an unreachable API —
 * the dashboard is not the security boundary, so when it cannot confirm an
 * identity it must fail closed either way, and the caller redirects to
 * /login for both. `rejected` distinguishes them ONLY for the cookie's own
 * fate — see `MeResult`. A five-second timeout keeps a hung API from hanging
 * every page load; a timeout is treated as `rejected: false` (no answer),
 * same as any other network failure.
 */
export async function fetchMe(sessionToken: string, clientIp: string | null): Promise<MeResult> {
  try {
    const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${sessionToken}` };
    // Delta §D1.2. This call runs in hooks.server.ts on EVERY request, so it is
    // the single largest contributor to the shared-bucket problem Task 0 fixes.
    if (clientIp) headers['X-Forwarded-For'] = clientIp;

    const res = await fetch(`${API_URL}/api/v1/auth/me`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    // Only a positive refusal of THIS credential counts as rejected. Every
    // other non-2xx (429 rate-limited, 5xx, or anything else) is "no answer",
    // not "invalid" — see MeResult.
    if (res.status === 401 || res.status === 403) return { ok: false, rejected: true };
    if (!res.ok) return { ok: false, rejected: false };
    const body = (await res.json()) as { user: SessionUser; teams: TeamSummary[] };
    return { ok: true, user: body.user, teams: body.teams };
  } catch {
    // Network error or the timeout above — no answer, not a refusal.
    return { ok: false, rejected: false };
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
