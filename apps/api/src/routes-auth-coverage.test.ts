import { describe, it, expect, beforeAll } from 'vitest';
import app from './index';

/**
 * Fail-loud guard: every read endpoint has readAuth AND resolveAccess mounted.
 *
 * This is a STATIC SCAN of Hono's route table, not a test of request
 * behaviour. It asserts that the middleware is *mounted*, not that it
 * *works* — that is read-auth.test.ts's (and access-scope.test.ts's) job.
 *
 * Why it exists: plan 041 mounts readAuth route-by-route rather than
 * router-wide (design decision D4), because testsRouter is mixed — three
 * public reads plus an admin-gated PATCH — and a router-wide mount would
 * break the dashboard's mute action. Route-by-route mounting is the one
 * thing in this API that a developer must remember, and this repo has been
 * bitten twice by remember-to-register mistakes (ECharts series types,
 * Dependabot directory coverage), both silent, both caught only by a
 * reviewer mutating the source by hand. Both were fixed the same way: stop
 * relying on the convention, and make the gap fail CI. This is that guard.
 *
 * The risk is measured, not hypothetical: 4 of the 11 read routes postdate
 * the initial commit (verified with git log -S per route), and two of those
 * landed on the same day, 2026-07-13, from two different plans.
 *
 * Scope limit: the scan below filters on `method === 'GET'` and
 * `path.startsWith('/api/v1/')` — a route registered via `router.all(...)`
 * (any method) or mounted outside `/api/v1/` is invisible to this guard.
 */

// Read routes deliberately mounted WITHOUT a project resolver — they accept
// READ_TOKEN only. They still need readAuth mounted; they just pass no
// resolver. Listed here only to document intent; the assertion treats them
// like any other route.
const READ_TOKEN_ONLY = ['/api/v1/projects', '/api/v1/tests/flaky/:id'];

// Routes that gate themselves and must NOT mount readAuth (plan 056).
//
// GET /api/v1/auth/me returns the caller's own identity and 401s when there is
// no session. Mounting readAuth on it would demand a READ_TOKEN from a
// legitimately signed-in user on a closed deployment — i.e. it would break the
// only way the dashboard can discover who it is talking to.
//
// This is an explicit path allowlist, NOT a `/api/v1/auth` prefix filter, on
// purpose: a prefix would silently exempt every future auth route. A new entry
// here is a deliberate, reviewable edit — the same property EXPECTED_READ_ROUTE_COUNT
// exists to provide.
const SELF_GATED = ['/api/v1/auth/me'];

// Routes whose scope check CANNOT be verified statically: the target project
// is a property of a row, not of the request, so resolveAccess() is mounted
// without a resolver and the check lives in the handler
// (assertProjectReadable). Covered behaviourally by access-scope.test.ts.
const HANDLER_SCOPED = ['/api/v1/tests/flaky/:id'];

// The number of GET routes under /api/v1, excluding /admin/* (already gated
// by adminOrGlobalAdminAuth, plan 058 Task 5) and the static /api/v1 index.
// Bumping this is the point: a new read route forces a deliberate edit here,
// which forces a reviewer to ask whether readAuth was mounted.
const EXPECTED_READ_ROUTE_COUNT = 11;

function isReadAuthHandler(handler: unknown): boolean {
  return typeof handler === 'function' && (handler as { isReadAuth?: boolean }).isReadAuth === true;
}

// Plan 058 Task 3 mounts a SECOND per-route middleware (resolveAccess) after
// readAuth on every project-scoped read route. `app.routes` lists one entry
// per middleware layer, not one per logical route, so without also excluding
// this tag every scoped route would be double-counted here (once for
// resolveAccess, once for the terminal handler) — inflating readRoutes and
// breaking EXPECTED_READ_ROUTE_COUNT on a mount that added no new route.
// Task 6 (plan 058) adds the resolveAccess coverage assertion itself, below.
function isResolveAccessHandler(handler: unknown): boolean {
  return (
    typeof handler === 'function' && (handler as { isResolveAccess?: boolean }).isResolveAccess === true
  );
}

const readRoutes = app.routes.filter(
  (r) =>
    r.method === 'GET' &&
    r.path.startsWith('/api/v1/') &&
    !r.path.startsWith('/api/v1/admin') &&
    !SELF_GATED.includes(r.path) &&
    !isReadAuthHandler(r.handler) &&
    !isResolveAccessHandler(r.handler)
);

const readAuthPaths = new Set(
  app.routes.filter((r) => r.method === 'GET' && isReadAuthHandler(r.handler)).map((r) => r.path)
);

