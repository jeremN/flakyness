import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project } from '../app.d';

vi.mock('$lib/server/api', () => ({
  createApi: vi.fn(),
}));

import { createApi } from '$lib/server/api';
import { load } from './+layout.server';

const projectA: Project = { id: 'a', name: 'Project A', createdAt: '2024-01-01', teamId: null };
const projectB: Project = { id: 'b', name: 'Project B', createdAt: '2024-01-02', teamId: null };

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

function event(url: string) {
  return { url: new URL(url), locals: { sessionToken: null, clientIp: null } } as any;
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

    expect(result).toEqual({ projects: [], selectedProject: null, apiError: null });
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

    await load({ url: new URL('http://x/'), locals: { sessionToken: 'sess-1', clientIp: '203.0.113.7' } } as any);

    expect(createApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });
});
