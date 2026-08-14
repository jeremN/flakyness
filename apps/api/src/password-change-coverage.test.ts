import { describe, it, expect, beforeAll } from 'vitest';
import app from './index';
import { PASSWORD_CHANGE_ALLOWLIST } from './services/auth/access';
import { reportRateLimit, apiRateLimit, authRateLimit, adminRateLimit } from './middleware/rate-limit';

/**
 * Fail-loud guard: every /api/v1 router mounts passwordChangeGate().
 *
 * Layer 2 is now SEVEN mounts rather than one global one (see the mount-point
 * comment in middleware/password-change.ts for why a global mount is wrong).
 * Seven places to forget is six more than one, so the forgetting is what gets
 * automated away here.
 *
 * This is a RUNTIME scan of Hono's route table, not a source-text scan — so
 * unlike the plan-058 admin-scope guard it needs no `stryMutAct_` skip: Stryker
 * instruments the source, but app.routes still reports the same paths.
 *
 * Verified mechanism: a router's `use('*', mw)` registration surfaces in
 * app.routes as an `ALL /api/v1/<mount>/*` entry.
 */

// The complete set of app.route('/api/v1/...') mounts in index.ts:143-152.
// Adding a router without adding it here fails the count assertion below;
// adding it here without mounting the gate fails the per-mount assertion.
const EXPECTED_GATE_MOUNTS = [
  '/api/v1/reports/*',
  '/api/v1/projects/*',
  '/api/v1/tests/*',
  '/api/v1/admin/users/*',
  '/api/v1/admin/teams/*',
  '/api/v1/admin/*',
  '/api/v1/auth/*',
];

function isGateHandler(handler: unknown): boolean {
  return (
    typeof handler === 'function' &&
    (handler as { isPasswordChangeGate?: boolean }).isPasswordChangeGate === true
  );
}

const gatePaths = new Set(app.routes.filter((r) => isGateHandler(r.handler)).map((r) => r.path));

// Which rate limiter is expected to precede the gate at each mount, keyed by
// reference identity — each `*RateLimit` export is a single
// `createRateLimit(...)` call result (middleware/rate-limit.ts:86,98,110,173),
// i.e. a module-level singleton, not a factory, so `===` reliably picks out
// that exact registration in app.routes rather than a different call to the
// same factory.
const EXPECTED_GATE_ORDER: ReadonlyArray<readonly [string, unknown]> = [
  ['/api/v1/reports/*', reportRateLimit],
  ['/api/v1/projects/*', apiRateLimit],
  ['/api/v1/tests/*', apiRateLimit],
  ['/api/v1/admin/users/*', adminRateLimit],
  ['/api/v1/admin/teams/*', adminRateLimit],
  ['/api/v1/admin/*', adminRateLimit],
  ['/api/v1/auth/*', apiRateLimit],
];

// Terminal route registrations under /api/v1/auth — everything else registered
// as `ALL` is a middleware LAYER (apiRateLimit, authRateLimit, or the gate),
// not a route, and is excluded by reference identity rather than by a blanket
// `method !== 'ALL'`. A blanket exclusion would silently swallow a future
// `authRouter.all('/webhook', handler)`: it registers as `ALL` too, so it
// would vanish from this list and never be forced through the allowlist
// decision below — precisely the silent drift this guard exists to forbid.
function isKnownAuthMiddleware(handler: unknown): boolean {
  return handler === apiRateLimit || handler === authRateLimit || isGateHandler(handler);
}

/**
 * The methods a single route registration is actually REACHABLE by.
 *
 * Hono answers HEAD from a GET route — measured on 4.12.33: `HEAD` against a
 * `GET` handler returns 200 and middleware observes `c.req.method === 'HEAD'`.
 * So one `GET` registration is two reachable requests, and both need an
 * explicit allowlist decision. Without this expansion the guard would demand
 * that `HEAD /api/v1/auth/me` be *removed* from the allowlist (it is not in
 * the route table), and removing it 403s every HEAD probe of /me for a
 * mid-reset caller.
 *
 * `OPTIONS` is deliberately NOT expanded: `cors()` is mounted globally at
 * index.ts:29 ahead of every router and answers preflight itself with a 204,
 * so an OPTIONS request never reaches the gate at all (measured; pinned in
 * middleware/password-change.test.ts).
 */
