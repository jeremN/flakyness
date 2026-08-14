import { describe, it, expect, beforeAll } from 'vitest';
import app from './index';
import { PASSWORD_CHANGE_ALLOWLIST } from './services/auth/access';

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

// Terminal route registrations under /api/v1/auth — the `ALL` entries are
// middleware layers (apiRateLimit, authRateLimit, the gate), not routes.
const authRoutePaths = [
  ...new Set(
    app.routes.filter((r) => r.path.startsWith('/api/v1/auth/') && r.method !== 'ALL').map((r) => r.path)
  ),
].sort();

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

  it('has no gate mount this list does not know about', () => {
    // The other direction: a new router that DID mount the gate but was never
    // added to EXPECTED_GATE_MOUNTS. Not a security hole, but it means the list
    // has drifted from reality and the guard above is no longer complete.
    expect([...gatePaths].sort()).toEqual([...EXPECTED_GATE_MOUNTS].sort());
  });

  it('the allowlist matches the auth router route table exactly', () => {
    // A new /api/v1/auth/* route is a deliberate decision: either it is part of
    // password recovery (add it to PASSWORD_CHANGE_ALLOWLIST) or it is not
    // (leave it out and it is correctly refused). Silence is the one outcome
    // this forbids.
    expect(authRoutePaths).toEqual([...PASSWORD_CHANGE_ALLOWLIST].sort());
  });
});
