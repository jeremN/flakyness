import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project, SessionUser } from '../app.d';

vi.mock('$lib/server/api', () => ({
  createApi: vi.fn(),
}));

import { createApi } from '$lib/server/api';
import { load } from './+layout.server';

const projectA: Project = { id: 'a', name: 'Project A', createdAt: '2024-01-01', teamId: null };
const projectB: Project = { id: 'b', name: 'Project B', createdAt: '2024-01-02', teamId: null };

const signedInUser: SessionUser = {
  id: 'u1',
  email: 'a@b.c',
  displayName: null,
  isGlobalAdmin: false,
  mustChangePassword: false,
};

const mockedGetProjects = vi.fn();
vi.mocked(createApi).mockReturnValue({ getProjects: mockedGetProjects } as unknown as ReturnType<typeof createApi>);

beforeEach(() => {
  mockedGetProjects.mockReset();
  // Clears createApi's own call history (mockReturnValue survives mockClear),
  // so an identity assertion below only sees this test's own call — see the
  // task-2b review's finding on flaky/page.server.test.ts for why an
  // un-cleared factory mock can make an argument-swap assertion vacuous.
  vi.mocked(createApi).mockClear();
});

// Defaults to a signed-in, non-mid-reset user so the existing behavioural
// tests below keep exercising the fetch path unchanged; the two guard tests
// override `user` explicitly to drive the skip.
function event(url: string, locals: Partial<App.Locals> = {}) {
  return {
    url: new URL(url),
    locals: { sessionToken: null, clientIp: null, user: signedInUser, teams: [], ...locals },
  } as any;
}

describe('routes/+layout.server load', () => {
  it('selects the project matching the ?project= query param', async () => {
    mockedGetProjects.mockResolvedValue([projectA, projectB]);

    const result = await load(event('http://x/?project=b'));

    expect(result.selectedProject?.id).toBe('b');
  });

  it('falls back to the first project when no query param is given', async () => {
    mockedGetProjects.mockResolvedValue([projectA, projectB]);

    const result = await load(event('http://x/'));

    expect(result.selectedProject?.id).toBe('a');
  });

  it('falls back to the first project when the query param id is unknown', async () => {
    mockedGetProjects.mockResolvedValue([projectA, projectB]);

    const result = await load(event('http://x/?project=unknown'));

    expect(result.selectedProject?.id).toBe('a');
  });

  it('returns an empty project list and a null selectedProject when there are no projects', async () => {
    mockedGetProjects.mockResolvedValue([]);

    const result = await load(event('http://x/'));

    expect(result).toEqual({
      projects: [],
      selectedProject: null,
      apiError: null,
      user: signedInUser,
      teams: [],
      activeTeam: null,
    });
  });

  it('falls back to an empty dashboard shape when getProjects rejects', async () => {
    mockedGetProjects.mockRejectedValue(new Error('api down'));

    const result = await load(event('http://x/'));

    expect(result.projects).toEqual([]);
    expect(result.selectedProject).toBeNull();
    expect(typeof result.apiError).toBe('string');
  });

  it('builds the client from the request session', async () => {
    mockedGetProjects.mockResolvedValue([]);

    await load({
      url: new URL('http://x/'),
      locals: { sessionToken: 'sess-1', clientIp: '203.0.113.7', user: signedInUser, teams: [] },
    } as any);

    expect(createApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });

  it('filters visible projects by teamId when ?team= is set, without asking the API for less', async () => {
    const projectC: Project = { id: 'c', name: 'Project C', createdAt: '2024-01-03', teamId: 't1' };
    mockedGetProjects.mockResolvedValue([projectA, projectC]);

    const result = await load(event('http://x/?team=t1'));

    // The API call itself is unscoped by ?team= — this is a client-side
    // narrowing over what the API already returned, never a request for less.
    expect(mockedGetProjects).toHaveBeenCalledTimes(1);
    expect(result.projects.map((p: Project) => p.id)).toEqual(['c']);
    expect(result.activeTeam).toBe('t1');
  });

  it(
    "skips the projects fetch and surfaces no apiError for a mid-reset user (delta §D2) — " +
      'getProjects() would 403 password_change_required on this exact route, which the catch ' +
      'would otherwise misreport as an unreachable API',
    async () => {
      const midResetUser = { ...signedInUser, mustChangePassword: true };

      const result = await load(event('http://x/change-password', { user: midResetUser }));

      expect(mockedGetProjects).not.toHaveBeenCalled();
      expect(result.apiError).toBeNull();
    }
  );

  it(
    'skips the projects fetch for an anonymous caller — this is the guard against the leak ' +
      'described in the load-bearing comment above `if (locals.user && ...)`: without the ' +
      '`locals.user &&` half, an anonymous request on /login would still call getProjects() and ' +
      'render every project name on the instance to a visitor sitting on the sign-in page',
    async () => {
      const result = await load(event('http://x/login', { user: null, teams: [] }));

      expect(mockedGetProjects).not.toHaveBeenCalled();
      // Not `expect(result.projects).toEqual([])` — projects is [] either way
      // (the mock's default unresolved state also yields []), so that
      // assertion would pass against the leaking `!locals.user?.
      // mustChangePassword` condition too whenever the mock happened not to
      // resolve. Only the fetch-not-called assertion above actually proves
      // the guard fired.
      expect(result.user).toBeNull();
    }
  );
});
