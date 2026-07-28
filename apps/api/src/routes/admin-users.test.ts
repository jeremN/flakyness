import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
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

/**
 * Runs `run(targetId)` in a scenario where `targetId` is the ONLY global
 * admin in the database — deterministically, regardless of how many other
 * global admins already exist. A real deployment always has at least a
 * bootstrap admin, and other files in this suite (session.test.ts,
 * auth.test.ts) legitimately create their own `isGlobalAdmin: true` fixtures
 * — under vitest's default forks-pool file parallelism (apps/api has no
 * vitest.config.ts), those files' tests run concurrently with this one.
 *
 * Self-contained: creates its own throwaway admin as the target instead of
 * repurposing an existing user, and computes the "only admin" state from
 * whatever the ambient admin set happens to be at call time — it never
 * assumes a particular starting count.
 *
 * Restorative: ALWAYS restores every ambient admin's `isGlobalAdmin` flag
 * and deletes the throwaway target in a `finally`, so the suite leaves the
 * database exactly as it found it even if `run`'s assertions throw.
 *
 * Residual risk (documented, not eliminated): the demote → `run` → restore
 * window is not held under a database lock, so a *different* concurrently
 * running test file that creates a global admin during that (single
 * bulk-UPDATE-wide) window could still race this one. Closing that fully
 * would need either a cross-connection table lock or serializing the whole
 * suite (an apps/api-wide vitest config change) — both bigger than this
 * fix. This is the same class of race as the route's own read-then-write
 * TOCTOU, deferred alongside it.
 */
async function withSoleGlobalAdmin(run: (targetId: string) => Promise<void>): Promise<void> {
  const ambientAdmins = await db.select({ id: users.id }).from(users).where(eq(users.isGlobalAdmin, true));
  const ambientIds = ambientAdmins.map((a) => a.id);
  const { body: target } = await createUserViaApi({ isGlobalAdmin: true });

  if (ambientIds.length > 0) {
    await db.update(users).set({ isGlobalAdmin: false }).where(inArray(users.id, ambientIds));
  }

  try {
    await run(target.user.id);
  } finally {
    if (ambientIds.length > 0) {
      await db.update(users).set({ isGlobalAdmin: true }).where(inArray(users.id, ambientIds));
    }
    await db.delete(users).where(eq(users.id, target.user.id));
  }
}

describeAdmin('GET /api/v1/admin/users', () => {
  it('lists users with the documented shape, the teams array, and never leaks the password hash', async () => {
    const { body: created } = await createUserViaApi();

    const res = await app.request('/api/v1/admin/users', { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(JSON.stringify(body)).not.toContain('scrypt$');

    const listed = body.users.find((u: { id: string }) => u.id === created.user.id);
    expect(listed).toMatchObject({
      id: created.user.id,
      email: created.user.email,
      displayName: created.user.displayName,
      isGlobalAdmin: false,
      mustChangePassword: true,
      teams: [],
    });
    expect(listed).toHaveProperty('createdAt');
    expect(listed).toHaveProperty('lastLoginAt');
    expect(listed).not.toHaveProperty('passwordHash');
  });
});

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
    expect(JSON.stringify(reset)).not.toContain('scrypt$');

    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row.mustChangePassword).toBe(true);
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(0);

    // The old password no longer works.
    const old = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: body.user.email, password: body.temporaryPassword }),
    });
    expect(old.status).toBe(401);

    // The new password does.
    const fresh = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: body.user.email, password: reset.temporaryPassword }),
    });
    expect(fresh.status).toBe(200);
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

  it('never returns the password hash', async () => {
    const { body } = await createUserViaApi();
    const res = await app.request(`/api/v1/admin/users/${body.user.id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ displayName: 'Renamed Again' }),
    });
    expect(JSON.stringify(await res.json())).not.toContain('scrypt$');
  });

  it('returns the unchanged user for a no-op PATCH (empty body, unknown keys only, or no body)', async () => {
    const { body: created } = await createUserViaApi();

    const empty = await app.request(`/api/v1/admin/users/${created.user.id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(200);
    expect((await empty.json()).user).toEqual(created.user);

    const unknownKeysOnly = await app.request(`/api/v1/admin/users/${created.user.id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ notARealField: 'whatever' }),
    });
    expect(unknownKeysOnly.status).toBe(200);
    expect((await unknownKeysOnly.json()).user).toEqual(created.user);

    // No Content-Type and no body at all — deliberately NOT authHeaders(),
    // which always sets Content-Type: application/json. With that header
    // present, Hono's built-in json validator rejects an empty body itself
    // (400, before ever reaching this route's handler) — a different, already-
    // correct path. Without it, Hono parses the absent body as `{}` and this
    // request DOES reach the same no-op code path as the two cases above.
    const noBody = await app.request(`/api/v1/admin/users/${created.user.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
    });
    expect(noBody.status).toBe(200);
    expect((await noBody.json()).user).toEqual(created.user);
  });

  it('refuses to demote the last global admin', async () => {
    await withSoleGlobalAdmin(async (targetId) => {
      const res = await app.request(`/api/v1/admin/users/${targetId}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ isGlobalAdmin: false }),
      });
      expect(res.status).toBe(409);

      const [after] = await db.select().from(users).where(eq(users.id, targetId));
      expect(after.isGlobalAdmin).toBe(true);
    });
  });

  // Privilege changes must be auditable: granting/revoking global admin has
  // to be distinguishable in the logs from an ordinary display-name edit.
  // logger.ts has no injectable seam (it writes straight to console.*), so —
  // same pattern as middleware/logger.test.ts — this spies on console.log
  // and greps the emitted line rather than mocking the logger module.
  it('logs isGlobalAdmin on the audit trail when the request changes it', async () => {
    const { body: created } = await createUserViaApi();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m) => { lines.push(String(m)); });

    let res: Response;
    try {
      res = await app.request(`/api/v1/admin/users/${created.user.id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ isGlobalAdmin: true }),
      });
    } finally {
      spy.mockRestore();
    }

    expect(res!.status).toBe(200);
    const logLine = lines.find((l) => l.includes('User updated') && l.includes(created.user.id));
    expect(logLine).toBeDefined();
    expect(logLine).toContain('isGlobalAdmin');
    // Never logs anything sensitive.
    expect(logLine).not.toContain('scrypt$');
    expect(logLine).not.toContain(created.temporaryPassword);
  });

  it('does NOT log isGlobalAdmin when the request does not touch it', async () => {
    const { body: created } = await createUserViaApi();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m) => { lines.push(String(m)); });

    let res: Response;
    try {
      res = await app.request(`/api/v1/admin/users/${created.user.id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ displayName: 'Just A Rename' }),
      });
    } finally {
      spy.mockRestore();
    }

    expect(res!.status).toBe(200);
    const logLine = lines.find((l) => l.includes('User updated') && l.includes(created.user.id));
    expect(logLine).toBeDefined();
    expect(logLine).not.toContain('isGlobalAdmin');
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
    await withSoleGlobalAdmin(async (targetId) => {
      const res = await app.request(`/api/v1/admin/users/${targetId}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      expect(res.status).toBe(409);
      expect(await db.select().from(users).where(eq(users.id, targetId))).toHaveLength(1);
    });
  });
});