function reachableMethods(method: string): readonly string[] {
  return method === 'GET' ? ['GET', 'HEAD'] : [method];
}

const format = (method: string, path: string) => `${method} ${path}`;

// METHOD+PATH pairs, not bare paths. Deduping into a Set of PATHS — which this
// did until final review — makes the guard blind to a new METHOD on an
// already-listed path: a future `DELETE /api/v1/auth/me` would not change the
// set, CI would stay green, and the path-only exemption would have admitted it
// mid-reset without anyone deciding so.
const authRoutes = [
  ...new Set(
    app.routes
      .filter((r) => r.path.startsWith('/api/v1/auth/'))
      .filter((r) => !(r.method === 'ALL' && isKnownAuthMiddleware(r.handler)))
      .flatMap((r) => reachableMethods(r.method).map((m) => format(m, r.path)))
  ),
].sort();

/**
 * Auth routes that exist and are deliberately NOT part of password recovery.
 *
 * Empty today, and that is fine — its job is to exist. The assertion below
 * compares the live auth route table against the UNION of this list and
 * PASSWORD_CHANGE_ALLOWLIST, which makes "refuse it" a one-line answer.
 *
 * Why that matters, and why the old exact-equality-against-the-allowlist form
 * was actively dangerous: its comment blessed a two-outcome decision ("either
 * add it to the allowlist, or leave it out and it is correctly refused"), but
 * only ONE of those outcomes made the test green. Leaving a new route out left
 * CI red with no obvious remedy except appending to the allowlist — i.e. the
 * lowest-friction way to get green was the insecure direction.
 *
 * That is not hypothetical. The obvious next auth route once accounts exist is
 * `POST /api/v1/auth/tokens`. Reflexively allowlisting it would let a mid-reset
 * session mint a bearer credential carrying NO mustChangePassword flag at all
 * (every token-kind `Access` spreads `anonymousAccess()`), a complete and
 * permanent escape from the boundary — reached by making a red test green.
 *
 * Adding an entry here is still a deliberate, reviewed edit. It just stops
 * being a *harder* edit than the unsafe one.
 */
export const AUTH_ROUTES_DELIBERATELY_REFUSED: readonly string[] = [
  // e.g. 'POST /api/v1/auth/tokens',  ← refuse; a mid-reset session must not
  //      mint a credential that outlives the boundary.
];

/**
 * The two-sided diff between the live auth route table and the routes someone
 * has actually made a decision about (allowlisted ∪ deliberately refused).
 *
 * A pure function so the guard's own logic can be tested against synthetic
 * inputs (see the self-test below) instead of being trusted, and so a failure
 * names its DIRECTION — the two directions have opposite remedies and
 * confusing them is how the lockout gets shipped:
 *
 *   undecided  a live route nobody classified. Either recovery (allowlist it)
 *              or not (refuse it). Also what a DELETED allowlist entry looks
 *              like while its route still exists — the instant-lockout case.
 *   stale      a listed route that no longer exists. The list is lying; drop
 *              the entry. NEVER "fix" this by re-adding the route.
 */
function authRouteDrift(
  routes: readonly string[],
  decided: readonly string[]
): { undecided: string[]; stale: string[] } {
  const decidedSet = new Set(decided);
  const routeSet = new Set(routes);
  return {
    undecided: routes.filter((r) => !decidedSet.has(r)).sort(),
    stale: decided.filter((d) => !routeSet.has(d)).sort(),
  };
}

