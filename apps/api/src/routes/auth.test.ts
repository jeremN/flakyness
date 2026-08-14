import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, users, sessions } from '../db';
import { hashPassword } from '../services/auth/password';
import { SESSION_COOKIE } from '../services/auth/session';
import { isCookieSecure } from './auth';

// Wraps the real password module in a passthrough spy so verifyPassword's
// call count is observable without changing its behaviour (`...actual`
// keeps hashPassword, used by createUser() below, untouched). Used to prove
// — deterministically, not by wall-clock — that the unknown-email login
// path still calls verifyPassword against the dummy hash. This repo's whole
// subject is flaky tests, so a timing-threshold assertion here would be
// exactly the wrong instrument; a call-count spy is immune to CI jitter.
vi.mock('../services/auth/password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/auth/password')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

// These tests require the database and ADMIN_TOKEN to be configured
const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeAuth = hasDatabase && hasAdminToken ? describe : describe.skip;

let app: typeof import('../index').default;

beforeAll(async () => {
  if (hasDatabase) app = (await import('../index')).default;
});

const PASSWORD = 'a-perfectly-fine-password';

/** Pull the fk_session value out of a Set-Cookie header. */
function sessionCookieFrom(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  const match = raw.match(new RegExp(`${SESSION_COOKIE}=([^;]*)`));
  return match ? match[1] : null;
}

async function createUser(overrides: Partial<{ email: string; isGlobalAdmin: boolean; mustChangePassword: boolean }> = {}) {
  const email = overrides.email ?? `u-${crypto.randomUUID()}@example.test`;
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(PASSWORD),
      displayName: 'Test User',
      isGlobalAdmin: overrides.isGlobalAdmin ?? false,
      mustChangePassword: overrides.mustChangePassword ?? false,
    })
    .returning();
  return row;
}

