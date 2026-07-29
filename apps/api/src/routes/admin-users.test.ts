import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { db, users, sessions } from '../db';
import { withAdvisoryLock, GLOBAL_ADMIN_LOCK_KEY } from '../test-support/advisory-lock';
import { SESSION_COOKIE } from '../services/auth/session';
import { GLOBAL_ADMIN_MUTEX } from './admin-users';

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
 * The whole snapshot → demote → `run` → restore window runs under
 * `withAdvisoryLock(GLOBAL_ADMIN_LOCK_KEY, ...)` (see
 * `../test-support/advisory-lock`) — a Postgres session-level advisory
 * lock, which (unlike an in-process mutex) serialises across the separate
 * OS processes vitest's forks pool runs each test file in. Every OTHER
 * caller that mutates the ambient `isGlobalAdmin` set (currently just
 * `access-scope.test.ts`'s global-admin fixture) must take the SAME lock
 * around its own create, or this guarantee only holds against itself.
 * Without it: a concurrently running file that creates a NEW global admin
 * strictly between the snapshot read and the restore write is invisible to
 * `ambientIds` (it wasn't there when the snapshot ran) and never gets
 * demoted — so `targetId` silently stops being the sole admin mid-`run`,
 * and the "refuses to demote/delete the last global admin" assertions
 * below can observe 200 instead of 409. Measured before this fix: 2
 * failures in 8 full-suite runs, 0 in 12 with `access-scope.test.ts`
 * removed — see plan 058 Task 3's report.
 */
async function withSoleGlobalAdmin(run: (targetId: string) => Promise<void>): Promise<void> {
  await withAdvisoryLock(GLOBAL_ADMIN_LOCK_KEY, async () => {
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
  });
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

/**
 * Fix round 2, plan 058 Global Constraint: "the last-admin guard's TOCTOU
 * must be closed in the SAME change that strips ADMIN_TOKEN of superuser
 * status." Task 5 is that change — adminOrGlobalAdminAuth() fully supports a
 * token-less, session-only deployment — so the unlocked read-then-write in
 * the demote/delete handlers is a real, reachable "zero global admins, no
 * break-glass left" bug, not a theoretical one. These tests fire two
 * concurrent requests against the SAME pair of admins and assert the
 * invariant holds; they do NOT wait for a failure to appear before
 * asserting — every one of the ATTEMPTS iterations must hold the invariant,
 * so a single lucky race does not make the suite flaky-green.
 *
 * MANDATORY: this describe block creates and flips global admins, so its
 * entire body — every iteration of every test, seed through final
 * assertion through restore — runs under
 * `withAdvisoryLock(GLOBAL_ADMIN_LOCK_KEY, ...)`. Narrowing this lock (e.g.
 * releasing it between iterations) reopens exactly the cross-file race
 * `withSoleGlobalAdmin`'s own doc comment describes: a concurrently running
 * file's ambient-admin snapshot/restore could land mid-iteration and desync
 * the count these tests depend on.
 */
describeAdmin('concurrent global-admin demote/delete race (fix round 2, plan 058 Global Constraint)', () => {
  const ATTEMPTS = 5;

  interface Throwaway {
    id: string;
    email: string;
    temporaryPassword: string;
  }

  /**
   * Seeds EXACTLY two throwaway global admins (demoting every ambient one
   * for the duration), runs `run(a, b)` with each one's id/email/temp
   * password (so a test can both target them by id AND log in as either
   * one), then restores the ambient set and deletes the throwaways — the
   * same self-contained/restorative shape as `withSoleGlobalAdmin` above,
   * widened to a pair instead of a singleton because this bug is about
   * contention BETWEEN admins, not about a single sole admin.
   */
  async function withExactlyTwoGlobalAdmins(
    run: (a: Throwaway, b: Throwaway) => Promise<void>
  ): Promise<void> {
    const ambientAdmins = await db.select({ id: users.id }).from(users).where(eq(users.isGlobalAdmin, true));
    const ambientIds = ambientAdmins.map((a) => a.id);
    const { body: a } = await createUserViaApi({ isGlobalAdmin: true });
    const { body: b } = await createUserViaApi({ isGlobalAdmin: true });

    if (ambientIds.length > 0) {
      await db.update(users).set({ isGlobalAdmin: false }).where(inArray(users.id, ambientIds));
    }

    try {
      await run(
        { id: a.user.id, email: a.user.email, temporaryPassword: a.temporaryPassword },
        { id: b.user.id, email: b.user.email, temporaryPassword: b.temporaryPassword }
      );
    } finally {
      if (ambientIds.length > 0) {
        await db.update(users).set({ isGlobalAdmin: true }).where(inArray(users.id, ambientIds));
      }
      await db.delete(users).where(inArray(users.id, [a.user.id, b.user.id]));
    }
  }

  /** How many of `ids` are STILL flagged isGlobalAdmin (a delete removes the row entirely, so absence also counts as "not remaining"). */
  async function remainingAdminCount(ids: string[]): Promise<number> {
    const rows = await db
      .select({ isGlobalAdmin: users.isGlobalAdmin })
      .from(users)
      .where(inArray(users.id, ids));
    return rows.filter((r) => r.isGlobalAdmin).length;
  }

  async function loginAs(email: string, password: string): Promise<string> {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const cookie = (res.headers.get('set-cookie') ?? '')
      .match(new RegExp(`${SESSION_COOKIE}=([^;]*)`))?.[1];
    return cookie!;
  }

  it(
    `two concurrent demotes of DIFFERENT admins never both succeed (${ATTEMPTS} attempts)`,
    async () => {
      await withAdvisoryLock(GLOBAL_ADMIN_LOCK_KEY, async () => {
        for (let i = 0; i < ATTEMPTS; i++) {
          await withExactlyTwoGlobalAdmins(async (a, b) => {
            const [resA, resB] = await Promise.all([
              app.request(`/api/v1/admin/users/${a.id}`, {
                method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ isGlobalAdmin: false }),
              }),
              app.request(`/api/v1/admin/users/${b.id}`, {
                method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ isGlobalAdmin: false }),
              }),
            ]);

            // At most one of the two may succeed. Unfixed (unlocked
            // count-then-write) both read count 2 and both pass — the
            // reviewer measured this reproducing within 2 attempts.
            expect(
              [resA.status, resB.status].sort(),
              `attempt ${i}: both demotes must not succeed together`
            ).not.toEqual([200, 200]);

            expect(
              await remainingAdminCount([a.id, b.id]),
              `attempt ${i}: at least one of the pair must remain a global admin`
            ).toBeGreaterThanOrEqual(1);
          });
        }
      });
    }
  );

  it(
    `two concurrent deletes of DIFFERENT admins never both succeed (${ATTEMPTS} attempts)`,
    async () => {
      await withAdvisoryLock(GLOBAL_ADMIN_LOCK_KEY, async () => {
        for (let i = 0; i < ATTEMPTS; i++) {
          await withExactlyTwoGlobalAdmins(async (a, b) => {
            const [resA, resB] = await Promise.all([
              app.request(`/api/v1/admin/users/${a.id}`, { method: 'DELETE', headers: authHeaders() }),
              app.request(`/api/v1/admin/users/${b.id}`, { method: 'DELETE', headers: authHeaders() }),
            ]);

            expect(
              [resA.status, resB.status].sort(),
              `attempt ${i}: both deletes must not succeed together`
            ).not.toEqual([200, 200]);

            expect(
              await remainingAdminCount([a.id, b.id]),
              `attempt ${i}: at least one of the pair must remain a global admin`
            ).toBeGreaterThanOrEqual(1);
          });
        }
      });
    }
  );

  // The reviewer's sharper finding: it takes ONE actor, not two. Both
  // requests below carry the SAME session cookie — one global admin,
  // self-demoting AND demoting another admin in the same breath (exactly
  // what an impatient double-click, or a dashboard that doesn't await
  // between two form submits, would produce).
  it(
    `a single admin session demoting itself and another admin concurrently never reaches zero (${ATTEMPTS} attempts)`,
    async () => {
      await withAdvisoryLock(GLOBAL_ADMIN_LOCK_KEY, async () => {
        for (let i = 0; i < ATTEMPTS; i++) {
          await withExactlyTwoGlobalAdmins(async (self, other) => {
            const selfCookie = await loginAs(self.email, self.temporaryPassword);

            const [selfRes, otherRes] = await Promise.all([
              app.request(`/api/v1/admin/users/${self.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${selfCookie}` },
                body: JSON.stringify({ isGlobalAdmin: false }),
              }),
              app.request(`/api/v1/admin/users/${other.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${selfCookie}` },
                body: JSON.stringify({ isGlobalAdmin: false }),
              }),
            ]);

            expect(
              [selfRes.status, otherRes.status].sort(),
              `attempt ${i}: self+other demote by one session must not both succeed`
            ).not.toEqual([200, 200]);

            expect(
              await remainingAdminCount([self.id, other.id]),
              `attempt ${i}: must never reach zero global admins`
            ).toBeGreaterThanOrEqual(1);
          });
        }
      });
    }
  );
});

