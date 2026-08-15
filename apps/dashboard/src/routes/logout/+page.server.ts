import { redirect, type Actions } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import { SESSION_COOKIE, SESSION_COOKIE_PATH } from '$lib/session';

const API_URL = env.PUBLIC_API_URL || 'http://localhost:8080';

export const actions: Actions = {
  default: async ({ cookies, locals }) => {
    if (locals.sessionToken) {
      // Best-effort: revoke server-side too. A failure here still signs the
      // user out locally — leaving the browser holding a live cookie because
      // the API hiccuped would be the worse outcome.
      const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${locals.sessionToken}` };
      // Same present-or-absent-never-empty contract as every other
      // dashboard->API call site (login, change-password): an empty header
      // would key every such request into one shared rate-limit bucket,
      // which is worse than omitting it.
      if (locals.clientIp) headers['X-Forwarded-For'] = locals.clientIp;
      try {
        await fetch(`${API_URL}/api/v1/auth/logout`, {
          method: 'POST',
          headers,
        });
      } catch {
        /* fall through to clearing the cookie */
      }
    }
    // SESSION_COOKIE_PATH, not a bare '/' literal — this is the FOURTH
    // session-cookie site (after hooks.server.ts's gate delete, login's set,
    // and change-password's re-issued set) and must match all three: a
    // cookie deletion only matches a cookie set with the identical path, so
    // an independently-typed literal here risks silently resurrecting the
    // stale-credential loop the delete exists to break.
    cookies.delete(SESSION_COOKIE, { path: SESSION_COOKIE_PATH });
    throw redirect(303, '/login');
  },
};