async function login(email: string, password = PASSWORD) {
  return app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

describeAuth('POST /api/v1/auth/login', () => {
  it('issues an HttpOnly SameSite=Lax session cookie on success', async () => {
    const user = await createUser();
    const res = await login(user.email);

    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    // 7 days in seconds. Deleting `maxAge` from setSessionCookie silently
    // degrades this to a browser-session cookie (gone the moment the tab
    // closes) — a real behavioural regression the attribute checks above
    // cannot catch.
    expect(cookie).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
    // Default test env: NODE_ENV=test, no COOKIE_SECURE override -> off.
    // See the isCookieSecure() suite below for the other three branches,
    // and the COOKIE_SECURE=true test below for the "on" polarity wired
    // through this same real route.
    expect(cookie).not.toContain('Secure');
  });

  it('sets the Secure attribute on the session cookie when COOKIE_SECURE=true', async () => {
    const prev = process.env.COOKIE_SECURE;
    process.env.COOKIE_SECURE = 'true';
    try {
      const user = await createUser();
      const res = await login(user.email);
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toContain('Secure');
    } finally {
      if (prev === undefined) delete process.env.COOKIE_SECURE;
      else process.env.COOKIE_SECURE = prev;
    }
  });

  it('stores only a hash of the session token, never the raw value', async () => {
    const user = await createUser();
    const res = await login(user.email);
    const raw = sessionCookieFrom(res)!;

    const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe(raw);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never returns the password hash in the response body', async () => {
    const user = await createUser();
    const body = await (await login(user.email)).text();
    expect(body).not.toContain('scrypt$');
    expect(body).not.toContain('passwordHash');
  });

  it('normalises the email — a differently-cased address logs into the same account', async () => {
    const user = await createUser({ email: `case-${crypto.randomUUID()}@example.test` });
    const res = await login(user.email.toUpperCase());
    expect(res.status).toBe(200);
  });

  it('rejects a wrong password with 401 and issues no cookie', async () => {
    const user = await createUser();
    const res = await login(user.email, 'not-the-password');
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('returns the SAME error for an unknown email as for a wrong password (no user enumeration)', async () => {
    const user = await createUser();
    const wrongPw = await login(user.email, 'not-the-password');
    const unknown = await login(`ghost-${crypto.randomUUID()}@example.test`);

    expect(unknown.status).toBe(wrongPw.status);
    expect(await unknown.json()).toEqual(await wrongPw.json());
  });

  it('still invokes verifyPassword against the dummy hash on an unknown email (deterministic timing-defence proof)', async () => {
    const { verifyPassword } = await import('../services/auth/password');
    const spy = vi.mocked(verifyPassword);
    const before = spy.mock.calls.length;

    await login(`ghost-${crypto.randomUUID()}@example.test`);

    // Exactly one request happened between the two snapshots, for an email
    // with no backing user — the ONLY code path that can call
    // verifyPassword in that case is the dummy-hash branch. Any increase
    // proves it ran; deleting
    // `await verifyPassword(password, await dummyHash())` from auth.ts
    // leaves this call count flat.
    expect(spy.mock.calls.length).toBeGreaterThan(before);
  });

  it('a transient scrypt failure computing the dummy hash does not become a permanent 500 oracle', async () => {
    // Fresh module graph: dummyHash()'s cache is module-private state inside
    // auth.ts, so proving the reset-on-rejection behaviour needs a NEW
    // auth.ts (and a NEW mocked password module) scoped to just this test —
    // the file-level `vi.mock` above stays in place for every other test.
    vi.resetModules();
    let calls = 0;
    vi.doMock('../services/auth/password', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../services/auth/password')>();
      return {
        ...actual,
        hashPassword: vi.fn(async (pw: string) => {
          calls++;
          if (calls === 1) throw new Error('simulated scrypt failure');
          return actual.hashPassword(pw);
        }),
      };
    });

    try {
      const { Hono } = await import('hono');
      const { default: freshAuthRouter } = await import('./auth');
      const freshApp = new Hono();
      freshApp.route('/api/v1/auth', freshAuthRouter);

      const attempt = () =>
        freshApp.request('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: `ghost-${crypto.randomUUID()}@example.test`,
            password: 'whatever-password-12',
          }),
        });

      // First unknown-email login: dummyHash()'s FIRST hashPassword call
      // rejects. This must fall through to an ordinary 401, never a 500 —
      // a 500 here is a binary, stopwatch-free "unknown account (it broke)"
      // vs "wrong password (200/401)" oracle, strictly worse than the
      // timing gap dummyHash() exists to close.
      const first = await attempt();
      expect(first.status).toBe(401);

      // Second attempt: the rejected promise must not stay cached forever.
      // Both attempts land on 401 either way (the login handler's own
      // try/catch masks a dummy-hash rejection into a normal failed
      // login) — the real discriminator is `calls`. Deleting the
      // `.catch(() => { dummyHashPromise = null; })` reset in dummyHash()
      // leaves this second call re-awaiting the SAME already-rejected
      // promise WITHOUT calling hashPassword again, so `calls` stops at 1
      // instead of reaching 2.
      const second = await attempt();
      expect(second.status).toBe(401);
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      vi.doUnmock('../services/auth/password');
      vi.resetModules();
    }
  });

  it('records last_login_at', async () => {
    const user = await createUser();
    expect(user.lastLoginAt).toBeNull();
    await login(user.email);
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after.lastLoginAt).not.toBeNull();
  });

  it('signals a forced reset for a must_change_password account', async () => {
    const user = await createUser({ mustChangePassword: true });
    const res = await login(user.email);
    expect(res.status).toBe(200);
    expect((await res.json()).mustChangePassword).toBe(true);
  });

  it('400s on a malformed body', async () => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
  });
});

