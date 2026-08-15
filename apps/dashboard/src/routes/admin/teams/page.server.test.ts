import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/adminApi', () => ({
  createAdminApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {
    statusCode: number;
    constructor(status: number, message: string) {
      super(message);
      this.statusCode = status;
    }
  },
  NotAuthenticatedError: class NotAuthenticatedError extends Error {
    constructor() {
      super('Not signed in.');
    }
  },
}));

import { createAdminApi, AdminApiError, NotAuthenticatedError } from '$lib/server/adminApi';
import { load, actions } from './+page.server';

const mockedListTeams = vi.fn();
const mockedListUsers = vi.fn();
const mockedCreateTeam = vi.fn();
const mockedPatchTeam = vi.fn();
const mockedDeleteTeam = vi.fn();
const mockedAddTeamMember = vi.fn();
const mockedPatchTeamMember = vi.fn();
const mockedRemoveTeamMember = vi.fn();

vi.mocked(createAdminApi).mockReturnValue({
  listTeams: mockedListTeams,
  listUsers: mockedListUsers,
  createTeam: mockedCreateTeam,
  patchTeam: mockedPatchTeam,
  deleteTeam: mockedDeleteTeam,
  addTeamMember: mockedAddTeamMember,
  patchTeamMember: mockedPatchTeamMember,
  removeTeamMember: mockedRemoveTeamMember,
} as unknown as ReturnType<typeof createAdminApi>);

function team(overrides: Record<string, unknown> = {}) {
  return { id: 't1', name: 'Team One', createdAt: '2026-01-01T00:00:00Z', memberCount: 2, projectCount: 3, ...overrides };
}

function loadEvent(
  user: { isGlobalAdmin: boolean } | null = { isGlobalAdmin: true },
  sessionToken: string | null = 'sess-1',
  clientIp: string | null = null
) {
  return { locals: { user, sessionToken, clientIp } } as any;
}

function formEvent(
  fields: Record<string, string>,
  user: { isGlobalAdmin: boolean } | null = { isGlobalAdmin: true },
  sessionToken: string | null = 'sess-1',
  clientIp: string | null = null
) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return {
    request: { formData: async () => fd },
    locals: { user, sessionToken, clientIp },
  } as any;
}

beforeEach(() => {
  mockedListTeams.mockReset();
  mockedListUsers.mockReset();
  mockedCreateTeam.mockReset();
  mockedPatchTeam.mockReset();
  mockedDeleteTeam.mockReset();
  mockedAddTeamMember.mockReset();
  mockedPatchTeamMember.mockReset();
  mockedRemoveTeamMember.mockReset();
  // Clears createAdminApi's own call history (mockReturnValue survives
  // mockClear) so an identity assertion below only sees this test's own call.
  vi.mocked(createAdminApi).mockClear();
});

