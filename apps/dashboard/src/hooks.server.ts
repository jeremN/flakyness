import { redirect, type Handle } from '@sveltejs/kit';
import { SESSION_COOKIE, SESSION_COOKIE_PATH, redirectTargetFor } from '$lib/session';
import { fetchMe } from '$lib/server/session';

/**
 * The single authentication gate for the dashboard (plan 059).
 *
 * Replaces the shared DASHBOARD_PASSWORD Basic Auth from plan 031. That hook
 * existed to close a confused deputy — an anonymous POST could mute a test,
 * and a muted test feeds the CI quarantine skip-list. The same property holds
 * here and is now stronger: the API itself authorizes per user (plan 058), so
 * the dashboard is no longer the only thing standing in the way.
 *
 * Runs in front of EVERY route by construction, so no per-route check is
 * needed or wanted.
 */
export const handle: Handle = async ({ event, resolve }) => {
  const token = event.cookies.get(SESSION_COOKIE) ?? null;

  // Delta §D1.2. Read once here and thread it through locals: this is the only
  // place the browser's address is available. adapter-node derives it from
  // ADDRESS_HEADER/XFF_DEPTH when the dashboard is itself behind a proxy —
  // those are the operator's existing knobs and this does not change them.
  const clientIp = event.getClientAddress();

  const me = token ? await fetchMe(token, clientIp) : null;

  // Task 8 fix round 1: the cookie is only deleted when the API positively
  // REJECTED it (401/403 — expired, revoked; me.rejected === true). A 429,
  // 5xx, or unreachable API (me.rejected === false) means "no answer", not
  // "dead credential" — deleting the cookie there would sign a user out for
  // a transient failure and leave them signed out even after the API
  // recovers, since the credential is now gone from the browser. Both cases
  // still fail closed for THIS request (locals.user stays null below,
  // unchanged) — only the cookie's survival differs.
  if (token && me && !me.ok && me.rejected) {
    event.cookies.delete(SESSION_COOKIE, { path: SESSION_COOKIE_PATH });
  }

  event.locals.user = me?.ok ? me.user : null;
  event.locals.teams = me?.ok ? me.teams : [];
  event.locals.sessionToken = me?.ok ? token : null;
  event.locals.clientIp = clientIp;

  const target = redirectTargetFor(event.locals.user, event.url.pathname);
  if (target) throw redirect(303, target);

  const response = await resolve(event);

  // Task 8 fix round 1: without this, Chromium's back-forward cache (bfcache)
  // can restore an authenticated page verbatim after sign-out on a back
  // navigation — this hook never re-runs for a bfcache restore, since it
  // replays the frozen page rather than issuing a new request. Scoped to HTML
  // document responses via Content-Type, not by path: static assets
  // (including content-hashed `_app/immutable/*`) get a different
  // content-type and must stay cacheable — this never touches them. Applied
  // uniformly to every document response (not just while signed in) so
  // there's one rule to reason about; /login gets it too, which is harmless.
  if (response.headers.get('content-type')?.startsWith('text/html')) {
    response.headers.set('Cache-Control', 'no-store');
  }

  return response;
};
