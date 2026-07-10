import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project } from '../app.d';

vi.mock('$lib/api', () => ({
  getProjects: vi.fn(),
}));

import { getProjects } from '$lib/api';
import { load } from './+layout.server';

const projectA: Project = { id: 'a', name: 'Project A', createdAt: '2024-01-01' };
const projectB: Project = { id: 'b', name: 'Project B', createdAt: '2024-01-02' };

const mockedGetProjects = vi.mocked(getProjects);

beforeEach(() => {
  mockedGetProjects.mockReset();
});

describe('routes/+layout.server load', () => {
  it('selects the project matching the ?project= query param', async () => {
    mockedGetProjects.mockResolvedValue([projectA, projectB]);

    const event = { url: new URL('http://x/?project=b') } as any;
    const result = await load(event);

    expect(result.selectedProject?.id).toBe('b');
  });

  it('falls back to the first project when no query param is given', async () => {
    mockedGetProjects.mockResolvedValue([projectA, projectB]);

    const event = { url: new URL('http://x/') } as any;
    const result = await load(event);

    expect(result.selectedProject?.id).toBe('a');
  });

  it('falls back to the first project when the query param id is unknown', async () => {
    mockedGetProjects.mockResolvedValue([projectA, projectB]);

    const event = { url: new URL('http://x/?project=unknown') } as any;
    const result = await load(event);

    expect(result.selectedProject?.id).toBe('a');
  });

  it('returns an empty project list and a null selectedProject when there are no projects', async () => {
    mockedGetProjects.mockResolvedValue([]);

    const event = { url: new URL('http://x/') } as any;
    const result = await load(event);

    expect(result).toEqual({ projects: [], selectedProject: null });
  });

  it('characterization: propagates a rejection from getProjects (no error handling today)', async () => {
    mockedGetProjects.mockRejectedValue(new Error('api down'));

    const event = { url: new URL('http://x/') } as any;

    await expect(load(event)).rejects.toThrow('api down');
  });
});
