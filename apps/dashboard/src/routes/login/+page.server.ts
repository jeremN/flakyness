import { fail, redirect, type Actions } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { SESSION_COOKIE, parseSessionCookie } from '$lib/session';

const API_URL = env.PUBLIC_API_URL || 'http://localhost:8080';

export const actions: Actions = {
  default: async ({ request, cookies }) => {
    const form = await request.formData();
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');

    if (!email || !password) {
      return fail(400, { email, error: 'Enter your email and password.' });
    }

    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    } catch {
      return fail(503, { email, error: 'Cannot reach the Flackyness API. Is it running?' });
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

    const body = (await res.json()) as { mustChangePassword: boolean };

    cookies.set(SESSION_COOKIE, token, {
      // Load-bearing, and must stay identical to the gate's
      // `cookies.delete(SESSION_COOKIE, { path: '/' })` in hooks.server.ts.
      // A cookie deletion only matches a cookie with the same path, so a
      // mismatch here silently resurrects the stale-credential loop that
      // delete exists to break: the API keeps rejecting the dead session and
      // the browser keeps presenting it, one wasted round-trip per page view,
      // forever. Noted 2026-08-15 by the Task 3 review.
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      // Mirrors the API's COOKIE_SECURE: over plain http the browser silently
      // drops a Secure cookie, and the docker-compose default and the E2E
      // build are both plain http. Read via $env/dynamic/private (not
      // process.env, which appears nowhere else in src/) so this is stubbable
      // the same way every other server module's env read is.
      secure: privateEnv.COOKIE_SECURE === 'true',
      maxAge: 7 * 24 * 60 * 60,
    });

    throw redirect(303, body.mustChangePassword ? '/change-password' : '/');
  },
};
