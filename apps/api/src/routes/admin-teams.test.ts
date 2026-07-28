import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, teamMembers, projects } from '../db';
import { hashToken, generateToken } from '../middleware/auth';

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

const uniqueName = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

async function createTeam(name = uniqueName('team')) {
  const res = await app.request('/api/v1/admin/teams', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name }),
  });
  return { res, body: await res.json() };
}

async function createUser() {
  const res = await app.request('/api/v1/admin/users', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ email: `member-${crypto.randomUUID()}@example.test` }),
  });
  return (await res.json()).user;
}

describeAdmin('team CRUD', () => {
  it('requires an admin token', async () => {
    const res = await app.request('/api/v1/admin/teams', { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('creates a team', async () => {
    const { res, body } = await createTeam();
    expect(res.status).toBe(201);
    expect(body.team.id).toBeTruthy();
  });

  it('409s on a duplicate name', async () => {
    const name = uniqueName('dup');
    await createTeam(name);
    const { res } = await createTeam(name);
    expect(res.status).toBe(409);
  });

  it('400s on an empty name', async () => {
    const res = await app.request('/api/v1/admin/teams', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('lists teams with member and project counts', async () => {
    const { body: created } = await createTeam();
    const user = await createUser();
    await app.request(`/api/v1/admin/teams/${created.team.id}/members`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId: user.id, role: 'member' }),
    });

    const res = await app.request('/api/v1/admin/teams', { headers: authHeaders() });
    const listed = (await res.json()).teams.find((t: { id: string }) => t.id === created.team.id);
    expect(listed.memberCount).toBe(1);
    expect(listed.projectCount).toBe(0);
  });

  it('renames a team', async () => {
    const { body } = await createTeam();
    const next = uniqueName('renamed');
    const res = await app.request(`/api/v1/admin/teams/${body.team.id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ name: next }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).team.name).toBe(next);
  });

  it('404s for an unknown team', async () => {
    const res = await app.request(`/api/v1/admin/teams/${crypto.randomUUID()}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ name: uniqueName('x') }),
    });
    expect(res.status).toBe(404);
  });

  it('409s renaming a team to a name already in use', async () => {
    const { body: a } = await createTeam();
    const { body: b } = await createTeam();
    const res = await app.request(`/api/v1/admin/teams/${b.team.id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ name: a.team.name }),
    });
    expect(res.status).toBe(409);
  });
});

describeAdmin('DELETE /api/v1/admin/teams/:teamId', () => {
  it('ORPHANS its projects instead of deleting them, and reports how many', async () => {
    const { body: team } = await createTeam();

    // Seeded directly rather than via `POST /api/v1/admin/projects` because
    // that endpoint does not yet accept `teamId` — wiring it up is Task 6's
    // job (plan 057), not started on this branch. The behaviour under test
    // here is the `ON DELETE SET NULL` FK plus THIS endpoint's
    // `orphanedProjects` count, and neither depends on how the project
    // acquired its team_id — a direct insert arranges the identical
    // precondition and exercises the identical Postgres FK behaviour, so
    // nothing about the assertion is weakened. Once Task 6 lands, resist
    // the urge to "simplify" this back into an API call: Task 6 owns its
    // own round-trip coverage for the `teamId` field.
    const [project] = await db
      .insert(projects)
      .values({
        name: uniqueName('proj'),
        teamId: team.team.id,
        tokenHash: hashToken(generateToken()),
      })
      .returning();

    try {
      const res = await app.request(`/api/v1/admin/teams/${team.team.id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).orphanedProjects).toBe(1);

      // The project survives, unowned. This is THE load-bearing assertion of the
      // SET NULL decision — if it ever flips to cascade, this test is what says so.
      const [survivor] = await db.select().from(projects).where(eq(projects.id, project.id));
      expect(survivor).toBeDefined();
      expect(survivor.teamId).toBeNull();
    } finally {
      // Scoped to the row this test created, by id — never a table-wide
      // count, since other suite files create/read `projects` concurrently
      // (apps/api has no vitest config, so the default forks pool runs
      // files in parallel).
      await db.delete(projects).where(eq(projects.id, project.id));
    }
  });

  it('cascades its memberships', async () => {
    const { body: team } = await createTeam();
    const user = await createUser();
    await app.request(`/api/v1/admin/teams/${team.team.id}/members`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId: user.id, role: 'member' }),
    });

    await app.request(`/api/v1/admin/teams/${team.team.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });

    const left = await db.select().from(teamMembers).where(eq(teamMembers.teamId, team.team.id));
    expect(left).toHaveLength(0);
  });
});

describeAdmin('membership sub-routes', () => {
  it('adds a member with a role', async () => {
    const { body: team } = await createTeam();
    const user = await createUser();
    const res = await app.request(`/api/v1/admin/teams/${team.team.id}/members`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId: user.id, role: 'team_admin' }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).member.role).toBe('team_admin');
  });

  it('rejects an unknown role', async () => {
    const { body: team } = await createTeam();
    const user = await createUser();
    const res = await app.request(`/api/v1/admin/teams/${team.team.id}/members`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId: user.id, role: 'superuser' }),
    });
    expect(res.status).toBe(400);
  });

  it('409s when the user is already a member (the unique index, surfaced honestly)', async () => {
    const { body: team } = await createTeam();
    const user = await createUser();
    const add = () =>
      app.request(`/api/v1/admin/teams/${team.team.id}/members`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ userId: user.id, role: 'member' }),
      });
    expect((await add()).status).toBe(201);
    expect((await add()).status).toBe(409);
  });

  it('404s when adding an unknown user', async () => {
    const { body: team } = await createTeam();
    const res = await app.request(`/api/v1/admin/teams/${team.team.id}/members`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId: crypto.randomUUID(), role: 'member' }),
    });
    expect(res.status).toBe(404);
  });

  it('lists members with the documented shape and never leaks the password hash', async () => {
    const { body: team } = await createTeam();
    const user = await createUser();
    await app.request(`/api/v1/admin/teams/${team.team.id}/members`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId: user.id, role: 'member' }),
    });

    const res = await app.request(`/api/v1/admin/teams/${team.team.id}/members`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(JSON.stringify(body)).not.toContain('scrypt$');

    const listed = body.members.find((m: { userId: string }) => m.userId === user.id);
    expect(listed).toMatchObject({
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: 'member',
    });
    expect(listed).not.toHaveProperty('passwordHash');
  });

  it('404s listing members of an unknown team', async () => {
    const res = await app.request(`/api/v1/admin/teams/${crypto.randomUUID()}/members`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it('changes a role', async () => {
    const { body: team } = await createTeam();
    const user = await createUser();
    await app.request(`/api/v1/admin/teams/${team.team.id}/members`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId: user.id, role: 'member' }),
    });
    const res = await app.request(`/api/v1/admin/teams/${team.team.id}/members/${user.id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ role: 'team_admin' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).member.role).toBe('team_admin');
  });

  it('404s changing the role of a non-member', async () => {
    const { body: team } = await createTeam();
    const user = await createUser();
    const res = await app.request(`/api/v1/admin/teams/${team.team.id}/members/${user.id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ role: 'team_admin' }),
    });
    expect(res.status).toBe(404);
  });

  it('removes a member without deleting the user', async () => {
    const { body: team } = await createTeam();
    const user = await createUser();
    await app.request(`/api/v1/admin/teams/${team.team.id}/members`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ userId: user.id, role: 'member' }),
    });
    const res = await app.request(`/api/v1/admin/teams/${team.team.id}/members/${user.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);

    const memberships = await db.select().from(teamMembers).where(eq(teamMembers.userId, user.id));
    expect(memberships).toHaveLength(0);

    const stillListed = await app.request('/api/v1/admin/users', { headers: authHeaders() });
    const found = (await stillListed.json()).users.find((u: { id: string }) => u.id === user.id);
    expect(found).toBeDefined();
  });

  it('404s removing a non-member', async () => {
    const { body: team } = await createTeam();
    const user = await createUser();
    const res = await app.request(`/api/v1/admin/teams/${team.team.id}/members/${user.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });
});
