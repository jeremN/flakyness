import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, users, teams } from '../db';
import { SESSION_COOKIE } from '../services/auth/session';

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

    it('POST /api/v1/auth/login works — proven by loginAs itself asserting 200', async () => {
      const u = await provisionMustChangeUser();
      await loginAs(u.email, u.password);
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
});
