import { fail, redirect, type Actions } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { SESSION_COOKIE, SESSION_COOKIE_PATH, parseSessionCookie } from '$lib/session';

const API_URL = env.PUBLIC_API_URL || 'http://localhost:8080';

export const actions: Actions = {
  default: async ({ request, cookies, locals }) => {
    const form = await request.formData();
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');

    if (!email || !password) {
      return fail(400, { email, error: 'Enter your email and password.' });
    }

    // Every other dashboard→API call threads the browser's address through
    // (lib/server/api.ts, adminApi.ts, session.ts's fetchMe — 20+ call
    // sites, all via locals.clientIp) so the API's per-IP rate limiters key
    // on the real caller, not the dashboard container. This raw fetch sits
    // outside that shared layer, so it has to be threaded by hand — and this
    // is the tightest-limited endpoint in the API (authRateLimit, 10 req/60s
    // per IP), so skipping it is the worst place to skip it. Present-or-
    // absent-never-empty: an empty header would key every such request into
    // one shared bucket, which is worse than omitting it.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (locals.clientIp) headers['X-Forwarded-For'] = locals.clientIp;

    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, password }),
      });
    } catch {
      return fail(503, { email, error: 'Cannot reach the Flackyness API. Is it running?' });
    }

    if (res.status === 429) {
      // A 429 discloses nothing about accounts — it's purely a rate-limit
      // fact, never a credential fact — so it must not fall into the generic
      // 401 branch below. Kept as its own branch so the X-Forwarded-For
      // threading above regressing (which would collapse every caller onto
      // the dashboard container's own IP and its one shared 10-req/60s
      // budget) fails loudly as a rate-limit message instead of quietly
      // telling a whole team their passwords are wrong.
      return fail(429, { email, error: 'Too many sign-in attempts. Wait a minute and try again.' });
    }

    if (!res.ok) {
      // Deliberately generic and identical for "no such account" and "wrong
      // password" — the API already refuses to distinguish them, and echoing
      // a more helpful message here would reintroduce the enumeration oracle
      // it closed. Note `password` is NOT returned: a failed form re-render
      // must not put it back in the DOM.
      return fail(401, { email, error: 'Invalid email or password.' });
    }

    const token = parseSessionCookie(res.headers.get('set-cookie'));
    if (!token) {
      return fail(502, { email, error: 'The API did not return a session. Check the API logs.' });
    }

    let body: { mustChangePassword: boolean };
    try {
      body = (await res.json()) as { mustChangePassword: boolean };
    } catch {
      // Not reachable against this API today, but every neighbouring
      // failure mode here has a deliberate fail() branch — an unparsable
      // 200 body shouldn't be the one way this action can 500, especially
      // since it would happen after the token was already lifted but before
      // the cookie is set.
      return fail(502, { email, error: 'The API returned an unreadable response. Check the API logs.' });
    }

    cookies.set(SESSION_COOKIE, token, {
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
      sameSite: 'lax',
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
    });

    throw redirect(303, body.mustChangePassword ? '/change-password' : '/');
  },
};
