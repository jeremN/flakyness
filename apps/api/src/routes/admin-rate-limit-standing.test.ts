import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, users, teams } from '../db';
import { SESSION_COOKIE } from '../services/auth/session';
import { clearMustChangePassword } from '../test-support/onboard-provisioned-user';

const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeDb = hasDatabase && hasAdminToken ? describe : describe.skip;

let app: typeof import('../index').default;
beforeAll(async () => {
  if (hasDatabase) app = (await import('../index')).default;
});

const adminHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
});

/**
 * Backlog #22a, end to end: the admin limiter exempts a team_admin session
 * and throttles a plain member session. The unit tests in
 * middleware/rate-limit.test.ts fake `sessionUser`; only this file proves that
 * sessionAuth's `isTeamAdmin` subquery reads the real `team_members` row. A
 * subquery bound to the wrong table (the Drizzle trap in AGENTS.md) returns
 * false for everyone, and the team_admin row below goes red.
 */
describeDb('admin limiter exemption follows the team_members role (backlog #22a)', () => {
  const createdUserIds: string[] = [];
  const createdTeamIds: string[] = [];
  let seq = 0;

  afterEach(async () => {
    const userIds = createdUserIds.splice(0);
    const teamIds = createdTeamIds.splice(0);
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
    if (teamIds.length) await db.delete(teams).where(inArray(teams.id, teamIds));
  });

  /** A team, a user with `role` in it, past the forced password change, signed in. */
  async function signedInWithRole(role: 'member' | 'team_admin'): Promise<string> {
    const stamp = `${Date.now()}-${seq++}`;

    const teamRes = await app.request('/api/v1/admin/teams', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ name: `limiter-team-${stamp}` }),
    });
    expect(teamRes.status).toBe(201);
    const teamId = (await teamRes.json()).team.id;
    createdTeamIds.push(teamId);

    const email = `limiter-${role}-${stamp}@example.com`;
    const userRes = await app.request('/api/v1/admin/users', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ email }),
    });
    expect(userRes.status).toBe(201);
    const body = await userRes.json();
    createdUserIds.push(body.user.id);
    await clearMustChangePassword(body.user.id);

    const memberRes = await app.request(`/api/v1/admin/teams/${teamId}/members`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ userId: body.user.id, role }),
    });
    expect(memberRes.status).toBe(201);

    const loginRes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: body.temporaryPassword }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = (loginRes.headers.get('set-cookie') ?? '').match(
      new RegExp(`${SESSION_COOKIE}=([^;]*)`)
    )?.[1];
    // Without a cookie every request below is anonymous, and the plain-member
    // row would pass for the wrong reason.
    expect(cookie).toBeDefined();
    return cookie!;
  }

  /**
   * Floods GET /api/v1/admin/projects on a fresh admin router with the
   * limiter enabled. Provisioning happens BEFORE this, on the outer app: the
   * limiter is a module singleton, and enabling it first would spend slots.
   */
  async function flood(cookie: string): Promise<number[]> {
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

      const codes: number[] = [];
      for (let i = 0; i < ADMIN_RATE_LIMIT.limit + 3; i++) {
        const res = await limited.request('/api/v1/admin/projects', {
          headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
        });
        codes.push(res.status);
      }
      return codes;
    } finally {
      __setRateLimitEnabled(false);
      vi.resetModules();
    }
  }

  it('a team_admin session floods past the 5/min limit without a 429', async () => {
    const cookie = await signedInWithRole('team_admin');
    const codes = await flood(cookie);
    expect(codes.every((s) => s === 200)).toBe(true);
  });

  it('a plain member session is throttled: 403 first, then 429', async () => {
    const cookie = await signedInWithRole('member');
    const codes = await flood(cookie);
    // The early requests reached the admin auth and were refused, so the
    // 429s come from the bucket and not from a blanket refusal.
    expect(codes[0]).toBe(403);
    expect(codes).toContain(429);
  });
});