/**
 * One-shot interception of `db.query.users.findFirst`: lets the FIRST call
 * whose result matches `matchId` resolve completely normally (delegating to
 * the real implementation), then — after it has resolved, but before
 * returning it to the caller — awaits `onMatch()` and immediately restores
 * the spy. Every other call (a different id, or after the match) passes
 * through untouched.
 *
 * This is the "seam you can await" the fix round 3 brief asked for: it lets
 * a test simulate "another request committed a write in the gap between
 * this handler's read and its transaction" deterministically, without
 * adding any synchronization point to production code.
 *
 * `db.query.users.findFirst` returns drizzle's `PgRelationalQuery` (a
 * thenable, not a literal `Promise`); `mockImplementation` still needs a
 * function assignable to that exact type, so the cast below is required —
 * runtime behavior is unaffected, since `await` accepts any thenable.
 */
function findFirstOnce(matchId: string, onMatch: () => Promise<void>) {
  const original = db.query.users.findFirst.bind(db.query.users);
  const spy = vi.spyOn(db.query.users, 'findFirst');
  spy.mockImplementation(
    (async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (result?.id === matchId) {
        spy.mockRestore();
        await onMatch();
      }
      return result;
    }) as unknown as typeof original
  );
  return spy;
}

/**
 * Fix round 3: round 2 closed the count-check-then-write TOCTOU by locking
 * the WHOLE admin set before counting — but it still decided WHETHER to
 * take that lock from a value (`isDemote` in PATCH, `user.isGlobalAdmin` in
 * DELETE) read from `db.query.users.findFirst` BEFORE the transaction
 * opened. A target promoted to global admin in the network round trip +
 * `BEGIN` between that read and the transaction's `FOR UPDATE` would make
 * the round-2 handler skip the lock AND the guard entirely on stale
 * information, and write anyway — reaching zero global admins via three
 * interleaved requests (promote the target, demote the OTHER admin down to
 * one, then the stale-read demote/delete on the now-promoted target)
 * instead of two.
 *
 * Reproducing the three-way interleaving deterministically via real
 * concurrent HTTP requests (the `Promise.all` pattern the block above
 * uses) is not practical here: `db.transaction` is entered by EVERY PATCH
 * request, not only demotes, so there is no call-order signal available to
 * the test that distinguishes "the demote request's transaction" from "the
 * promote request's transaction" — and adding one would mean adding a
 * synchronization seam to admin-users.ts itself, which the brief for this
 * fix explicitly ruled out ("not by adding a delay to production code").
 *
 * Instead, these two tests use a one-shot `vi.spyOn` on
 * `db.query.users.findFirst` — a seam that lives entirely in this test
 * file and touches no production code. It lets the handler's own read
 * resolve completely normally and unmodified, and only AFTER it resolves
 * (i.e. only once the handler has already committed to treating the
 * target as a non-admin, exactly mirroring "the stale read has already
 * happened") does it run the promote-target / demote-other-admin sequence,
 * before handing the correctly-stale `{ isGlobalAdmin: false }` result
 * back to the handler. This reproduces the exact interleaving the reviewer
 * measured against a live database — deterministically, on every run,
 * with no dependency on real I/O timing.
 */