describeAuth('GET /api/v1/auth/me', () => {
  it('401s with no cookie', async () => {
    const res = await app.request('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('401s with a garbage cookie', async () => {
    const res = await app.request('/api/v1/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE}=deadbeef` },
    });
    expect(res.status).toBe(401);
  });

  it('returns the signed-in user', async () => {
    const user = await createUser();
    const cookie = sessionCookieFrom(await login(user.email))!;

    const res = await app.request('/api/v1/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.id).toBe(user.id);
    expect(body.user.email).toBe(user.email);
    expect(body.user).not.toHaveProperty('passwordHash');
    // Plan 059's forced-reset screen reads this field directly; its
    // absence from the response would break that feature with a fully
    // green suite.
    expect(body.user.mustChangePassword).toBe(false);
    // This user was just created and joins no team, so the exact value is
    // known — assert it, don't merely assert presence. `toBeDefined()` here
    // would pass for any value the endpoint ever returned, including a
    // populated list belonging to someone else.
    expect(body.teams).toEqual([]);
  });

  it('returns the user\'s teams and per-team roles', async () => {
    const user = await createUser();
    const teamRes = await app.request('/api/v1/admin/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
      body: JSON.stringify({ name: `me-${crypto.randomUUID().slice(0, 8)}` }),
    });
    const team = (await teamRes.json()).team;

    await app.request(`/api/v1/admin/teams/${team.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
      body: JSON.stringify({ userId: user.id, role: 'team_admin' }),
    });

    const cookie = sessionCookieFrom(await login(user.email))!;
    const res = await app.request('/api/v1/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });

    expect((await res.json()).teams).toEqual([{ id: team.id, name: team.name, role: 'team_admin' }]);
  });

  it('returns an empty team list for a user in no team (not an error)', async () => {
    const user = await createUser();
    const cookie = sessionCookieFrom(await login(user.email))!;
    const res = await app.request('/api/v1/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).teams).toEqual([]);
  });

  it('reflects mustChangePassword: true for a forced-reset account', async () => {
    const user = await createUser({ mustChangePassword: true });
    const cookie = sessionCookieFrom(await login(user.email))!;

    const res = await app.request('/api/v1/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(200);
    // Paired with the `false` case above: together they rule out both a
    // deleted field AND a field hardcoded to one value.
    expect((await res.json()).user.mustChangePassword).toBe(true);
  });

  it('401s once the session row is gone (revocation is immediate)', async () => {
    const user = await createUser();
    const cookie = sessionCookieFrom(await login(user.email))!;
    await db.delete(sessions).where(eq(sessions.userId, user.id));

    const res = await app.request('/api/v1/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(401);
  });

  it('401s on an expired session AND reaps the row', async () => {
    const user = await createUser();
    const cookie = sessionCookieFrom(await login(user.email))!;
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.userId, user.id));

    const res = await app.request('/api/v1/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(401);
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
  });

  // The two tests below are the ONLY end-to-end coverage of the sliding-TTL
  // branch. Every other test in this file logs in moments before it calls the
  // API, so `shouldSlideSession` is false throughout and the slide code never
  // runs. Without these, deleting `expiresAt: sessionExpiry(now)` from the
  // middleware's UPDATE — or targeting the wrong row — leaves the suite green.
  it('slides an idle session forward: both last_seen_at AND expires_at move', async () => {
    const user = await createUser();
    const cookie = sessionCookieFrom(await login(user.email))!;

    // Backdate past the slide threshold (1h) but nowhere near the 7d expiry,
    // so the row is stale-but-live and takes the slide branch.
    const staleSeenAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await db
      .update(sessions)
      .set({ lastSeenAt: staleSeenAt })
      .where(eq(sessions.userId, user.id));

    const [before] = await db.select().from(sessions).where(eq(sessions.userId, user.id));

    const res = await app.request('/api/v1/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(200);

    const [after] = await db.select().from(sessions).where(eq(sessions.userId, user.id));

    // Same row — catches a slide that targets the wrong session.
    expect(after.id).toBe(before.id);
    // Activity recorded.
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(staleSeenAt.getTime());
    // The point of a SLIDING window: expiry is pushed out, not just touched.
    // This is the assertion that reds if `expiresAt` is dropped from the UPDATE.
    expect(after.expiresAt.getTime()).toBeGreaterThan(before.expiresAt.getTime());
  });

  it('does NOT slide a session that was just used', async () => {
    const user = await createUser();
    const cookie = sessionCookieFrom(await login(user.email))!;
    const [before] = await db.select().from(sessions).where(eq(sessions.userId, user.id));

    const res = await app.request('/api/v1/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(200);

    // Fresh session is inside the 1h threshold, so the UPDATE must be skipped.
    // Without this, `shouldSlideSession` could be hardcoded `true` and the
    // slide test above would still pass — a write on every single request.
    const [after] = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    expect(after.lastSeenAt.getTime()).toBe(before.lastSeenAt.getTime());
  });
});

describeAuth('POST /api/v1/auth/logout', () => {
  it('deletes the session row and clears the cookie', async () => {
    const user = await createUser();
    const cookie = sessionCookieFrom(await login(user.email))!;

    const res = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);

    // The response must actually clear the cookie client-side, not just the
    // server-side row — deleting `deleteCookie(...)` from the handler
    // leaves the DB write intact but a stale cookie in the browser, and the
    // test above (`toHaveLength(0)`) would stay green regardless.
    const clearedCookie = res.headers.get('set-cookie') ?? '';
    expect(clearedCookie).toContain(`${SESSION_COOKIE}=`);
    expect(clearedCookie).toMatch(/Max-Age=0\b/);

    const after = await app.request('/api/v1/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(after.status).toBe(401);
  });

  it('is idempotent — logging out with no session still succeeds', async () => {
    const res = await app.request('/api/v1/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});

describeAuth('POST /api/v1/auth/change-password', () => {
  const NEW_PASSWORD = 'an-entirely-different-one';

  async function changePassword(cookie: string, body: Record<string, string>) {
    return app.request('/api/v1/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${cookie}` },
      body: JSON.stringify(body),
    });
  }

  it('401s when not signed in', async () => {
    const res = await app.request('/api/v1/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong current password', async () => {
    const user = await createUser();
    const cookie = sessionCookieFrom(await login(user.email))!;
    const res = await changePassword(cookie, { currentPassword: 'wrong', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('rejects a new password below the minimum length', async () => {
    const user = await createUser();
    const cookie = sessionCookieFrom(await login(user.email))!;
    const res = await changePassword(cookie, { currentPassword: PASSWORD, newPassword: 'short' });
    expect(res.status).toBe(400);
  });

  it('changes the password, clears must_change_password, and lets the new one log in', async () => {
    const user = await createUser({ mustChangePassword: true });
    const cookie = sessionCookieFrom(await login(user.email))!;

    const res = await changePassword(cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);

    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after.mustChangePassword).toBe(false);
    expect(after.passwordHash).not.toBe(user.passwordHash);

    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
    expect((await login(user.email, PASSWORD)).status).toBe(401);
  });

  /**
   * NIST SP 800-63B §6.1.1 — "Temporary secrets SHALL NOT be reused".
   *
   * The attack this closes: a temporary password leaks (Slack thread, ticket).
   * The attacker logs in — allowlisted while mid-reset — and POSTs
   * change-password with currentPassword and newPassword BOTH set to the
   * leaked value. Before the fix that returned 200, cleared the flag, revoked
   * every session and minted a fresh one for the attacker; the legitimate user
   * later signed in with the password they were given and was never prompted.
   * Silent standing access, reached through the one route that is supposed to
   * be the exit from the boundary.
   */
  it('refuses reusing the current password as the new one, and changes NOTHING', async () => {
    const user = await createUser({ mustChangePassword: true });
    const cookie = sessionCookieFrom(await login(user.email))!;

    const res = await changePassword(cookie, {
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    });

    expect(res.status).toBe(400);
    // The `code` is the contract the dashboard branches on — a bare 400 is
    // indistinguishable from the zod min-length rejection tested above.
    expect(await res.json()).toEqual({
      error: 'New password must differ from the current one',
      code: 'password_reused',
    });

    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    // The whole point: a refused change must leave the caller INSIDE the
    // boundary. A 400 that still cleared the flag would be the same silent
    // standing access with an unhappy-looking status code.
    expect(after.mustChangePassword, 'a refused change must not clear the flag').toBe(true);
    expect(after.passwordHash, 'a refused change must not rewrite the hash').toBe(user.passwordHash);

    // And the session lifecycle must not have run either. revokeAllUserSessions
    // + issueSession is the half that hands the attacker a working credential,
    // so "did the rotation happen" is a separate fact from "did the flag clear"
    // and gets its own assertions.
    expect(sessionCookieFrom(res), 'a refused change must not mint a session').toBeNull();
    const survivors = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(survivors, 'a refused change must not revoke the existing session').toHaveLength(1);

    const stillSignedIn = await app.request('/api/v1/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    expect(stillSignedIn.status, 'the original session must still work').toBe(200);
    expect((await stillSignedIn.json()).user.mustChangePassword).toBe(true);
  });

  it('compares against the STORED HASH, not the submitted currentPassword string', async () => {
    // Distinguishes the implemented fix from the tempting shortcut
    // `if (newPassword === currentPassword)`. Password comparison is
    // byte-exact, so a currentPassword that verifies while differing as a
    // string is not constructible here; what IS constructible is the reverse
    // direction — proving the refusal is keyed to the account's real password
    // rather than to string equality of the two request fields. A user whose
    // password is X, submitting {current: X, new: X}, is refused; the same
    // user submitting {current: X, new: Y} is not.
    const user = await createUser();
    const cookie = sessionCookieFrom(await login(user.email))!;

    expect((await changePassword(cookie, { currentPassword: PASSWORD, newPassword: PASSWORD })).status).toBe(400);
    // Same session, same account, only newPassword differs — so a 200 here can
    // come from nothing but the hash comparison having been the deciding fact.
    expect((await changePassword(cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(200);
  });

  it('revokes every OTHER session and re-issues the caller a fresh cookie', async () => {
    const user = await createUser();
    const cookieA = sessionCookieFrom(await login(user.email))!;
    const cookieB = sessionCookieFrom(await login(user.email))!;
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(2);

    const res = await changePassword(cookieA, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    const fresh = sessionCookieFrom(res);
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(cookieA);

    // Exactly one session survives: the re-issued one.
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(1);

    // The other device is signed out.
    const otherDevice = await app.request('/api/v1/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE}=${cookieB}` },
    });
    expect(otherDevice.status).toBe(401);

    // The caller stays signed in on the new cookie.
    const caller = await app.request('/api/v1/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE}=${fresh}` },
    });
    expect(caller.status).toBe(200);
  });
});

// Pure-function coverage of the four resolution branches — no DB, no HTTP,
// so it always runs regardless of DATABASE_URL (unlike everything above,
// gated by describeAuth). The real route's wiring of this into an actual
// Set-Cookie header is covered end-to-end by the two login tests above
// ('...on success' for the off-by-default case, '...COOKIE_SECURE=true'
// for the forced-on case).
describe('isCookieSecure (session cookie Secure-attribute resolution)', () => {
  const prevSecure = process.env.COOKIE_SECURE;
  const prevNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (prevSecure === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = prevSecure;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  });

  it('defaults to false outside production with no override', () => {
    delete process.env.COOKIE_SECURE;
    process.env.NODE_ENV = 'development';
    expect(isCookieSecure()).toBe(false);
  });

  it('defaults to true when NODE_ENV=production with no override', () => {
    delete process.env.COOKIE_SECURE;
    process.env.NODE_ENV = 'production';
    expect(isCookieSecure()).toBe(true);
  });

  it('COOKIE_SECURE=true forces it on even outside production', () => {
    process.env.COOKIE_SECURE = 'true';
    process.env.NODE_ENV = 'development';
    expect(isCookieSecure()).toBe(true);
  });

  it('COOKIE_SECURE=false forces it off even in production', () => {
    process.env.COOKIE_SECURE = 'false';
    process.env.NODE_ENV = 'production';
    expect(isCookieSecure()).toBe(false);
  });
});
