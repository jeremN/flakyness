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

  if (token && !me) {
    // The API rejected it (expired, revoked) or was unreachable. Drop the
    // cookie so the browser stops presenting a dead credential on every
    // request — otherwise a revoked session costs an API round-trip per page
    // view, forever.
    event.cookies.delete(SESSION_COOKIE, { path: SESSION_COOKIE_PATH });
  }

  event.locals.user = me?.user ?? null;
  event.locals.teams = me?.teams ?? [];
  event.locals.sessionToken = me ? token : null;
  event.locals.clientIp = clientIp;

  const target = redirectTargetFor(event.locals.user, event.url.pathname);
  if (target) throw redirect(303, target);

  return resolve(event);
};