describe('password-change gate coverage', () => {
  beforeAll(() => {
    // Anti-vacuity, both directions. Without these, a refactor that changes how
    // Hono exposes routes leaves this file green while asserting nothing.
    if (app.routes.length === 0) {
      throw new Error(
        'app.routes is empty — the route table could not be read. This guard ' +
          'would pass vacuously. Fix this test, do not delete it.'
      );
    }
    if (gatePaths.size === 0) {
      throw new Error(
        'No passwordChangeGate mounts found at all. Either every router lost its ' +
          'mount, or the isPasswordChangeGate tag was removed from the middleware ' +
          '— in which case this guard can no longer see any mount and must be fixed.'
      );
    }
  });

  it.each(EXPECTED_GATE_MOUNTS)('mounts passwordChangeGate on %s', (path) => {
    expect(
      gatePaths.has(path),
      `${path} has no passwordChangeGate mounted. Add\n` +
        `  <router>.use('*', passwordChangeGate())\n` +
        `immediately AFTER that router's rate limiter — never before it, and never\n` +
        `as a global app.use(), which starves every per-router limiter.\n\n` +
        `Without it, a session holding an unrotated temporary password keeps full\n` +
        `authority on every route this router serves.`
    ).toBe(true);
  });

  it.each(EXPECTED_GATE_ORDER)(
    'mounts the rate limiter before the gate on %s',
    (path, limiter) => {
      // Existence of both mounts is proven by the tests above; this test is
      // ONLY about their relative order. `gatePaths` (a Set) already proved
      // the gate exists somewhere at `path` — a Set has no notion of position,
      // which is exactly the gap this test closes.
      const routesAtPath = app.routes.filter((r) => r.path === path);
      const limiterIndex = routesAtPath.findIndex((r) => r.handler === limiter);
      const gateIndex = routesAtPath.findIndex((r) => isGateHandler(r.handler));

      // Anti-vacuity: a missing handler must THROW, not silently compare
      // -1 < someIndex (true — passes vacuously) or -1 < -1 (false — looks
      // like a real failure but says nothing true about ordering).
      if (limiterIndex === -1) {
        throw new Error(
          `No rate-limiter registration found for ${path} matching the expected ` +
            `limiter reference. Either the limiter mount was removed/changed, or ` +
            `EXPECTED_GATE_ORDER's mapping for this path is stale — fix whichever ` +
            `drifted, do not delete this assertion.`
        );
      }
      if (gateIndex === -1) {
        throw new Error(
          `No passwordChangeGate registration found for ${path} — this should ` +
            `already have failed "mounts passwordChangeGate on ${path}" above; ` +
            `something is very wrong if this throws while that test passes.`
        );
      }

      expect(
        limiterIndex,
        `On ${path}, passwordChangeGate is registered at index ${gateIndex} but its ` +
          `rate limiter is at index ${limiterIndex} — the gate must be mounted AFTER ` +
          `the limiter, never before it (see the mount-point comment in ` +
          `middleware/password-change.ts). A gate ahead of its limiter means a denied ` +
          `request returns without calling next(), so the limiter never runs and never ` +
          `counts the request — the exact hazard rate-limit.test.ts:341-361 guards ` +
          `against.`
      ).toBeLessThan(gateIndex);
    }
  );

  it('has no gate mount this list does not know about', () => {
    // The other direction: a new router that DID mount the gate but was never
    // added to EXPECTED_GATE_MOUNTS. Not a security hole, but it means the list
    // has drifted from reality and the guard above is no longer complete.
    expect([...gatePaths].sort()).toEqual([...EXPECTED_GATE_MOUNTS].sort());
  });

  const allowlisted = PASSWORD_CHANGE_ALLOWLIST.map((r) => format(r.method, r.path));

  it('every auth route is EITHER allowlisted OR deliberately refused — never unlisted', () => {
    // A new /api/v1/auth/* route is a deliberate decision with TWO valid
    // answers, and both are one line:
    //   - part of password recovery  -> PASSWORD_CHANGE_ALLOWLIST (access.ts)
    //   - not part of it             -> AUTH_ROUTES_DELIBERATELY_REFUSED (above)
    // Silence is the one outcome forbidden. Comparing against the UNION is what
    // makes the safe answer as cheap as the unsafe one — see the long comment
    // on AUTH_ROUTES_DELIBERATELY_REFUSED for the POST /auth/tokens scenario
    // this exists to stop.
    //
    // Both directions are asserted, and all three failure modes matter:
    //   - a route in neither list  -> `undecided` (the drift case)
    //   - a stale entry either list-> `stale`     (the list lies)
    //   - a recovery entry DELETED while its route still exists
    //                              -> `undecided` (instant lockout)
    expect(
      authRouteDrift(authRoutes, [...allowlisted, ...AUTH_ROUTES_DELIBERATELY_REFUSED]),
      'Auth routes and the gate\'s decision lists have drifted.\n' +
        '  undecided: a live /api/v1/auth route nobody classified. Add it to\n' +
        '    PASSWORD_CHANGE_ALLOWLIST (services/auth/access.ts) if completing the\n' +
        '    password change REQUIRES it, otherwise to\n' +
        '    AUTH_ROUTES_DELIBERATELY_REFUSED in this file. Both are one line;\n' +
        '    pick the correct one rather than the one that turns CI green.\n' +
        '  stale: a listed route that no longer exists — delete the entry.'
    ).toEqual({ undecided: [], stale: [] });
  });

  it('lists no route twice', () => {
    // authRouteDrift is set-based, so a duplicated entry inside either list is
    // invisible to it. Harmless at runtime, but a duplicate is always a botched
    // edit and the guard should say so rather than absorb it.
    const decided = [...allowlisted, ...AUTH_ROUTES_DELIBERATELY_REFUSED];
    expect(decided).toEqual([...new Set(decided)]);
  });

  describe('authRouteDrift — the guard\'s own logic, on synthetic input', () => {
    // The live assertion above passes because the real lists agree with the
    // real route table. That says nothing about whether it would still catch a
    // disagreement. These drive the same function with inputs a real edit
    // would produce.
    const RECOVERY = 'POST /api/v1/auth/change-password';
    const TOKENS = 'POST /api/v1/auth/tokens';

    it('reports a live route nobody classified', () => {
      expect(authRouteDrift([RECOVERY, TOKENS], [RECOVERY])).toEqual({
        undecided: [TOKENS],
        stale: [],
      });
    });

    it('accepts a route classified as REFUSED, not only as allowlisted', () => {
      // The whole point of F4: refusing must be a green answer. If this ever
      // reddens, the guard is back to being greenable only by widening the
      // allowlist — the insecure direction.
      expect(authRouteDrift([RECOVERY, TOKENS], [RECOVERY, TOKENS])).toEqual({
        undecided: [],
        stale: [],
      });
    });

    it('reports a stale entry whose route no longer exists', () => {
      expect(authRouteDrift([RECOVERY], [RECOVERY, TOKENS])).toEqual({
        undecided: [],
        stale: [TOKENS],
      });
    });

    it('reports a DELETED recovery entry as undecided — the instant-lockout case', () => {
      // Deleting `POST /api/v1/auth/change-password` from the allowlist while
      // the route still exists bricks every provisioned account. It must land
      // in `undecided`, not be silently tolerated.
      expect(authRouteDrift([RECOVERY], [])).toEqual({ undecided: [RECOVERY], stale: [] });
    });

    it('distinguishes METHOD on the same path', () => {
      // The F5 property, at the guard level: `DELETE /api/v1/auth/me` must not
      // be considered decided just because `GET /api/v1/auth/me` is.
      expect(
        authRouteDrift(['GET /api/v1/auth/me', 'DELETE /api/v1/auth/me'], ['GET /api/v1/auth/me'])
      ).toEqual({ undecided: ['DELETE /api/v1/auth/me'], stale: [] });
    });
  });

  it('no route is BOTH allowlisted and deliberately refused', () => {
    // The union assertion above cannot see a contradiction: an entry present
    // in both lists appears twice on the right, so the comparison fails with a
    // duplicate-element message that reads like drift rather than like the
    // real problem. Naming it separately makes the diagnosis immediate — and
    // "exempt" and "refused" are opposite claims about the same request, so
    // one of the two edits is definitely wrong.
    const both = allowlisted.filter((r) => AUTH_ROUTES_DELIBERATELY_REFUSED.includes(r));
    expect(both, 'a route cannot be both exempt from and refused by the gate').toEqual([]);
  });
});
