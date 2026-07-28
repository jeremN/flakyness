import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, users, sessions } from '../db';

const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeAdmin = hasDatabase && hasAdminToken ? describe : describe.skip;

let app: typeof import('../index').default;
beforeAll(async () => {
  if (hasDatabase) app = (await import('../index')).default;
});

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
});

const uniqueEmail = () => `admin-users-${crypto.randomUUID()}@example.test`;

async function createUserViaApi(body: Record<string, unknown> = {}) {
  const res = await app.request('/api/v1/admin/users', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ email: uniqueEmail(), displayName: 'Provisioned', ...body }),
  });
  return { res, body: await res.json() };
}

describeAdmin('POST /api/v1/admin/users', () => {
  it('requires an admin token', async () => {
    const res = await app.request('/api/v1/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: uniqueEmail() }),
    });
    expect(res.status).toBe(401);
  });

  it('returns a temporary password exactly once and stores only its hash', async () => {
    const { res, body } = await createUserViaApi();
    expect(res.status).toBe(201);
    expect(typeof body.temporaryPassword).toBe('string');
    expect(body.temporaryPassword.length).toBeGreaterThanOrEqual(12);

    const [row] = await db.select().from(users).where(eq(users.id, body.user.id));
    expect(row.passwordHash).not.toContain(body.temporaryPassword);
    expect(row.passwordHash.startsWith('scrypt$')).toBe(true);
  });

  it('never returns the password hash', async () => {
    const { body } = await createUserViaApi();
    expect(JSON.stringify(body)).not.toContain('scrypt$');
  });

  it('forces a reset on first login', async () => {
    const { body } = await createUserViaApi();
    const [row] = await db.select().from(users).where(eq(users.id, body.user.id));
    expect(row.mustChangePassword).toBe(true);
  });

  it('the temporary password actually logs in', async () => {
    const { body } = await createUserViaApi();
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: body.user.email, password: body.temporaryPassword }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).mustChangePassword).toBe(true);
  });

  it('normalises the email on creation', async () => {
    const email = uniqueEmail().toUpperCase();
    const { body } = await createUserViaApi({ email });
    expect(body.user.email).toBe(email.toLowerCase());
  });

  it('409s on a duplicate email regardless of case', async () => {
    const email = uniqueEmail();
    await createUserViaApi({ email });
    const { res } = await createUserViaApi({ email: email.toUpperCase() });
    expect(res.status).toBe(409);
  });

  it('creates a non-admin by default', async () => {
    const { body } = await createUserViaApi();
    expect(body.user.isGlobalAdmin).toBe(false);
  });

  it('can create a global admin on request', async () => {
    const { body } = await createUserViaApi({ isGlobalAdmin: true });
    expect(body.user.isGlobalAdmin).toBe(true);
  });

  it('400s on an invalid email', async () => {
    const res = await app.request('/api/v1/admin/users', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ email: 'nope' }),
    });
    expect(res.status).toBe(400);
  });
});

describeAdmin('POST /api/v1/admin/users/:userId/reset-password', () => {
  it('issues a new temp password, forces a reset, and kills every live session', async () => {
    const { body } = await createUserViaApi();
    const userId = body.user.id;

    // Sign in so there is a session to kill.
    await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: body.user.email, password: body.temporaryPassword }),
    });
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).not.toHaveLength(0);

    const res = await app.request(`/api/v1/admin/users/${userId}/reset-password`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const reset = await res.json();
    expect(reset.temporaryPassword).not.toBe(body.temporaryPassword);

    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row.mustChangePassword).toBe(true);
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(0);

    // The old password no longer works; the new one does.
    const old = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: body.user.email, password: body.temporaryPassword }),
    });
    expect(old.status).toBe(401);
  });

  it('404s for an unknown user', async () => {
    const res = await app.request(`/api/v1/admin/users/${crypto.randomUUID()}/reset-password`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

describeAdmin('PATCH /api/v1/admin/users/:userId', () => {
  it('updates the display name', async () => {
    const { body } = await createUserViaApi();
    const res = await app.request(`/api/v1/admin/users/${body.user.id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ displayName: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).user.displayName).toBe('Renamed');
  });

  it('refuses to demote the last global admin', async () => {
    // Ensure exactly one global admin exists for this assertion.
    const admins = await db.select().from(users).where(eq(users.isGlobalAdmin, true));
    for (const extra of admins.slice(1)) {
      await db.update(users).set({ isGlobalAdmin: false }).where(eq(users.id, extra.id));
    }
    const [onlyAdmin] = admins.length
      ? admins
      : [(await createUserViaApi({ isGlobalAdmin: true })).body.user];

    const res = await app.request(`/api/v1/admin/users/${onlyAdmin.id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ isGlobalAdmin: false }),
    });
    expect(res.status).toBe(409);

    const [after] = await db.select().from(users).where(eq(users.id, onlyAdmin.id));
    expect(after.isGlobalAdmin).toBe(true);
  });
});

describeAdmin('DELETE /api/v1/admin/users/:userId', () => {
  it('deletes the user and cascades their sessions', async () => {
    const { body } = await createUserViaApi();
    await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: body.user.email, password: body.temporaryPassword }),
    });

    const res = await app.request(`/api/v1/admin/users/${body.user.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(await db.select().from(users).where(eq(users.id, body.user.id))).toHaveLength(0);
    expect(await db.select().from(sessions).where(eq(sessions.userId, body.user.id))).toHaveLength(0);
  });

  it('refuses to delete the last global admin', async () => {
    const admins = await db.select().from(users).where(eq(users.isGlobalAdmin, true));
    for (const extra of admins.slice(1)) {
      await db.update(users).set({ isGlobalAdmin: false }).where(eq(users.id, extra.id));
    }
    const [onlyAdmin] = admins.length
      ? admins
      : [(await createUserViaApi({ isGlobalAdmin: true })).body.user];

    const res = await app.request(`/api/v1/admin/users/${onlyAdmin.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(res.status).toBe(409);
    expect(await db.select().from(users).where(eq(users.id, onlyAdmin.id))).toHaveLength(1);
  });
});