const resolveAccessPaths = new Set(
  app.routes.filter((r) => r.method === 'GET' && isResolveAccessHandler(r.handler)).map((r) => r.path)
);

describe('read-route auth coverage', () => {
  // Anti-vacuity. Both existing guards in this repo ship one and comment on
  // why: without it, a refactor that changes how routes are mounted leaves
  // this file green while asserting nothing at all.
  beforeAll(() => {
    if (app.routes.length === 0) {
      throw new Error(
        'app.routes is empty — the route table could not be read. This guard ' +
          'would pass vacuously. Hono’s internals or the app export changed; ' +
          'fix this test, do not delete it.'
      );
    }
    if (readRoutes.length !== EXPECTED_READ_ROUTE_COUNT) {
      throw new Error(
        `Expected ${EXPECTED_READ_ROUTE_COUNT} GET routes under /api/v1 (excluding ` +
          `/admin), found ${readRoutes.length}: ${readRoutes.map((r) => r.path).join(', ')}. ` +
          'If you added or removed a read route, update EXPECTED_READ_ROUTE_COUNT ' +
          'in this file — deliberately, after checking readAuth is mounted on it.'
      );
    }
  });

  it.each(readRoutes.map((r) => r.path))('has readAuth mounted: GET %s', (path) => {
    expect(
      readAuthPaths.has(path),
      `GET ${path} has no readAuth mounted. Every read endpoint must be mounted as\n` +
        `  router.get('<path>', readAuth(<resolver>), handler)\n` +
        `where <resolver> reads the target project out of the request — c.req.param('id')\n` +
        `for /projects/:id/* routes, c.req.query('project') for /tests/:testName/* routes.\n` +
        `Routes that are not scoped to one project (${READ_TOKEN_ONLY.join(', ')}) pass no\n` +
        `resolver, but still mount readAuth().\n\n` +
        `Without it, this endpoint stays readable by anyone who can reach the API even\n` +
        `when the operator has set READ_TOKEN — silently, with no error anywhere.`
    ).toBe(true);
  });

  it('detects a known-covered route (guard is not vacuous)', () => {
    expect(readAuthPaths.has('/api/v1/projects/:id/stats')).toBe(true);
  });

  it.each(readRoutes.map((r) => r.path))('has resolveAccess mounted: GET %s', (path) => {
    expect(
      resolveAccessPaths.has(path),
      `GET ${path} has no resolveAccess mounted. Every read endpoint must be mounted as\n` +
        `  router.get('<path>', readAuth(<resolver>), resolveAccess(<resolver>), handler)\n` +
        `sharing the SAME resolver. readAuth answers "may you read at all?" (READ_TOKEN\n` +
        `posture); resolveAccess answers "which projects?" (team membership).\n\n` +
        `Without it this endpoint returns another team's data to any signed-in user —\n` +
        `a 200 with plausible content, which no behavioural test will flag. See plan 058.\n\n` +
        `Routes on the HANDLER_SCOPED allowlist (${HANDLER_SCOPED.join(', ')}) legitimately\n` +
        `mount resolveAccess() with no resolver — the target project there is a property of\n` +
        `a row, not the request, so the scope check lives in the handler via\n` +
        `assertProjectReadable instead. The isResolveAccess tag is still set regardless of\n` +
        `whether a resolver was passed, so this loop covers their mount point too; the\n` +
        `handler-level check itself is covered behaviourally by access-scope.test.ts, not\n` +
        `by this static scan.\n\n` +
        `If the target project is only knowable after a database lookup, mount\n` +
        `resolveAccess() with no resolver, call assertProjectReadable() in the handler,\n` +
        `and add the path to HANDLER_SCOPED above with a covering test in\n` +
        `access-scope.test.ts.`
    ).toBe(true);
  });

  it('detects a known-covered route for resolveAccess (guard is not vacuous)', () => {
    expect(resolveAccessPaths.has('/api/v1/projects/:id/stats')).toBe(true);
  });

  it.each(SELF_GATED)('self-gated route still exists and gates itself: GET %s', (path) => {
    const mounted = app.routes.some((r) => r.method === 'GET' && r.path === path);
    expect(
      mounted,
      `${path} is on the SELF_GATED allowlist but is not mounted. Either the route was ` +
        'renamed (update the allowlist) or removed (delete the entry) — a stale entry ' +
        'exempts nothing and hides the next route that lands on that path.'
    ).toBe(true);
  });
});
