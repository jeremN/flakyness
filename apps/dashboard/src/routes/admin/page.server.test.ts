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
import { load } from './+page.server';

const mockedList = vi.fn();
vi.mocked(createAdminApi).mockReturnValue({ listProjects: mockedList } as unknown as ReturnType<typeof createAdminApi>);

beforeEach(() => {
  mockedList.mockReset();
});

function event(sessionToken: string | null, clientIp: string | null = null) {
  return { locals: { sessionToken, clientIp } } as any;
}

describe('routes/admin load', () => {
  it('maps NotAuthenticatedError to adminEnabled=false, without surfacing an error', async () => {
    mockedList.mockRejectedValue(new NotAuthenticatedError());
    const result = (await load(event(null))) as any;
    expect(result).toEqual({ adminProjects: [], adminEnabled: false });
  });

  it('returns the project list when signed in', async () => {
    const projects = [{ id: 'p1', name: 'A' }] as any;
    mockedList.mockResolvedValue({ projects });
    const result = (await load(event('sess-1'))) as any;
    expect(result).toEqual({ adminProjects: projects, adminEnabled: true });
  });

  // Distinct, both non-null: an argument swap (createAdminApi(clientIp,
  // sessionToken)) compiles clean since both are `string | null` — only a
  // call-site assertion with two distinguishable values catches it.
  it('builds the admin client from the request session, not a swapped pair', async () => {
    mockedList.mockResolvedValue({ projects: [] });
    await load(event('sess-1', '203.0.113.7'));
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });

  it('surfaces an API failure as an HTTP error, preserving status and message', async () => {
    // 404 (not 502, the generic fallback) so a dropped `instanceof AdminApiError`
    // check — which would collapse `status` to the 502 fallback — fails this
    // assertion instead of surviving it. The message assertion similarly kills a
    // mutant that always uses the fallback 'Failed to load projects' string.
    mockedList.mockRejectedValue(new AdminApiError(404, 'boom'));
    await expect(load(event('sess-1'))).rejects.toMatchObject({
      status: 404,
      body: { message: 'boom' },
    });
  });
});
