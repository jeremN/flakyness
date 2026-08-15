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

// The complete set of gate mounts: the seven app.route('/api/v1/...') routers
// in index.ts, plus the one route-level mount on GET /api/v1 itself.
//
// This list is a NAMED INVENTORY, not the completeness check. Listing a mount
// here without mounting the gate fails the per-mount assertion; mounting one
// without listing it fails 'has no gate mount this list does not know about'.
// Neither direction can see a router that mounts NO gate at all — such a
// router contributes nothing to `gatePaths`, so both sides stay equal and
// every assertion keyed to this list passes. That completeness job belongs
// solely to 'every /api/v1 route is covered by a gate mount' below, which
// derives the surface from app.routes instead of from this constant. (An
// earlier revision of this header claimed a "count assertion" enforced it.
// There was no count assertion; a reviewer appended a real ungated router to
// the live app and every gate assertion here passed.)
const EXPECTED_GATE_MOUNTS = [
  '/api/v1/reports/*',
  '/api/v1/projects/*',
  '/api/v1/tests/*',
  '/api/v1/admin/users/*',
  '/api/v1/admin/teams/*',
  '/api/v1/admin/*',
  '/api/v1/auth/*',
  // Route-level, not a router mount: index.ts's GET /api/v1 version endpoint.
  // Deliberately NOT in EXPECTED_GATE_ORDER — no rate limiter covers this path
  // (it sits outside every router), so there is no ordering to assert.
  '/api/v1',
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

/**
 * "Is this route path covered by one of the gate mounts we found?"
 *
 * Built from the mount paths rather than hard-coded, so a NEW router that
 * forgets its gate is detected by the absence of a covering mount — the
 * completeness check no list of expected mounts can perform.
 *
 * ### The vacuity trap — read before editing
 *
 * Wildcard mounts (`/api/v1/admin/*`) and exact-path gates (`/api/v1`) MUST be
 * handled separately. Treating every gate path as a `startsWith` prefix looks
 * tidier and destroys the guard: `'/api/v1'` is a prefix of literally every
 * path under `/api/v1`, so `isGateCovered` would return true for everything
 * and the assertion would pass forever, including for a completely ungated
 * router. Exact paths therefore go in a Set and only `/*` mounts become
 * prefixes. `buildGateCoverage`'s self-test below pins exactly this.
 *
 * ### A wildcard mount also covers its own root
 *
 * `<router>.use('*', ...)` mounted at `/api/v1/projects` surfaces in
 * app.routes as `ALL /api/v1/projects/*`, and that registration DOES run for
 * `/api/v1/projects` itself — the router's `get('/')` route, which app.routes
 * reports as the bare `/api/v1/projects` with no trailing slash. Measured on
 * Hono 4.12.33, and independently proven at runtime by
 * routes/password-change-enforcement.test.ts, where a mid-reset caller gets
 * 403 from exactly that URL. So a `/*` mount covers `base` AND `base/...`.
 * Matching on the raw `base/` prefix alone would report every router's root
 * route as ungated — a false alarm that would push a maintainer to "fix" a
 * non-problem. Comparing against `base` bare, on the other hand, would wrongly
 * cover a sibling like `/api/v1/administrate`; hence the two-part test.
 *
 * Taking the parameter instead of closing over `gatePaths` is what makes the
 * self-test possible at all.
 */
function buildGateCoverage(gateMountPaths: readonly string[]): (path: string) => boolean {
  const wildcardBases = gateMountPaths.filter((p) => p.endsWith('/*')).map((p) => p.slice(0, -2));
  const exactGated = new Set(gateMountPaths.filter((p) => !p.endsWith('/*')));
  return (path: string) =>
    exactGated.has(path) ||
    wildcardBases.some((base) => path === base || path.startsWith(`${base}/`));
}

/** Every `/api/v1` route registration no gate mount covers. */
function uncoveredV1Routes(
  routes: ReadonlyArray<{ method: string; path: string }>,
  isCovered: (path: string) => boolean
): string[] {
  return [
    ...new Set(
      routes
        .filter((r) => r.path === '/api/v1' || r.path.startsWith('/api/v1/'))
        .filter((r) => !isCovered(r.path))
        .map((r) => format(r.method, r.path))
    ),
  ].sort();
}

const gateMountPaths = [...gatePaths];
const isGateCovered = buildGateCoverage(gateMountPaths);
const wildcardMountCount = gateMountPaths.filter((p) => p.endsWith('/*')).length;

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
    // Anti-vacuity for the DERIVED completeness check specifically. It compares
    // two things read out of app.routes; if a Hono refactor changed how either
    // is exposed, both could empty out and 'every /api/v1 route is covered'
    // would pass over nothing.
    if (app.routes.filter((r) => r.path.startsWith('/api/v1')).length === 0) {
      throw new Error(
        'No /api/v1 routes visible in app.routes — the completeness check below ' +
          'would iterate an empty surface and pass vacuously. Fix this test.'
      );
    }
    if (wildcardMountCount !== 7) {
      throw new Error(
        `Expected 7 wildcard ('/*') gate mounts — one per /api/v1 router — but ` +
          `found ${wildcardMountCount}. If a router was genuinely added or removed, ` +
          `update this number AND EXPECTED_GATE_MOUNTS/EXPECTED_GATE_ORDER together. ` +
          `If it dropped to 0, the mount paths are no longer being read correctly ` +
          `and every coverage assertion below is vacuous.`
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

  /**
   * THE COMPLETENESS CHECK — the only assertion in this file that can see a
   * router which mounts no gate at all.
   *
   * Every other assertion here is keyed to EXPECTED_GATE_MOUNTS, and a router
   * with no gate contributes nothing to `gatePaths`, so both sides of those
   * comparisons stay equal and they all pass. This one derives the surface
   * from the live route table instead, so an ungated router shows up as an
   * uncovered route with nowhere to hide.
   *
   * It also closes a second gap: routes-auth-coverage.test.ts filters on
   * `method === 'GET'`, so a WRITE-ONLY router trips neither guard. This one
   * is method-agnostic.
   */
  it('every /api/v1 route is covered by a gate mount', () => {
    expect(
      uncoveredV1Routes(app.routes, isGateCovered),
      'These /api/v1 routes have no passwordChangeGate covering them. A session\n' +
        'holding an unrotated temporary password keeps full authority on each one.\n\n' +
        'For a new ROUTER: add\n' +
        "  <router>.use('*', passwordChangeGate())\n" +
        "immediately AFTER that router's rate limiter, then add its mount path to\n" +
        'EXPECTED_GATE_MOUNTS and EXPECTED_GATE_ORDER above.\n\n' +
        'For a route mounted directly on the root app: pass the gate as route-level\n' +
        "middleware — app.get(path, passwordChangeGate(), handler) — NEVER\n" +
        "app.use(path, ...), which runs ahead of every per-router limiter and starves\n" +
        'them all.'
    ).toEqual([]);
  });

  describe('buildGateCoverage — the guard\'s own logic, on synthetic input', () => {
    // The assertion above passes because today's mounts really do cover
    // today's routes. That proves nothing about whether it would CATCH an
    // ungated router. These drive the same function with a fabricated route
    // table, which is the only way to exercise the failing direction.
    const NEW_ROUTER: ReadonlyArray<{ method: string; path: string }> = [
      { method: 'GET', path: '/api/v1' },
      { method: 'GET', path: '/api/v1/projects/' },
      // A plausible next router, mounted and never gated. WRITE-only on
      // purpose: routes-auth-coverage.test.ts only inspects GETs, so this is
      // precisely the shape that trips neither guard if this one is broken.
      { method: 'POST', path: '/api/v1/notifications/:channelId/test' },
    ];

    it('reports an ungated router as uncovered', () => {
      const covered = buildGateCoverage(['/api/v1/projects/*', '/api/v1']);
      expect(uncoveredV1Routes(NEW_ROUTER, covered)).toEqual([
        'POST /api/v1/notifications/:channelId/test',
      ]);
    });

    it('reports nothing once that router mounts the gate', () => {
      const covered = buildGateCoverage([
        '/api/v1/projects/*',
        '/api/v1/notifications/*',
        '/api/v1',
      ]);
      expect(uncoveredV1Routes(NEW_ROUTER, covered)).toEqual([]);
    });

    it('THE VACUITY TRAP: gating /api/v1 must NOT cover everything beneath it', () => {
      // If exact-path gates were folded in as `startsWith` prefixes, '/api/v1'
      // would match every path under /api/v1 and this whole guard would become
      // a no-op that passes forever. This is the single assertion that stops
      // that refactor from landing silently.
      const covered = buildGateCoverage(['/api/v1']);
      expect(covered('/api/v1'), 'the exact path is covered').toBe(true);
      expect(
        covered('/api/v1/notifications/:channelId/test'),
        "gating '/api/v1' must not silently cover the entire API"
      ).toBe(false);
      expect(uncoveredV1Routes(NEW_ROUTER, covered)).toEqual([
        'GET /api/v1/projects/',
        'POST /api/v1/notifications/:channelId/test',
      ]);
    });

    it('a wildcard mount covers its subtree AND its own root, and nothing else', () => {
      const covered = buildGateCoverage(['/api/v1/admin/*']);
      expect(covered('/api/v1/admin/projects')).toBe(true);
      expect(covered('/api/v1/admin/users/:id')).toBe(true);
      // The router's own root route. app.routes reports `<router>.get('/')` as
      // the bare mount path, and the `/*` middleware registration really does
      // run for it (measured). Matching on the 'base/' prefix alone would
      // report every router's index route as ungated — a false alarm on six
      // real, correctly-gated routes.
      expect(covered('/api/v1/admin')).toBe(true);
      // But a SIBLING that merely shares a textual prefix must not be. This is
      // why the base is compared exactly rather than as a bare prefix.
      expect(covered('/api/v1/administrate')).toBe(false);
      expect(covered('/api/v1/projects')).toBe(false);
    });

    it('ignores routes outside /api/v1 entirely', () => {
      // /health and /metrics are mounted on the root app ABOVE sessionAuth and
      // carry no credential; they are not this gate's business and must never
      // be reported as drift.
      const covered = buildGateCoverage([]);
      expect(
        uncoveredV1Routes(
          [
            { method: 'GET', path: '/health' },
            { method: 'GET', path: '/metrics' },
            { method: 'ALL', path: '*' },
          ],
          covered
        )
      ).toEqual([]);
    });
  });

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
