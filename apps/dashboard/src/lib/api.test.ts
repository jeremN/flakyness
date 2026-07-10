import { describe, it, expect, afterEach, vi } from 'vitest';
import { APIError, getProjects, getFlakyTests, getProjectRuns, getTestHistory } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lib/api', () => {
  it('getProjects fetches and unwraps the projects array', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ projects: [{ id: 'a', name: 'x', createdAt: '2024-01-01' }] }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const projects = await getProjects();

    expect(projects).toEqual([{ id: 'a', name: 'x', createdAt: '2024-01-01' }]);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8080/api/v1/projects');
  });

  it('rejects with an APIError on a non-OK response', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 404, statusText: 'Not Found' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getProjects()).rejects.toMatchObject({
      statusCode: 404,
      endpoint: '/api/v1/projects',
    });

    try {
      await getProjects();
      throw new Error('expected getProjects to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(APIError);
      expect((error as APIError).message).toContain('boom');
    }
  });

  it('rejects with an APIError on a network failure', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getProjects()).rejects.toMatchObject({
      statusCode: 0,
    });

    try {
      await getProjects();
      throw new Error('expected getProjects to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(APIError);
      expect((error as APIError).message.startsWith('Failed to connect to API')).toBe(true);
    }
  });

  it('getFlakyTests builds the URL with the given status', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ flakyTests: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await getFlakyTests('p1', 'resolved');

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/projects/p1/flaky-tests?status=resolved');
  });

  it('getProjectRuns builds the URL with the given limit', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ runs: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await getProjectRuns('p1', 7);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('?limit=7');
  });

  it('getTestHistory encodes the test name exactly once', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await getTestHistory('loads 100% of items', 'p1');

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('loads%20100%25%20of%20items');
  });
});
