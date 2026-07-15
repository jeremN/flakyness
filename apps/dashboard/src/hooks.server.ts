import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { checkBasicAuth } from '$lib/server/basicAuth';

// See plan 031: the dashboard holds ADMIN_TOKEN and spends it on behalf of
// whoever submits the `flaky` page's mute/unmute form action. Without a gate
// here, `if (!env.ADMIN_TOKEN)` in that route only proves the *server* has a
// token — not that the *requester* presented one — so anyone who can load
// the dashboard can mute a test, and muted tests feed the CI quarantine
// skip-list (plan 020). This hook is the entire fix: it runs in front of
// EVERY route by construction, so no per-route check is needed or wanted.
const DASHBOARD_PASSWORD = env.DASHBOARD_PASSWORD;

// Fires once, at server start (this module is evaluated once per server
// process), not per-request — loud enough that an operator can't miss it in
// the boot log, but doesn't spam every request. A missing DASHBOARD_PASSWORD
// is still a valid choice for a genuinely single-operator, network-isolated
// deployment (see design decision 2 in plan 031) — this warns without
// hard-failing.
if (!DASHBOARD_PASSWORD && env.ADMIN_TOKEN) {
  console.warn(
    '[flackyness] SECURITY WARNING: ADMIN_TOKEN is set but DASHBOARD_PASSWORD is not. ' +
      'This dashboard exposes an unauthenticated privileged write path (mute/unmute a ' +
      'flaky test, which feeds the CI quarantine skip-list) to anyone who can reach it. ' +
      'Set DASHBOARD_PASSWORD to require HTTP Basic Auth on every dashboard route, or ' +
      'confirm this deployment is genuinely network-isolated. See docs/GETTING_STARTED.md.'
  );
}

export const handle: Handle = async ({ event, resolve }) => {
  // Unset DASHBOARD_PASSWORD means "no gate" — unchanged behavior from
  // before this plan (see design decision 1 in plan 031).
  if (!DASHBOARD_PASSWORD) return resolve(event);

  const authHeader = event.request.headers.get('authorization');
  if (!checkBasicAuth(authHeader, DASHBOARD_PASSWORD)) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Flackyness"' },
    });
  }

  return resolve(event);
};
