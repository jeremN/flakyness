import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/adminApi', () => ({
  listProjects: vi.fn(),
  adminConfigured: vi.fn(),
  AdminApiError: class AdminApiError extends Error {
    statusCode: number;
    constructor(status: number, message: string) {
      super(message);
      this.statusCode = status;
    }
  },
}));

import { listProjects, adminConfigured } from '$lib/server/adminApi';
import { load } from './+page.server';

const mockedList = vi.mocked(listProjects);
const mockedConfigured = vi.mocked(adminConfigured);

beforeEach(() => {
  mockedList.mockReset();
  mockedConfigured.mockReset();
});

describe('routes/admin load', () => {
  it('returns adminEnabled=false and skips the fetch when ADMIN_TOKEN is unset', async () => {
    mockedConfigured.mockReturnValue(false);
    const result = (await load({} as any)) as any;
    expect(result).toEqual({ adminProjects: [], adminEnabled: false });
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('returns the project list when configured', async () => {
    mockedConfigured.mockReturnValue(true);
    const projects = [{ id: 'p1', name: 'A' }] as any;
    mockedList.mockResolvedValue({ projects });
    const result = (await load({} as any)) as any;
    expect(result).toEqual({ adminProjects: projects, adminEnabled: true });
  });

  it('surfaces an API failure as an HTTP error, preserving status and message', async () => {
    mockedConfigured.mockReturnValue(true);
    // 404 (not 502, the generic fallback) so a dropped `instanceof AdminApiError`
    // check — which would collapse `status` to the 502 fallback — fails this
    // assertion instead of surviving it. The message assertion similarly kills a
    // mutant that always uses the fallback 'Failed to load projects' string.
    mockedList.mockRejectedValue(
      new (await import('$lib/server/adminApi')).AdminApiError(404, 'boom')
    );
    await expect(load({} as any)).rejects.toMatchObject({
      status: 404,
      body: { message: 'boom' },
    });
  });
});