describe('teams load', () => {
  it('404s for a non-global-admin', async () => {
    await expect(load(loadEvent({ isGlobalAdmin: false }))).rejects.toMatchObject({ status: 404 });
    expect(mockedListTeams).not.toHaveBeenCalled();
    expect(mockedListUsers).not.toHaveBeenCalled();
  });

  it('404s for an anonymous caller', async () => {
    await expect(load(loadEvent(null))).rejects.toMatchObject({ status: 404 });
    expect(mockedListTeams).not.toHaveBeenCalled();
  });

  it('loads teams and users for a global admin', async () => {
    mockedListTeams.mockResolvedValue({ teams: [team()] });
    mockedListUsers.mockResolvedValue({ users: [] });
    const result = await load(loadEvent());
    expect(result).toEqual({ teams: [team()], users: [] });
  });

  // Distinct, both non-null: an argument swap (createAdminApi(clientIp,
  // sessionToken)) compiles clean since both are `string | null` — only a
  // call-site assertion with two distinguishable values catches it.
  it('builds the admin client from the session and client IP', async () => {
    mockedListTeams.mockResolvedValue({ teams: [] });
    mockedListUsers.mockResolvedValue({ users: [] });
    await load(loadEvent({ isGlobalAdmin: true }, 'sess-1', '203.0.113.7'));
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });

  // CRITICAL #1(c): the `Promise.all` had no error handling at all — a
  // rejection surfaced as a generic 500 with `status === undefined`, the
  // only admin load in the repo without this catch (siblings:
  // admin/+page.server.ts, rules/+page.server.ts). Both branches of the
  // catch's status mapping are exercised below.
  it('maps an AdminApiError from listTeams/listUsers to that status, not an unhandled 500', async () => {
    mockedListTeams.mockRejectedValue(new AdminApiError(503, 'API down'));
    mockedListUsers.mockResolvedValue({ users: [] });
    await expect(load(loadEvent())).rejects.toMatchObject({ status: 503 });
  });

  it('falls back to a 502 for a raw network error from listTeams/listUsers', async () => {
    mockedListTeams.mockRejectedValue(new TypeError('fetch failed'));
    mockedListUsers.mockResolvedValue({ users: [] });
    await expect(load(loadEvent())).rejects.toMatchObject({ status: 502 });
  });
});

