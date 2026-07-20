import { describe, it, expect, beforeAll } from 'vitest';
import app from './index';

/**
 * Fail-loud guard: every read endpoint has readAuth mounted.
 *
 * This is a STATIC SCAN of Hono's route table, not a test of request
 * behaviour. It asserts that the middleware is *mounted*, not that it
 * *works* — that is read-auth.test.ts's job.
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

// The number of GET routes under /api/v1, excluding /admin/* (already gated
// by adminAuth) and the static /api/v1 index. Bumping this is the point: a
// new read route forces a deliberate edit here, which forces a reviewer to
// ask whether readAuth was mounted.
const EXPECTED_READ_ROUTE_COUNT = 11;

function isReadAuthHandler(handler: unknown): boolean {
  return typeof handler === 'function' && (handler as { isReadAuth?: boolean }).isReadAuth === true;
}

const readRoutes = app.routes.filter(
  (r) =>
    r.method === 'GET' &&
    r.path.startsWith('/api/v1/') &&
    !r.path.startsWith('/api/v1/admin') &&
    !isReadAuthHandler(r.handler)
);

const readAuthPaths = new Set(
  app.routes.filter((r) => r.method === 'GET' && isReadAuthHandler(r.handler)).map((r) => r.path)
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
});
