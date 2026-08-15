import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAdminApi, AdminApiError, NotAuthenticatedError } from './adminApi';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('adminApi auth + wiring', () => {
  it("forwards the caller's session cookie, not an ADMIN_TOKEN", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ projects: [] }));
    await createAdminApi('sess-abc', null).listProjects();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Cookie).toBe('fk_session=sess-abc');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('refuses to call the admin API with no session rather than calling it anonymously', async () => {
    await expect(createAdminApi(null, null).listProjects()).rejects.toBeInstanceOf(NotAuthenticatedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a 403 from the API as an AdminApiError carrying the status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Global admin required' }, 403));
    await expect(createAdminApi('s', null).listTeams()).rejects.toMatchObject({ statusCode: 403 });
  });

  // Delta 2026-08-15 (§D1.2): without these the dashboard puts every user in
  // one rate-limit bucket. Task 0 made the API able to trust the header; these
  // prove the dashboard actually sends it.
  it('forwards the browser IP as X-Forwarded-For so the API keys per user', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ projects: [] }));
    await createAdminApi('sess-abc', '203.0.113.7').listProjects();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['X-Forwarded-For']).toBe('203.0.113.7');
  });

  it('omits X-Forwarded-For entirely when there is no client IP', async () => {
    // An empty header is worse than none: getClientIp takes the first
    // comma-separated hop, so '' would key every such request to the same
    // empty-string bucket rather than falling back to the socket address.
    fetchMock.mockResolvedValue(jsonResponse({ projects: [] }));
    await createAdminApi('sess-abc', null).listProjects();
    const [, init] = fetchMock.mock.calls[0];
    expect('X-Forwarded-For' in init.headers).toBe(false);
  });

  it('sends the list endpoint with a GET', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ projects: [] }));
    await createAdminApi('sess-abc', null).listProjects();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects');
    expect(init.method).toBe('GET');
  });

  it('POSTs create with a JSON body and Content-Type', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ project: {}, token: 't', warning: 'w' }, 201));
    await createAdminApi('sess-abc', null).createProject({ name: 'proj' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ name: 'proj' });
  });

  it('PATCHes the project config', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await createAdminApi('sess-abc', null).patchProject('p1', { windowDays: 14 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ windowDays: 14 });
  });

  it('rotates the token via POST with no body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ project: {}, token: 't', warning: 'w' }));
    await createAdminApi('sess-abc', null).rotateToken('p1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1/rotate-token');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('adds ?confirm=true only when confirming a prune', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ dryRun: true, cutoff: 'x' }));
    const adminApi = createAdminApi('sess-abc', null);
    await adminApi.pruneProject('p1', false);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/api/v1/admin/projects/p1/prune');
    await adminApi.pruneProject('p1', true);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://localhost:8080/api/v1/admin/projects/p1/prune?confirm=true'
    );
  });

  it('DELETEs the project', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, message: 'gone' }));
    await createAdminApi('sess-abc', null).deleteProject('p1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1');
    expect(init.method).toBe('DELETE');
  });

  it('GETs a project rules list', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ rules: [] }));
    await createAdminApi('sess-abc', null).listRules('p1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1/rules');
    expect(init.method).toBe('GET');
    expect(init.headers.Cookie).toBe('fk_session=sess-abc');
  });

  it('POSTs a new rule with a JSON body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ rule: {} }, 201));
    await createAdminApi('sess-abc', null).createRule('p1', { action: 'exempt' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1/rules');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ action: 'exempt' });
  });

  it('PATCHes a rule by id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ rule: {} }));
    await createAdminApi('sess-abc', null).patchRule('p1', 'r1', { enabled: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1/rules/r1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ enabled: false });
  });

  it('DELETEs a rule by id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await createAdminApi('sess-abc', null).deleteRule('p1', 'r1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1/rules/r1');
    expect(init.method).toBe('DELETE');
  });

  it('POSTs the full id order to reorder', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await createAdminApi('sess-abc', null).reorderRules('p1', ['r2', 'r1']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1/rules/reorder');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ order: ['r2', 'r1'] });
  });

  it('forwards the API error body and status on a non-2xx', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'Project with this name already exists' }, 409)
    );
    const err = await createAdminApi('sess-abc', null).createProject({ name: 'dup' }).catch((e) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('Project with this name already exists');
  });

  it('falls back to a generic message when the error body has no `error`', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    const err = await createAdminApi('sess-abc', null).listProjects().catch((e) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err.statusCode).toBe(500);
    expect(err.message).toBe('API request failed (500)');
  });
});

describe('adminApi teams', () => {
  it('GETs the team list', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ teams: [] }));
    await createAdminApi('sess-abc', null).listTeams();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/teams');
    expect(init.method).toBe('GET');
  });

  it('POSTs a new team by name', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ team: {} }, 201));
    await createAdminApi('sess-abc', null).createTeam('Team A');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/teams');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ name: 'Team A' });
  });

  it('PATCHes a team name', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ team: {} }));
    await createAdminApi('sess-abc', null).patchTeam('t1', 'New name');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/teams/t1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ name: 'New name' });
  });

  it('DELETEs a team', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, orphanedProjects: 0 }));
    await createAdminApi('sess-abc', null).deleteTeam('t1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/teams/t1');
    expect(init.method).toBe('DELETE');
  });

  it('GETs a team member list', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ members: [] }));
    await createAdminApi('sess-abc', null).listTeamMembers('t1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/teams/t1/members');
    expect(init.method).toBe('GET');
  });

  it('POSTs a new team member with a role', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 201));
    await createAdminApi('sess-abc', null).addTeamMember('t1', 'u1', 'member');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/teams/t1/members');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ userId: 'u1', role: 'member' });
  });

  it("PATCHes a team member's role", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await createAdminApi('sess-abc', null).patchTeamMember('t1', 'u1', 'team_admin');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/teams/t1/members/u1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ role: 'team_admin' });
  });

  it('DELETEs a team member', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await createAdminApi('sess-abc', null).removeTeamMember('t1', 'u1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/teams/t1/members/u1');
    expect(init.method).toBe('DELETE');
  });
});

describe('adminApi users', () => {
  it('GETs the user list', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ users: [] }));
    await createAdminApi('sess-abc', null).listUsers();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/users');
    expect(init.method).toBe('GET');
  });

  it('POSTs a new user', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: {}, temporaryPassword: 'x', warning: 'w' }, 201));
    await createAdminApi('sess-abc', null).createUser({ email: 'a@b.c' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/users');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ email: 'a@b.c' });
  });

  it('PATCHes a user', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: {} }));
    await createAdminApi('sess-abc', null).patchUser('u1', { displayName: 'A' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/users/u1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ displayName: 'A' });
  });

  it('POSTs a reset-password with no body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ temporaryPassword: 'x', warning: 'w' }));
    await createAdminApi('sess-abc', null).resetUserPassword('u1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/users/u1/reset-password');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('DELETEs a user', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await createAdminApi('sess-abc', null).deleteUser('u1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/users/u1');
    expect(init.method).toBe('DELETE');
  });
});
