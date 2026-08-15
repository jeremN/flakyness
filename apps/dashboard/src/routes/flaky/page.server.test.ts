import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/api', () => ({
  createApi: vi.fn(),
  APIError: class APIError extends Error {
    statusCode: number;
    endpoint: string;
    constructor(status: number, message: string, endpoint: string) {
      super(message);
      this.name = 'APIError';
      this.statusCode = status;
      this.endpoint = endpoint;
    }
  },
}));

import { createApi, APIError } from '$lib/server/api';
import { load, actions } from './+page.server';
import type { Project, SessionUser, TeamSummary } from '../../app.d';

const project: Project = { id: 'p1', name: 'Proj', createdAt: '2024-01-01', teamId: 't-admin' };

const user = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: 'u1',
  email: 'a@b.c',
  displayName: null,
  isGlobalAdmin: false,
  mustChangePassword: false,
  ...over,
});

const TEAMS: TeamSummary[] = [{ id: 't-admin', name: 'Owned', role: 'team_admin' }];

const mockedGetFlakyTests = vi.fn();
const mockedSetFlakyStatus = vi.fn();

vi.mocked(createApi).mockReturnValue({
  getFlakyTests: mockedGetFlakyTests,
  setFlakyStatus: mockedSetFlakyStatus,
} as unknown as ReturnType<typeof createApi>);

function loadEvent(
  overrides: Partial<{
    selectedProject: Project | null;
    sessionUser: SessionUser | null;
    teams: TeamSummary[];
    sessionToken: string | null;
    clientIp: string | null;
    searchParams: string;
  }> = {}
) {
  const {
    selectedProject = project,
    sessionUser = null,
    teams = [],
    sessionToken = 'sess-1',
    clientIp = '203.0.113.7',
    searchParams = '',
  } = overrides;
  return {
    url: new URL(`http://localhost/flaky${searchParams}`),
    parent: async () => ({ selectedProject }),
    locals: { user: sessionUser, teams, sessionToken, clientIp },
  } as any;
}

function formEvent(
  fields: Record<string, string>,
  sessionToken: string | null = 'sess-1',
  clientIp: string | null = '203.0.113.7'
) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return {
    request: { formData: async () => fd },
    locals: { sessionToken, clientIp },
  } as any;
}

beforeEach(() => {
  mockedGetFlakyTests.mockReset();
  mockedSetFlakyStatus.mockReset();
});

describe('flaky/+page.server load', () => {
  it('returns canMute: true for a caller canMuteTests accepts', async () => {
    mockedGetFlakyTests.mockResolvedValue([]);
    const result = (await load(loadEvent({ sessionUser: user(), teams: TEAMS }))) as any;
    expect(result.canMute).toBe(true);
  });

  it('returns canMute: false for a caller canMuteTests rejects', async () => {
    mockedGetFlakyTests.mockResolvedValue([]);
    const result = (await load(loadEvent({ sessionUser: user(), teams: [] }))) as any;
    expect(result.canMute).toBe(false);
  });

  it('returns canMute: false with no selected project', async () => {
    const result = (await load(
      loadEvent({ selectedProject: null, sessionUser: user({ isGlobalAdmin: true }) })
    )) as any;
    expect(result.canMute).toBe(false);
    expect(mockedGetFlakyTests).not.toHaveBeenCalled();
  });

  // Distinct, both non-null: an argument swap (createApi(clientIp, sessionToken))
  // compiles clean since both are `string | null` — only a call-site assertion
  // with two distinguishable values catches it.
  it('builds the client from the request session, not a swapped pair', async () => {
    mockedGetFlakyTests.mockResolvedValue([]);
    await load(loadEvent({ sessionToken: 'sess-1', clientIp: '203.0.113.7' }));
    expect(createApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });
});

describe('flaky/+page.server setStatus action', () => {
  it('rejects a request missing id or an invalid status before calling the API', async () => {
    const result = (await actions.setStatus(formEvent({ status: 'ignored' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedSetFlakyStatus).not.toHaveBeenCalled();
  });

  it('maps a 401 APIError to fail(403) with the permission message', async () => {
    mockedSetFlakyStatus.mockRejectedValue(new APIError(401, 'nope', '/x'));
    const result = (await actions.setStatus(formEvent({ id: 'ft-1', status: 'ignored' }))) as any;
    expect(result.status).toBe(403);
    expect(result.data.message).toBe('You do not have permission to mute tests in this project.');
  });

  it('maps a 403 APIError to fail(403) with the permission message', async () => {
    mockedSetFlakyStatus.mockRejectedValue(new APIError(403, 'nope', '/x'));
    const result = (await actions.setStatus(formEvent({ id: 'ft-1', status: 'ignored' }))) as any;
    expect(result.status).toBe(403);
    expect(result.data.message).toBe('You do not have permission to mute tests in this project.');
  });

  it('maps a 404 APIError to fail(404)', async () => {
    mockedSetFlakyStatus.mockRejectedValue(new APIError(404, 'not found', '/x'));
    const result = (await actions.setStatus(formEvent({ id: 'ft-1', status: 'ignored' }))) as any;
    expect(result.status).toBe(404);
  });

  it('maps any other APIError status to fail(502)', async () => {
    mockedSetFlakyStatus.mockRejectedValue(new APIError(500, 'boom', '/x'));
    const result = (await actions.setStatus(formEvent({ id: 'ft-1', status: 'ignored' }))) as any;
    expect(result.status).toBe(502);
  });

  it('maps a non-APIError failure to fail(502)', async () => {
    mockedSetFlakyStatus.mockRejectedValue(new Error('unexpected'));
    const result = (await actions.setStatus(formEvent({ id: 'ft-1', status: 'ignored' }))) as any;
    expect(result.status).toBe(502);
  });

  it('returns success on a clean update', async () => {
    mockedSetFlakyStatus.mockResolvedValue(undefined);
    const result = await actions.setStatus(formEvent({ id: 'ft-1', status: 'ignored' }));
    expect(result).toEqual({ success: true });
  });

  // Distinct, both non-null: an argument swap (createApi(clientIp, sessionToken))
  // compiles clean since both are `string | null` — only a call-site assertion
  // with two distinguishable values catches it.
  it('builds the client from the request session, not a swapped pair', async () => {
    mockedSetFlakyStatus.mockResolvedValue(undefined);
    await actions.setStatus(formEvent({ id: 'ft-1', status: 'ignored' }, 'sess-1', '203.0.113.7'));
    expect(createApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });
});
