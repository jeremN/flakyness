import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, users, teams } from '../db';
import { SESSION_COOKIE } from '../services/auth/session';
import { withAdvisoryLock, GLOBAL_ADMIN_LOCK_KEY } from '../test-support/advisory-lock';
import { clearMustChangePassword } from '../test-support/onboard-provisioned-user';

const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeEnforcement = hasDatabase && hasAdminToken ? describe : describe.skip;

let app: typeof import('../index').default;
beforeAll(async () => {
  if (hasDatabase) app = (await import('../index')).default;
});

const adminHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
});

describeEnforcement('mustChangePassword enforcement', () => {
  let seq = 0;

  /**
   * Provision a mid-reset user who is `team_admin` of a fresh team of their own.
   *
   * TWO deliberate choices here, both load-bearing:
   *
   * 1. NOT a global admin. `admin-users.test.ts` mutates "who is a global
   *    admin" ambiently across the whole table and serialises itself on
   *    GLOBAL_ADMIN_LOCK_KEY (test-support/advisory-lock.ts) precisely because
   *    that state is shared across test FILES, which vitest runs in separate
   *    processes. Minting global admins here would race it — flaky tests, in a
   *    flaky-test tracker's own suite.
   *
   * 2. `team_admin`, not a plain member. It is the account that WOULD be
   *    allowed on every surface below, so a refusal can only come from the
   *    flag — a plain member would be refused anyway and the tests would prove
   *    nothing. It also exercises canEnterAdminApi's SECOND branch, which is
   *    the one a half-fix (guarding only canAdministerTeams) leaves open.
   */
  interface Fixture {
    id: string;
    teamId: string;
    email: string;
    password: string;
  }

  async function provisionMustChangeUser(): Promise<Fixture> {
    const stamp = `${Date.now()}-${seq++}`;

    const teamRes = await app.request('/api/v1/admin/teams', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ name: `must-change-team-${stamp}` }),
    });
    expect(teamRes.status, 'creating the fixture team must succeed').toBe(201);
    const teamId = (await teamRes.json()).team.id;

    const email = `must-change-${stamp}@example.com`;
    const userRes = await app.request('/api/v1/admin/users', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ email }),
    });
    expect(userRes.status, 'provisioning the fixture user must succeed').toBe(201);
    const body = await userRes.json();
    expect(body.user.mustChangePassword, 'a provisioned user starts mid-reset').toBe(true);

    const memberRes = await app.request(`/api/v1/admin/teams/${teamId}/members`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ userId: body.user.id, role: 'team_admin' }),
    });
    expect(memberRes.status, 'the fixture user must end up a team_admin').toBe(201);

    return { id: body.user.id, teamId, email, password: body.temporaryPassword };
  }

  /** Both rows, every time. Leaked teams accumulate across runs and make the
   *  `admin/teams` list route's own tests progressively slower and noisier. */
  async function cleanup(f: Fixture): Promise<void> {
    await db.delete(users).where(eq(users.id, f.id));
    await db.delete(teams).where(eq(teams.id, f.teamId));
  }

  async function loginAs(email: string, password: string): Promise<string> {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status, 'login must succeed even while mid-reset').toBe(200);
    const cookie = (res.headers.get('set-cookie') ?? '')
      .match(new RegExp(`${SESSION_COOKIE}=([^;]*)`))?.[1];
    // Asserted, not `!`-asserted: a bare non-null assertion is a TYPE claim
    // only. Without this, a login that stopped issuing cookies would send
    // `fk_session=undefined`, every request below would be anonymous, and the
    // 403 assertions would silently be testing nothing.
    expect(cookie, 'login must issue a session cookie').toBeDefined();
    return cookie!;
  }

  const withCookie = (cookie: string) => ({
    Cookie: `${SESSION_COOKIE}=${cookie}`,
    'Content-Type': 'application/json',
  });

  /**
   * THE LOCKOUT TEST — the most important test in this feature.
   *
   * Getting this wrong bricks every provisioned account with no recovery short
   * of hand-written SQL. Each route gets its own session because logout and
   * change-password both invalidate the one they are given.
   */
  describe('the four allowlisted routes still work while mid-reset', () => {
    it('GET /api/v1/auth/me returns the caller, flag included', async () => {
      const u = await provisionMustChangeUser();
      const res = await app.request('/api/v1/auth/me', {
        headers: withCookie(await loginAs(u.email, u.password)),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // The dashboard needs this field to know to redirect. A 200 that omits
      // it is a passing test and a broken feature.
      expect(body.user.mustChangePassword).toBe(true);
      await cleanup(u);
    });

    it('POST /api/v1/auth/logout ends the session', async () => {
      const u = await provisionMustChangeUser();
      const res = await app.request('/api/v1/auth/logout', {
        method: 'POST',
        headers: withCookie(await loginAs(u.email, u.password)),
      });
      expect(res.status).toBe(200);
      await cleanup(u);
    });

    it('POST /api/v1/auth/login re-authenticates a caller who is ALREADY carrying a mid-reset session', async () => {
      // Routing this through loginAs() would prove nothing: loginAs() sends no
      // Cookie header at all, so getSessionUser() resolves null,
      // passwordChangeGate() short-circuits on `!sessionUser?.mustChangePassword`
      // BEFORE ever consulting the allowlist, and the request would sail
      // through even if '/api/v1/auth/login' were deleted from
      // PASSWORD_CHANGE_ALLOWLIST. The real scenario this allowlist entry
      // protects is a browser that already holds a mid-reset session cookie
      // and re-authenticates while still sending it — the gate must actually
      // consult the allowlist and let this specific path through.
      const u = await provisionMustChangeUser();
      const existingSessionCookie = await loginAs(u.email, u.password);

      const res = await app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: withCookie(existingSessionCookie),
        body: JSON.stringify({ email: u.email, password: u.password }),
      });
      expect(res.status).toBe(200);
      // A bare status check is weaker than it looks: it would pass even if the
      // route silently stopped issuing sessions. The cookie is the actual
      // proof this response re-authenticated the caller rather than just
      // acknowledging the credentials.
      const reissuedCookie = (res.headers.get('set-cookie') ?? '')
        .match(new RegExp(`${SESSION_COOKIE}=([^;]*)`))?.[1];
      expect(reissuedCookie, 're-authenticating must issue a fresh session cookie').toBeDefined();

      await cleanup(u);
    });

    it('POST /api/v1/auth/change-password completes the remedy and clears the flag', async () => {
      const u = await provisionMustChangeUser();
      const res = await app.request('/api/v1/auth/change-password', {
        method: 'POST',
        headers: withCookie(await loginAs(u.email, u.password)),
        body: JSON.stringify({ currentPassword: u.password, newPassword: 'a-perfectly-fine-new-password' }),
      });
      expect(res.status).toBe(200);

      const [row] = await db.select({ f: users.mustChangePassword }).from(users).where(eq(users.id, u.id));
      expect(row.f, 'the remedy must actually clear the flag').toBe(false);

      // And the account is usable again — the escape hatch really opens. This
      // is the assertion that would catch a change-password that cleared the
      // DB flag but left the caller holding a session still resolving to the
      // old value. (It does not: auth.ts:255-260 revokes every session and
      // issues a fresh one in the same response.)
      const after = await loginAs(u.email, 'a-perfectly-fine-new-password');
      const me = await app.request('/api/v1/admin/projects', { headers: withCookie(after) });
      expect(me.status, 'a rotated password restores full authority').toBe(200);

      await cleanup(u);
    });

    /**
     * ...but the remedy must be a REAL rotation. NIST SP 800-63B §6.1.1,
     * "Temporary secrets SHALL NOT be reused" — the design spec's own lead
     * citation, and until this test the one rule the exit route permitted
     * violating.
     *
     * This sits in the LOCKOUT describe on purpose: it is the boundary's exit
     * door, and the two facts about a door are that it opens for the right
     * person (the test above) and does not open for the wrong one (this one).
     * Exercised against a genuinely provisioned temporary password rather than
     * a hand-seeded row, because that is the exact secret the attack leaks.
     */
    it('POST /api/v1/auth/change-password REFUSES reusing the temporary password, leaving the caller mid-reset', async () => {
      const u = await provisionMustChangeUser();
      const res = await app.request('/api/v1/auth/change-password', {
        method: 'POST',
        headers: withCookie(await loginAs(u.email, u.password)),
        body: JSON.stringify({ currentPassword: u.password, newPassword: u.password }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'New password must differ from the current one',
        code: 'password_reused',
      });

      const [row] = await db.select({ f: users.mustChangePassword }).from(users).where(eq(users.id, u.id));
      expect(row.f, 'a refused rotation must leave the account inside the boundary').toBe(true);

      // Still refused everywhere, i.e. the boundary is genuinely still up —
      // not merely a flag that reads true while the gate has moved on.
      const after = await app.request('/api/v1/admin/projects', {
        headers: withCookie(await loginAs(u.email, u.password)),
      });
      expect(after.status).toBe(403);
      expect((await after.json()).code).toBe('password_change_required');

      await cleanup(u);
    });
  });

  /**
   * CONTRACT UNIFORMITY — the regression test for the defect the spec review
   * found. Without the gate, these surfaces answer a mid-reset team_admin
   * three DIFFERENT ways: 200-with-an-empty-list (the project list filters
   * rather than refuses), 404 (tests.ts checks readability first, and layer 1
   * routes into plan 058's existence-hiding path), and a code-less 403
   * ("Admin access required"). All must now be the same 403 with the same code.
   *
   * Every assertion below compares the whole BODY, not just the status. Status
   * alone is too weak here: two of these surfaces already 403 for unrelated
   * reasons, so `expect(res.status).toBe(403)` would pass against a completely
   * unmounted gate.
   */
  describe('every refused surface emits the same contract', () => {
    const REFUSED_403 = { error: 'Password change required', code: 'password_change_required' };

    it('read: GET /api/v1/projects — refused, not merely filtered to empty', async () => {
      const u = await provisionMustChangeUser();
      const res = await app.request('/api/v1/projects', {
        headers: withCookie(await loginAs(u.email, u.password)),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(REFUSED_403);
      await cleanup(u);
    });

    it('write: PATCH /api/v1/tests/flaky/:id', async () => {
      const u = await provisionMustChangeUser();
      // A nonexistent id on purpose: the gate must fire BEFORE the row lookup.
      // If it ran after, this would 404 and the test would red — which is
      // exactly the ordering guarantee worth pinning.
      const res = await app.request('/api/v1/tests/flaky/00000000-0000-4000-8000-000000000000', {
        method: 'PATCH',
        headers: withCookie(await loginAs(u.email, u.password)),
        body: JSON.stringify({ status: 'ignored' }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(REFUSED_403);
      await cleanup(u);
    });

    it('admin API: GET /api/v1/admin/projects', async () => {
      const u = await provisionMustChangeUser();
      const res = await app.request('/api/v1/admin/projects', {
        headers: withCookie(await loginAs(u.email, u.password)),
      });
      expect(res.status).toBe(403);
      // Not just "a 403". `Admin access required` is also a 403 and would be
      // WRONG here — it names the wrong reason and carries no code.
      expect(await res.json()).toEqual(REFUSED_403);
      await cleanup(u);
    });

    it('admin user CRUD: GET /api/v1/admin/users — a SEPARATE router mount', async () => {
      // adminUsersRouter is mounted independently of adminRouter and carries
      // its own use('*') stack, so the case above does not cover it.
      //
      // Be explicit about what this does and does not prove: a team_admin is
      // refused here anyway (canAdministerTeams is global-admin only), so the
      // STATUS proves nothing. The body is the whole assertion — without the
      // gate this returns `{ error: 'Team administration requires a global
      // admin' }` or similar, never a `code`.
      const u = await provisionMustChangeUser();
      const res = await app.request('/api/v1/admin/users', {
        headers: withCookie(await loginAs(u.email, u.password)),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(REFUSED_403);
      await cleanup(u);
    });
  });

  /**
   * The zero-behaviour-change promise. An install with no user accounts must
   * not notice this feature at all.
   */
  describe('machine credentials presenting no session cookie are unaffected', () => {
    it('ADMIN_TOKEN still reaches the admin API', async () => {
      const res = await app.request('/api/v1/admin/projects', { headers: adminHeaders() });
      expect(res.status).toBe(200);
    });

    it('a mid-reset user existing on the instance does not affect a token caller', async () => {
      // The flag lives on a row, not on the request. This pins that the gate
      // reads the CALLER's session and nothing else.
      const u = await provisionMustChangeUser();
      const res = await app.request('/api/v1/admin/projects', { headers: adminHeaders() });
      expect(res.status).toBe(200);
      await cleanup(u);
    });
  });

  it('a mid-reset cookie sent ALONGSIDE a valid ADMIN_TOKEN is still refused', async () => {
    // Session outranks bearer (middleware/access.ts:50-70), a deliberate plan
    // 058 decision this feature does not reverse. Documented here as intended
    // behaviour so plan 059 does not discover it as a surprise: the dashboard
    // holds ADMIN_TOKEN server-side and will gain a session cookie.
    const u = await provisionMustChangeUser();
    const cookie = await loginAs(u.email, u.password);
    const res = await app.request('/api/v1/admin/projects', {
      headers: { ...adminHeaders(), Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('password_change_required');
    await cleanup(u);
  });

  it('layer 1 alone still refuses when the gate is mocked out', async () => {
    // Each layer must be proven to bite ALONE, or redundancy masks breakage:
    // the gate always fires first, so layer 1 could be entirely broken and
    // every other test in this file would still pass.
    //
    // Only THIS direction needs its own test. The reverse — "layer 2 alone
    // bites" — is what every test above already proves, because layer 1 is
    // never reached while the gate is mounted.
    //
    // The surface is the admin API on purpose. A read would be a bad choice:
    // GET /api/v1/projects is a LIST route, so layer 1 refusing yields an empty
    // 200, not a refusal — a test asserting 404 there would fail for the wrong
    // reason, and one asserting "not 200" would pass with both layers broken.
    // canEnterAdminApi, by contrast, is a clean permit/deny.
    //
    // Note the contract differs by design: this is `403 Admin access required`
    // with NO code — layer 1 refuses, layer 2 owns the contract. Asserting the
    // exact body is what proves the mock really took effect rather than the
    // real gate having answered.
    const u = await provisionMustChangeUser();
    const cookie = await loginAs(u.email, u.password);

    vi.resetModules();
    vi.doMock('../middleware/password-change', () => ({
      passwordChangeGate: () =>
        Object.assign(async (_c: unknown, next: () => Promise<void>) => await next(), {
          isPasswordChangeGate: true as const,
        }),
    }));
    try {
      const { Hono } = await import('hono');
      const { HTTPException } = await import('hono/http-exception');
      const { sessionAuth } = await import('../middleware/session');
      const { default: adminRouter } = await import('./admin');

      const ungated = new Hono();
      // Mirrors index.ts's app.onError: outside the full app, an uncaught
      // HTTPException's default getResponse() is plain text, not JSON — this
      // is scaffolding to reproduce the real production contract, not a
      // relaxation of the assertion below.
      ungated.onError((err, c) => {
        if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
        throw err;
      });
      ungated.use('*', sessionAuth());
      ungated.route('/api/v1/admin', adminRouter);

      const res = await ungated.request('/api/v1/admin/projects', {
        headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
      });
      expect(res.status, 'with the gate neutralised, layer 1 must still refuse').toBe(403);
      expect(await res.json()).toEqual({ error: 'Admin access required' });
    } finally {
      vi.doUnmock('../middleware/password-change');
      vi.resetModules();
      await cleanup(u);
    }
  });

  /**
   * The other half of "layer 1 alone still bites" — and the branch the test
   * above structurally cannot reach.
   *
   * `GET /api/v1/projects` filters rather than refuses, and whether it filters
   * at all is decided by `scopesProjectList`. That predicate used to open with
   * `if (access.isGlobalAdmin) return false`, i.e. "do not filter" — so with
   * the gate absent, a mid-reset GLOBAL ADMIN took the unfiltered branch,
   * `canReadProject`'s mid-reset guard was never called, and layer 1 handed
   * them EVERY project on the instance. The existing layer-1 test uses a
   * `team_admin`, whose filtered branch already yielded `[]`, so it passed
   * while never touching the broken branch.
   *
   * Both requests below go through the SAME ungated app with the SAME cookie;
   * the only thing that changes between them is the database flag. That is
   * what makes the empty list attributable to the flag rather than to the
   * instance having no projects, to readAuth, or to the mock.
   */
  it('layer 1 alone empties the project LIST for a mid-reset GLOBAL ADMIN', async () => {
    // MANDATORY: the lock spans the whole body, creation through final
    // assertion — see the identical note in access-scope.test.ts:505-512.
    // admin-users.test.ts's withSoleGlobalAdmin() demotes every ambient global
    // admin and asserts its target is the sole one; releasing early would let
    // a concurrent cycle flip this admin back to false mid-test, and the
    // control request below would then see an empty list for the WRONG reason
    // and go green while proving nothing.
    await withAdvisoryLock(GLOBAL_ADMIN_LOCK_KEY, async () => {
      const stamp = `${Date.now()}-${seq++}`;

      // A project must exist, or "sees an empty list" is true of every
      // possible implementation and the assertion is vacuous.
      const teamRes = await app.request('/api/v1/admin/teams', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ name: `ga-list-team-${stamp}` }),
      });
      expect(teamRes.status).toBe(201);
      const teamId = (await teamRes.json()).team.id;

      const projectRes = await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ name: `ga-list-project-${stamp}`, teamId }),
      });
      expect(projectRes.status).toBe(201);
      const projectId = (await projectRes.json()).project.id;

      const userRes = await app.request('/api/v1/admin/users', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ email: `ga-list-${stamp}@example.com`, isGlobalAdmin: true }),
      });
      expect(userRes.status).toBe(201);
      const created = await userRes.json();
      expect(created.user.isGlobalAdmin, 'the fixture must really be a global admin').toBe(true);
      expect(created.user.mustChangePassword, 'and must start mid-reset').toBe(true);
      const userId = created.user.id;

      const cookie = await loginAs(created.user.email, created.temporaryPassword);

      vi.resetModules();
      vi.doMock('../middleware/password-change', () => ({
        passwordChangeGate: () =>
          Object.assign(async (_c: unknown, next: () => Promise<void>) => await next(), {
            isPasswordChangeGate: true as const,
          }),
      }));
      try {
        const { Hono } = await import('hono');
        const { sessionAuth } = await import('../middleware/session');
        const { default: projectsRouter } = await import('./projects');

        const ungated = new Hono();
        ungated.use('*', sessionAuth());
        ungated.route('/api/v1/projects', projectsRouter);

        const listAsCaller = async () => {
          const res = await ungated.request('/api/v1/projects', {
            headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
          });
          // 200, not 403/404: this is the third layer-1 outcome, and pinning
          // the status is what documents that layer 1 does NOT produce the
          // uniform refusal contract here — only the gate does.
          expect(res.status, 'the list route filters, it never refuses').toBe(200);
          return (await res.json()).projects as Array<{ id: string }>;
        };

        expect(
          await listAsCaller(),
          'with the gate neutralised, a mid-reset global admin must see NO project'
        ).toEqual([]);

        // Same app, same cookie, flag cleared — the control. Without it the
        // assertion above would also pass against a route that returned []
        // to everyone, or against a fixture whose project was never created.
        await clearMustChangePassword(userId);
        const healthy = await listAsCaller();
        expect(
          healthy.map((p) => p.id),
          'once rotated, the very same global admin sees the project again'
        ).toContain(projectId);
      } finally {
        vi.doUnmock('../middleware/password-change');
        vi.resetModules();
        await db.delete(users).where(eq(users.id, userId));
        await db.delete(teams).where(eq(teams.id, teamId));
      }
    });
  });

  it('a refused mid-reset caller is still rate-limited', async () => {
    // The regression test for the mount-order defect. Mounting the gate
    // globally (app.use('*')) rather than per-router runs it before every
    // limiter; because a denial returns without next(), the limiter never
    // counts the request and this test never sees a 429 — an unthrottled path
    // that still pays a session DB lookup per request. Same hazard, same
    // shape, as rate-limit.test.ts:341-361, which is also where this idiom
    // (resetModules, enable the flag, build a MINIMAL app) comes from.
    //
    // Provision and log in FIRST, on the outer app: the limiter is a module
    // singleton, and doing this after enabling it would spend real slots.
    const u = await provisionMustChangeUser();
    const cookie = await loginAs(u.email, u.password);

    vi.resetModules();
    const { __setRateLimitEnabled, API_RATE_LIMIT } = await import('../middleware/rate-limit');
    __setRateLimitEnabled(true);
    try {
      const { Hono } = await import('hono');
      const { sessionAuth } = await import('../middleware/session');
      const { default: projectsRouter } = await import('./projects');

      const limited = new Hono();
      limited.use('*', sessionAuth());
      limited.route('/api/v1/projects', projectsRouter);

      const codes: number[] = [];
      for (let i = 0; i < API_RATE_LIMIT.limit + 3; i++) {
        const res = await limited.request('/api/v1/projects', {
          headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
        });
        codes.push(res.status);
      }
      expect(codes).toContain(429);
      // Sanity: the early requests really did reach the gate, proving the 429s
      // came from exhausting the limiter rather than from everything being
      // rejected outright — the assertion that fails under the global mount.
      expect(codes[0]).toBe(403);
    } finally {
      __setRateLimitEnabled(false);
      vi.resetModules();
      await cleanup(u);
    }
  });

  /**
   * The SAME hazard as the test above, reached through a different door — and
   * the door mount-ordering does not cover.
   *
   * The admin routers use `adminRateLimit`, whose skip predicate
   * (`hasAdminStanding`) exempts any signed-in session. Ordering guarantees
   * the limiter RUNS before the gate; it says nothing about the limiter then
   * choosing to skip. So a mid-reset session hitting /api/v1/admin/* was
   * exempted by the limiter, refused by the gate, and could repeat that
   * forever — unthrottled, paying sessionAuth's session↔users SELECT every
   * time. The projectsRouter test above cannot catch this: `apiRateLimit` has
   * no skip predicate at all.
   *
   * Both variants matter. Session-only is the dashboard's shape; session PLUS
   * a valid ADMIN_TOKEN is plan 059's shape, and since the gate refuses on the
   * session regardless of the bearer, the bearer must not buy an exemption the
   * gate will not honour.
   */
  it.each([
    ['cookie alone', false],
    ['cookie PLUS a valid ADMIN_TOKEN', true],
  ])('a refused mid-reset caller on the ADMIN router is still rate-limited — %s', async (_label, withBearer) => {
    // Provision and log in FIRST, on the outer app, before the limiter is
    // enabled — it is a module singleton and this would otherwise spend slots.
    const u = await provisionMustChangeUser();
    const cookie = await loginAs(u.email, u.password);

    vi.resetModules();
    const { __setRateLimitEnabled, ADMIN_RATE_LIMIT } = await import('../middleware/rate-limit');
    __setRateLimitEnabled(true);
    try {
      const { Hono } = await import('hono');
      const { HTTPException } = await import('hono/http-exception');
      const { sessionAuth } = await import('../middleware/session');
      const { default: adminRouter } = await import('./admin');

      const limited = new Hono();
      limited.onError((err, c) =>
        err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({}, 500)
      );
      limited.use('*', sessionAuth());
      limited.route('/api/v1/admin', adminRouter);

      const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${cookie}` };
      if (withBearer) headers.Authorization = `Bearer ${process.env.ADMIN_TOKEN}`;

      const codes: number[] = [];
      for (let i = 0; i < ADMIN_RATE_LIMIT.limit + 3; i++) {
        codes.push((await limited.request('/api/v1/admin/projects', { headers })).status);
      }
      expect(codes).toContain(429);
      // Sanity: the early requests reached the gate, so the 429s come from
      // exhausting the bucket rather than everything being refused outright.
      expect(codes[0]).toBe(403);
    } finally {
      __setRateLimitEnabled(false);
      vi.resetModules();
      await cleanup(u);
    }
  });
});