describeAdmin('last-admin guard closes even when the target is promoted mid-request (fix round 3)', () => {
  // NOTE: `withSoleGlobalAdmin` already takes `withAdvisoryLock(GLOBAL_ADMIN_LOCK_KEY,
  // ...)` internally (see its doc comment) — do NOT wrap it in another
  // `withAdvisoryLock` here. The lock pool is `max: 1`; nesting two
  // acquisitions of the SAME key from the SAME test self-deadlocks (the
  // outer call holds the pool's only connection, so the inner call's
  // `.reserve()` blocks forever waiting for a connection that will never
  // free up). Measured directly: this exact nesting hung indefinitely
  // against a live database until removed.
  it('a PATCH-demote against a target promoted to admin AFTER this request\'s own read still 409s, never 200s', async () => {
    await withSoleGlobalAdmin(async (soleAdminId) => {
      const { body: created } = await createUserViaApi();
      const targetId = created.user.id;

      // Window-widening seam: only fires on THIS read of targetId, once.
      const spy = findFirstOnce(targetId, async () => {
        await db.update(users).set({ isGlobalAdmin: true }).where(eq(users.id, targetId));
        await db.update(users).set({ isGlobalAdmin: false }).where(eq(users.id, soleAdminId));
      });

      try {
        const res = await app.request(`/api/v1/admin/users/${targetId}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ isGlobalAdmin: false }),
        });
        expect(res.status).toBe(409);

        const remaining = await db
          .select({ isGlobalAdmin: users.isGlobalAdmin })
          .from(users)
          .where(inArray(users.id, [targetId, soleAdminId]));
        expect(remaining.filter((r) => r.isGlobalAdmin).length).toBeGreaterThanOrEqual(1);
      } finally {
        spy.mockRestore();
        await db.delete(users).where(eq(users.id, targetId));
      }
    });
  });

  it('a DELETE against a target promoted to admin AFTER this request\'s own read still 409s, never 200s', async () => {
    await withSoleGlobalAdmin(async (soleAdminId) => {
      const { body: created } = await createUserViaApi();
      const targetId = created.user.id;

      // Window-widening seam: only fires on THIS read of targetId, once.
      const spy = findFirstOnce(targetId, async () => {
        await db.update(users).set({ isGlobalAdmin: true }).where(eq(users.id, targetId));
        await db.update(users).set({ isGlobalAdmin: false }).where(eq(users.id, soleAdminId));
      });

      try {
        const res = await app.request(`/api/v1/admin/users/${targetId}`, {
          method: 'DELETE',
          headers: authHeaders(),
        });
        expect(res.status).toBe(409);

        const remaining = await db
          .select({ isGlobalAdmin: users.isGlobalAdmin })
          .from(users)
          .where(inArray(users.id, [targetId, soleAdminId]));
        expect(remaining.filter((r) => r.isGlobalAdmin).length).toBeGreaterThanOrEqual(1);
      } finally {
        spy.mockRestore();
        await db.delete(users).where(eq(users.id, targetId));
      }
    });
  });
});

/**
 * Fix round 3 (Minor, same block): `(await tx.update(...).returning())[0]`
 * comes back `undefined` when the target row was deleted by a concurrent
 * request between this handler's own `findFirst` and its transaction's
 * write. `noUncheckedIndexedAccess` is off, so TypeScript does not catch
 * the missing guard — `publicUser(undefined)` throws on `u.id`, and
 * `app.onError` turns a legitimate concurrent-delete race into a 500
 * instead of a 404. Uses the same one-shot `db.query.users.findFirst` spy
 * seam as the block above, deleting the target right after the handler's
 * own stale read resolves.
 */
/**
 * Fix round 4: rounds 2-3 serialised the two removal paths with
 * `SELECT ... WHERE is_global_admin = true FOR UPDATE`. A locking read fixes
 * its row set from its OWN statement snapshot and only then blocks, so a row
 * promoted after that snapshot was invisible to it (neither counted nor
 * lockable) while a row that WAS in the snapshot but got concurrently
 * demoted was dropped by Postgres' EvalPlanQual recheck once the lock was
 * granted. With both happening during one blocked read, it came back EMPTY
 * although a committed global admin existed — `locked.some(...)` false for
 * every row, guard skipped, blind write, zero admins. Reproduced 3/3 against
 * a live database.
 *
 * `admin-users.ts` replaced that with a transaction-scoped advisory mutex
 * (`GLOBAL_ADMIN_MUTEX`) plus a PLAIN, non-locking read. The property that
 * closes the hole, and the one these tests pin, is: **a removal that has to
 * WAIT evaluates its guard against everything committed while it waited** —
 * there is no pre-block snapshot left for it to carry, because the read that
 * decides the guard happens only after the mutex is held.
 *
 * Construction: the test parks the production mutex itself on a dedicated
 * connection, so the removal request is guaranteed to be waiting (asserted,
 * not assumed) rather than racing. The admin-set change committed during
 * that wait stands in for the write of whichever remover held the mutex
 * immediately before — the exact history the round-2/3 code would have read
 * straight past.
 *
 * Both tests redden if the `pg_advisory_xact_lock` line is removed from the
 * handler: the request no longer parks, `settled` is true, and the guard
 * runs against the pre-change state and answers 200.
 */
describeAdmin('a removal parked on GLOBAL_ADMIN_MUTEX guards against state committed while it waited (fix round 4)', () => {
  /**
   * Holds the PRODUCTION mutex open for the duration of `run`, handing it a
   * `release()` that commits (and so releases — `pg_advisory_xact_lock` is
   * transaction-scoped) the holding transaction.
   *
   * Uses its OWN single-connection client, deliberately NOT
   * `test-support/advisory-lock`'s pool: these tests run inside
   * `withSoleGlobalAdmin`, which is already holding that pool's one and only
   * connection, so reserving from it here would self-deadlock — the same
   * `max: 1` trap fix round 3 hit by nesting `withAdvisoryLock` inside
   * `withSoleGlobalAdmin`. Session affinity still matters (a `BEGIN` and its
   * `COMMIT` must land on the same backend), hence `.reserve()`.
   */
  async function withProductionMutexHeld(
    run: (release: () => Promise<void>) => Promise<void>
  ): Promise<void> {
    const client = postgres(process.env.DATABASE_URL!, { max: 1 });
    const reserved = await client.reserve();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await reserved.unsafe('commit');
    };
    try {
      await reserved.unsafe('begin');
      await reserved.unsafe(`select pg_advisory_xact_lock(${GLOBAL_ADMIN_MUTEX})`);
      await run(release);
    } finally {
      await release();
      reserved.release();
      await client.end();
    }
  }

  /**
   * How many backends are currently BLOCKED waiting for GLOBAL_ADMIN_MUTEX.
   * `pg_advisory_xact_lock(bigint)` records itself in `pg_locks` as
   * `locktype = 'advisory'`, `classid` = the key's high 32 bits (0 here),
   * `objid` = its low 32 bits, `objsubid = 1` — verified against the live
   * database. `objid::bigint` avoids an oid-vs-bigint operator mismatch on
   * the bound parameter.
   */
  async function mutexWaiters(): Promise<number> {
    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_locks
      where locktype = 'advisory' and objsubid = 1 and classid = 0
        and objid::bigint = ${GLOBAL_ADMIN_MUTEX} and not granted
    `);
    return Number(rows[0]?.n ?? 0);
  }

  /** Bounded poll — never a fixed sleep (AGENTS.md). Returns false on timeout. */
  async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * Seeds `soleAdminId` as the only global admin plus an ordinary throwaway
   * target, parks the mutex, fires `removal(targetId)` without awaiting it,
   * proves it is BLOCKED (not merely slow, and not already finished), then
   * commits "the target is now the last global admin" and releases.
   *
   * Returns the removal's response AND the target's row as it stood the
   * moment the removal returned — read here, before the fixture's own
   * cleanup deletes the target, so callers can assert on the outcome rather
   * than on a row this helper has already removed.
   */
  async function removalParkedThenAdminSetFlipped(
    removal: (targetId: string) => Promise<Response> | Response
  ): Promise<{ res: Response; after: { isGlobalAdmin: boolean } | undefined }> {
    let out!: { res: Response; after: { isGlobalAdmin: boolean } | undefined };
    await withSoleGlobalAdmin(async (soleAdminId) => {
      const { body: created } = await createUserViaApi();
      const targetId = created.user.id;
      try {
        await withProductionMutexHeld(async (release) => {
          let settled = false;
          const pending = Promise.resolve(removal(targetId)).then((r) => {
            settled = true;
            return r;
          });

          const reached = await waitUntil(async () => settled || (await mutexWaiters()) > 0);
          expect(reached, 'timed out: the removal neither parked on the mutex nor finished').toBe(true);
          expect(
            settled,
            'the removal must PARK on GLOBAL_ADMIN_MUTEX — finishing while the test holds it means its guard read is not serialised against other removers'
          ).toBe(false);

          // Committed WHILE the removal is parked: the target becomes the
          // one and only global admin. A guard that read before/around its
          // wait cannot see this; one that reads after acquiring the mutex
          // must.
          await db.update(users).set({ isGlobalAdmin: true }).where(eq(users.id, targetId));
          await db.update(users).set({ isGlobalAdmin: false }).where(eq(users.id, soleAdminId));

          await release();
          const res = await pending;
          const [after] = await db
            .select({ isGlobalAdmin: users.isGlobalAdmin })
            .from(users)
            .where(eq(users.id, targetId));
          out = { res, after };
        });
      } finally {
        await db.delete(users).where(eq(users.id, targetId));
      }
    });
    return out;
  }

  it('a DELETE parked on the mutex refuses, because the target became the last global admin while it waited', async () => {
    const { res, after } = await removalParkedThenAdminSetFlipped((id) =>
      app.request(`/api/v1/admin/users/${id}`, { method: 'DELETE', headers: authHeaders() })
    );

    expect(res.status).toBe(409);
    expect(after, 'the last global admin must survive the parked DELETE').toBeDefined();
    expect(after!.isGlobalAdmin).toBe(true);
  });

  it('a PATCH-demote parked on the mutex refuses, because the target became the last global admin while it waited', async () => {
    const { res, after } = await removalParkedThenAdminSetFlipped((id) =>
      app.request(`/api/v1/admin/users/${id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ isGlobalAdmin: false }),
      })
    );

    expect(res.status).toBe(409);
    expect(after, 'the target row must still exist').toBeDefined();
    expect(after!.isGlobalAdmin, 'the last global admin must not be demoted by the parked PATCH').toBe(true);
  });
});

describeAdmin('PATCH 404s, not 500s, when the target is deleted mid-request (fix round 3, minor)', () => {
  it('a PATCH against a target deleted between the read and the write returns 404', async () => {
    const { body: created } = await createUserViaApi();
    const targetId = created.user.id;

    const spy = findFirstOnce(targetId, async () => {
      await db.delete(users).where(eq(users.id, targetId));
    });

    try {
      const res = await app.request(`/api/v1/admin/users/${targetId}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ displayName: 'Should never apply' }),
      });
      expect(res.status).toBe(404);
    } finally {
      spy.mockRestore();
    }
  });
});
