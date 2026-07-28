import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, users, sessions } from '../db';
import { hashPassword } from '../services/auth/password';
import { SESSION_COOKIE } from '../services/auth/session';

const hasDatabase = !!process.env.DATABASE_URL;
const describeAuth = hasDatabase ? describe : describe.skip;

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
    // Teams are always present in the contract; plan 057 fills them in.
    expect(body.teams).toEqual([]);
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