describe('create action', () => {
  it('creates a team', async () => {
    mockedCreateTeam.mockResolvedValue({ team: team() });
    const result = await actions.create(formEvent({ name: 'New Team' }));
    expect(mockedCreateTeam).toHaveBeenCalledWith('New Team');
    expect(result).toEqual({ success: true });
  });

  it('rejects an empty team name without calling the API', async () => {
    const result = (await actions.create(formEvent({ name: '   ' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedCreateTeam).not.toHaveBeenCalled();
  });

  it('refuses for a non-global-admin without calling the API', async () => {
    const result = (await actions.create(formEvent({ name: 'New Team' }, { isGlobalAdmin: false }))) as any;
    expect(result.status).toBe(403);
    expect(mockedCreateTeam).not.toHaveBeenCalled();
  });

  it('surfaces the API message on a 409 (duplicate team name)', async () => {
    mockedCreateTeam.mockRejectedValue(new AdminApiError(409, 'A team with this name already exists'));
    const result = (await actions.create(formEvent({ name: 'Dup' }))) as any;
    expect(result.status).toBe(409);
    expect(result.data.error).toBe('A team with this name already exists');
  });

  it('maps a NotAuthenticatedError from the API to a 403 fail', async () => {
    mockedCreateTeam.mockRejectedValue(new NotAuthenticatedError());
    const result = (await actions.create(formEvent({ name: 'New Team' }))) as any;
    expect(result.status).toBe(403);
  });

  // CRITICAL #1(a): `toFail`'s fallback branch. A raw network failure (e.g.
  // `fetch` to a dead API) rejects with a plain `TypeError`, not an
  // `AdminApiError`/`NotAuthenticatedError` — this proves it degrades to an
  // inline `fail(502, ...)` like every other admin console, rather than
  // rethrowing and letting SvelteKit render a full-page 500 with `form`
  // never populated.
  it('maps an unrecognized throw to a 502 fail instead of propagating it', async () => {
    mockedCreateTeam.mockRejectedValue(new TypeError('fetch failed'));
    const result = (await actions.create(formEvent({ name: 'New Team' }))) as any;
    expect(result.status).toBe(502);
    expect(result.data.error).toBe('Unexpected error contacting the API.');
  });

  it('builds the admin client from the session and client IP', async () => {
    mockedCreateTeam.mockResolvedValue({ team: team() });
    await actions.create(formEvent({ name: 'New Team' }, { isGlobalAdmin: true }, 'sess-1', '203.0.113.7'));
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });
});

describe('rename action', () => {
  it('renames a team', async () => {
    mockedPatchTeam.mockResolvedValue({ team: team({ name: 'Renamed' }) });
    const result = await actions.rename(formEvent({ teamId: 't1', name: 'Renamed' }));
    expect(mockedPatchTeam).toHaveBeenCalledWith('t1', 'Renamed');
    expect(result).toEqual({ success: true });
  });

  it('rejects an empty team name without calling the API', async () => {
    const result = (await actions.rename(formEvent({ teamId: 't1', name: '  ' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedPatchTeam).not.toHaveBeenCalled();
  });

  it('refuses for a non-global-admin without calling the API', async () => {
    const result = (await actions.rename(formEvent({ teamId: 't1', name: 'x' }, { isGlobalAdmin: false }))) as any;
    expect(result.status).toBe(403);
    expect(mockedPatchTeam).not.toHaveBeenCalled();
  });

  it('surfaces the API message on a 409 (duplicate team name)', async () => {
    mockedPatchTeam.mockRejectedValue(new AdminApiError(409, 'A team with this name already exists'));
    const result = (await actions.rename(formEvent({ teamId: 't1', name: 'Dup' }))) as any;
    expect(result.status).toBe(409);
    expect(result.data.error).toBe('A team with this name already exists');
  });

  it('builds the admin client from the session and client IP', async () => {
    mockedPatchTeam.mockResolvedValue({ team: team() });
    await actions.rename(formEvent({ teamId: 't1', name: 'Renamed' }, { isGlobalAdmin: true }, 'sess-1', '203.0.113.7'));
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });
});

describe('delete action', () => {
  it('refuses to delete when the typed name does not match', async () => {
    mockedListTeams.mockResolvedValue({ teams: [team({ name: 'Team One' })] });
    const result = (await actions.delete(formEvent({ teamId: 't1', confirmName: 'wrong' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedDeleteTeam).not.toHaveBeenCalled();
  });

  it('compares the typed name against the freshly-fetched server name, not a submitted one', async () => {
    mockedListTeams.mockResolvedValue({ teams: [team({ name: 'Real Name' })] });

    // A forged `expectedName` field must not be able to substitute for the
    // live `listTeams()` read — the action has never read that field, but
    // submitting it alongside a matching `confirmName` is exactly the shape
    // a naive "compare against a submitted expected value" implementation
    // would accept. Without this field present, a mutant that reads
    // `form.get('expectedName') ?? team.name` instead of `team.name` behaves
    // identically to the real code under this test (both fall back to
    // `team.name` when the field is absent) and survives undetected.
    const stale = (await actions.delete(
      formEvent({ teamId: 't1', confirmName: 'Stale Name', expectedName: 'Stale Name' })
    )) as any;
    expect(stale.status).toBe(400);
    expect(mockedDeleteTeam).not.toHaveBeenCalled();

    mockedDeleteTeam.mockResolvedValue({ success: true, orphanedProjects: 0 });
    const ok = await actions.delete(formEvent({ teamId: 't1', confirmName: 'Real Name' }));
    expect(mockedDeleteTeam).toHaveBeenCalledWith('t1');
    expect(ok).toEqual({ success: true, orphanedProjects: 0 });
  });

  it('returns the orphaned project count on a successful delete', async () => {
    mockedListTeams.mockResolvedValue({ teams: [team({ name: 'Team One' })] });
    mockedDeleteTeam.mockResolvedValue({ success: true, orphanedProjects: 4 });
    const result = await actions.delete(formEvent({ teamId: 't1', confirmName: 'Team One' }));
    expect(result).toEqual({ success: true, orphanedProjects: 4 });
  });

  // CRITICAL #1(b): the pre-check `listTeams()` call (fetching the
  // authoritative name to compare against) used to sit outside any `try`, so
  // even a *handled* AdminApiError — an expired session, a 429 from the
  // admin rate limiter — propagated out of the action as an unhandled throw
  // instead of degrading to an inline fail. No outage needed to hit this;
  // it's the most reachable of the three CRITICAL #1 sites.
  it('surfaces an AdminApiError from the pre-check listTeams() as an inline fail, not a throw', async () => {
    mockedListTeams.mockRejectedValue(new AdminApiError(429, 'Too many requests'));
    const result = (await actions.delete(formEvent({ teamId: 't1', confirmName: 'x' }))) as any;
    expect(result.status).toBe(429);
    expect(result.data.error).toBe('Too many requests');
    expect(mockedDeleteTeam).not.toHaveBeenCalled();
  });

  it('404s when the team is not found', async () => {
    mockedListTeams.mockResolvedValue({ teams: [] });
    const result = (await actions.delete(formEvent({ teamId: 'missing', confirmName: 'x' }))) as any;
    expect(result.status).toBe(404);
    expect(mockedDeleteTeam).not.toHaveBeenCalled();
  });

  it('surfaces the API message on a 409 from the delete call itself', async () => {
    mockedListTeams.mockResolvedValue({ teams: [team({ name: 'Team One' })] });
    mockedDeleteTeam.mockRejectedValue(new AdminApiError(409, 'conflict deleting team'));
    const result = (await actions.delete(formEvent({ teamId: 't1', confirmName: 'Team One' }))) as any;
    expect(result.status).toBe(409);
    expect(result.data.error).toBe('conflict deleting team');
  });

  it('refuses for a non-global-admin without calling the API', async () => {
    const result = (await actions.delete(formEvent({ teamId: 't1', confirmName: 'x' }, { isGlobalAdmin: false }))) as any;
    expect(result.status).toBe(403);
    expect(mockedListTeams).not.toHaveBeenCalled();
    expect(mockedDeleteTeam).not.toHaveBeenCalled();
  });

  it('builds the admin client from the session and client IP', async () => {
    mockedListTeams.mockResolvedValue({ teams: [team({ name: 'Team One' })] });
    mockedDeleteTeam.mockResolvedValue({ success: true, orphanedProjects: 0 });
    await actions.delete(
      formEvent({ teamId: 't1', confirmName: 'Team One' }, { isGlobalAdmin: true }, 'sess-1', '203.0.113.7')
    );
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });
});

describe('member actions', () => {
  it('adds, re-roles and removes a member', async () => {
    mockedAddTeamMember.mockResolvedValue({ member: {} });
    mockedPatchTeamMember.mockResolvedValue({ member: {} });
    mockedRemoveTeamMember.mockResolvedValue({ success: true });

    const addResult = await actions.addMember(formEvent({ teamId: 't1', userId: 'u1', role: 'member' }));
    expect(mockedAddTeamMember).toHaveBeenCalledWith('t1', 'u1', 'member');
    expect(addResult).toEqual({ success: true });

    const roleResult = await actions.setRole(formEvent({ teamId: 't1', userId: 'u1', role: 'team_admin' }));
    expect(mockedPatchTeamMember).toHaveBeenCalledWith('t1', 'u1', 'team_admin');
    expect(roleResult).toEqual({ success: true });

    const removeResult = await actions.removeMember(formEvent({ teamId: 't1', userId: 'u1' }));
    expect(mockedRemoveTeamMember).toHaveBeenCalledWith('t1', 'u1');
    expect(removeResult).toEqual({ success: true });
  });

  it('surfaces the API message on a 409 when adding a member who is already on the team', async () => {
    mockedAddTeamMember.mockRejectedValue(new AdminApiError(409, 'User is already a member of this team'));
    const result = (await actions.addMember(formEvent({ teamId: 't1', userId: 'u1', role: 'member' }))) as any;
    expect(result.status).toBe(409);
    expect(result.data.error).toBe('User is already a member of this team');
  });

  it('addMember refuses without a userId, without calling the API', async () => {
    const result = (await actions.addMember(formEvent({ teamId: 't1', userId: '', role: 'member' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedAddTeamMember).not.toHaveBeenCalled();
  });

  it('addMember refuses an invalid role, without calling the API', async () => {
    const result = (await actions.addMember(
      formEvent({ teamId: 't1', userId: 'u1', role: 'superadmin' })
    )) as any;
    expect(result.status).toBe(400);
    expect(mockedAddTeamMember).not.toHaveBeenCalled();
  });

  it('setRole refuses an invalid role, without calling the API', async () => {
    const result = (await actions.setRole(
      formEvent({ teamId: 't1', userId: 'u1', role: 'superadmin' })
    )) as any;
    expect(result.status).toBe(400);
    expect(mockedPatchTeamMember).not.toHaveBeenCalled();
  });

  it('refuses every member action for a non-global-admin, without calling the API', async () => {
    const nonAdmin = { isGlobalAdmin: false };
    const addResult = (await actions.addMember(
      formEvent({ teamId: 't1', userId: 'u1', role: 'member' }, nonAdmin)
    )) as any;
    const roleResult = (await actions.setRole(
      formEvent({ teamId: 't1', userId: 'u1', role: 'member' }, nonAdmin)
    )) as any;
    const removeResult = (await actions.removeMember(formEvent({ teamId: 't1', userId: 'u1' }, nonAdmin))) as any;

    expect(addResult.status).toBe(403);
    expect(roleResult.status).toBe(403);
    expect(removeResult.status).toBe(403);
    expect(mockedAddTeamMember).not.toHaveBeenCalled();
    expect(mockedPatchTeamMember).not.toHaveBeenCalled();
    expect(mockedRemoveTeamMember).not.toHaveBeenCalled();
  });

  it('builds the admin client from the session and client IP (addMember)', async () => {
    mockedAddTeamMember.mockResolvedValue({ member: {} });
    await actions.addMember(
      formEvent({ teamId: 't1', userId: 'u1', role: 'member' }, { isGlobalAdmin: true }, 'sess-1', '203.0.113.7')
    );
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });

  it('builds the admin client from the session and client IP (setRole)', async () => {
    mockedPatchTeamMember.mockResolvedValue({ member: {} });
    await actions.setRole(
      formEvent({ teamId: 't1', userId: 'u1', role: 'team_admin' }, { isGlobalAdmin: true }, 'sess-1', '203.0.113.7')
    );
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });

  it('builds the admin client from the session and client IP (removeMember)', async () => {
    mockedRemoveTeamMember.mockResolvedValue({ success: true });
    await actions.removeMember(
      formEvent({ teamId: 't1', userId: 'u1' }, { isGlobalAdmin: true }, 'sess-1', '203.0.113.7')
    );
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });
});

describe('authorization', () => {
  // IMPORTANT #2: a hand-listed set of six action names cannot see a SEVENTH
  // action added later with no guard — the new action contributes nothing to
  // either side of a hand-written comparison, so both stay equal and the test
  // passes regardless (the repo's own documented lesson from
  // password-change-coverage.test.ts, one layer up: "the named-inventory
  // assertions cannot do that job"). Iterating `Object.entries(actions)`
  // instead makes this test see every CURRENTLY exported action, including
  // one added after this test was written, without a corresponding update
  // here. The `{ name, status }` object comparison (not a bare
  // `expect(r?.status).toBe(403)`) puts the offending action's name in the
  // failure message.
  it('every exported action refuses a non-global-admin', async () => {
    for (const [name, action] of Object.entries(actions)) {
      const r = (await (action as any)(formEvent({}, { isGlobalAdmin: false }))) as any;
      expect({ name, status: r?.status }).toEqual({ name, status: 403 });
    }
    expect(mockedCreateTeam).not.toHaveBeenCalled();
    expect(mockedPatchTeam).not.toHaveBeenCalled();
    expect(mockedListTeams).not.toHaveBeenCalled();
    expect(mockedDeleteTeam).not.toHaveBeenCalled();
    expect(mockedAddTeamMember).not.toHaveBeenCalled();
    expect(mockedPatchTeamMember).not.toHaveBeenCalled();
    expect(mockedRemoveTeamMember).not.toHaveBeenCalled();
  });
});
