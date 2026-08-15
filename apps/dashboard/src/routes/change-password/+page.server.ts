import type { Actions, PageServerLoad } from './$types';
import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import { SESSION_COOKIE, parseSessionCookie } from '$lib/session';
import { sessionCookieOptions } from '$lib/server/session';
import { validatePasswordChange } from '$lib/password-form';

const API_URL = env.PUBLIC_API_URL || 'http://localhost:8080';

// `forced` drives the +page.svelte heading — "you must" vs. a voluntary
// change from an already-signed-in account. locals.user is populated by
// hooks.server.ts on every request, so this route works whether it was
// reached via the mustChangePassword redirect or navigated to directly.
export const load: PageServerLoad = ({ locals }) => {
  return { forced: locals.user?.mustChangePassword ?? false };
};

export const actions: Actions = {
  default: async ({ request, cookies, locals }) => {
    const form = await request.formData();
    const currentPassword = String(form.get('currentPassword') ?? '');
    const newPassword = String(form.get('newPassword') ?? '');
    const confirmPassword = String(form.get('confirmPassword') ?? '');

    // Local pre-flight before any API call — see lib/password-form.ts for
    // why (this is the tightest-rate-limited endpoint in the API). None of
    // the three fields is echoed back in the fail() payload below: unlike
    // login's `email`, there is nothing here worth re-populating, and every
    // one of these values is a password.
    const localError = validatePasswordChange({ currentPassword, newPassword, confirmPassword });
    if (localError) {
      return fail(400, { error: localError });
    }

    if (!locals.sessionToken) {
      // Not reachable through hooks.server.ts's gate — an unauthenticated
      // request never reaches this route, it's redirected to /login first —
      // but fail closed rather than send a Cookie header built from `null`.
      return fail(401, { error: 'Not signed in.' });
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Cookie: `${SESSION_COOKIE}=${locals.sessionToken}`,
    };
    // Same present-or-absent-never-empty contract as login/+page.server.ts:
    // an empty header would key every caller into one shared rate-limit
    // bucket, which is worse than omitting it. This route sits behind the
    // SAME authRateLimit (10 req/60s per IP, apps/api/src/routes/auth.ts) as
    // login, and onboarding — many users rotating temporary passwords at
    // once — is exactly when a shared bucket hurts most.
    if (locals.clientIp) headers['X-Forwarded-For'] = locals.clientIp;

    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/v1/auth/change-password`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ currentPassword, newPassword }),
      });
    } catch {
      return fail(503, { error: 'Cannot reach the Flackyness API. Is it running?' });
    }

    if (res.status === 429) {
      return fail(429, { error: 'Too many attempts. Wait a minute and try again.' });
    }

    if (!res.ok) {
      // Surfaces the API's own message (e.g. "Current password is
      // incorrect", "New password must differ from the current one") rather
      // than a generic one — unlike login, there is no enumeration risk here:
      // the caller is already an authenticated, identified user.
      let message = 'Could not change your password.';
      try {
        const body = (await res.json()) as { error?: unknown };
        // Not a `string` cast: @hono/zod-validator's own 400s (a
        // malformed body that reaches the API despite local validation)
        // answer `{ error: <ZodError object>, ... }`, not a string. Without
        // this guard, `message = body.error` would assign an object and the
        // user would see the literal text "[object Object]" instead of a
        // sensible fallback.
        if (typeof body.error === 'string') message = body.error;
      } catch {
        // Non-JSON body: fall through to the generic message rather than 500.
      }
      return fail(res.status, { error: message });
    }

    // The crux of this action: the API revokes every session on a successful
    // change and issues a fresh one (apps/api/src/routes/auth.ts's
    // change-password handler). The token this request was sent with is now
    // revoked — if we don't lift and set the NEW one here, the very next
    // request 401s and the user is signed out the instant they succeed.
    const fresh = parseSessionCookie(res.headers.get('set-cookie'));
    if (!fresh) {
      return fail(502, { error: 'The API did not return a new session. Check the API logs.' });
    }
    cookies.set(SESSION_COOKIE, fresh, sessionCookieOptions());

    throw redirect(303, '/');
  },
};
