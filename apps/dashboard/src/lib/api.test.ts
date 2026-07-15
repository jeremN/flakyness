import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getProjects,
  getFlakyTests,
  getProjectRuns,
  getRunDetail,
  getTestHistory,
  getTestTrend,
  getFlakeTrend,
  getAnalysis,
} from './api';

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

  it('throws a kit HttpError with the upstream status on a non-OK response', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 404, statusText: 'Not Found' }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      await getProjects();
      throw new Error('expected getProjects to reject');
    } catch (err) {
      expect((err as { status: number }).status).toBe(404);
      expect((err as { body: { message: string } }).body.message).toContain('/api/v1/projects');
    }
  });

  it('maps a 5xx upstream response to a 502 HttpError', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      await getProjects();
      throw new Error('expected getProjects to reject');
    } catch (err) {
      expect((err as { status: number }).status).toBe(502);
      expect((err as { body: { message: string } }).body.message).toContain('/api/v1/projects');
    }
  });

  it('throws a 503 HttpError on a network failure', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await getProjects();
      throw new Error('expected getProjects to reject');
    } catch (err) {
      expect((err as { status: number }).status).toBe(503);
      expect((err as { body: { message: string } }).body.message).toContain('http://localhost:8080');
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

  it('getRunDetail builds the URL from project id and run id, with no status param by default', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      new Response(JSON.stringify({ run: {}, results: [], truncated: false }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await getRunDetail('p1', 'r1');

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('http://localhost:8080/api/v1/projects/p1/runs/r1');
  });

  it('getRunDetail appends ?status= only when a status is passed', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      new Response(JSON.stringify({ run: {}, results: [], truncated: false }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await getRunDetail('p1', 'r1', 'all');

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('http://localhost:8080/api/v1/projects/p1/runs/r1?status=all');
  });

  it('getTestHistory encodes the test name exactly once', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await getTestHistory('loads 100% of items', 'p1');

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('loads%20100%25%20of%20items');
  });

  it('getAnalysis builds the URL with the given days and threshold, and defaults', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      new Response(
        JSON.stringify({ windowDays: 14, threshold: 0.05, flakyTests: [], allTests: [] }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await getAnalysis('p1', 30, 0.1);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/projects/p1/analysis?days=30&threshold=0.1');
  });

  it('getAnalysis defaults to 14 days and 0.05 threshold', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      new Response(
        JSON.stringify({ windowDays: 14, threshold: 0.05, flakyTests: [], allTests: [] }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await getAnalysis('p1');

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/projects/p1/analysis?days=14&threshold=0.05');
  });

  it('getFlakeTrend passes a null entry in `rates` straight through (no coercion to 0)', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      new Response(JSON.stringify({ days: ['Jul 12', 'Jul 13'], rates: [null, 1.2] }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getFlakeTrend('p1', 7);

    // Explicit === null: a fetcher that JSON.parse'd `null` into `0` (or a
    // type cast that silently widened it) would pass a `toEqual` check with
    // loose equality but fail this one.
    expect(result.rates[0] === null).toBe(true);
    expect(result.rates[1]).toBe(1.2);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/projects/p1/trend?days=7');
  });

  it('getTestTrend encodes the test name and builds the URL with project and days', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      new Response(
        JSON.stringify({
          testName: 'loads 100% of items',
          projectId: 'p1',
          days: 30,
          direction: 'stable',
          trend: [],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await getTestTrend('loads 100% of items', 'p1', 30);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/tests/loads%20100%25%20of%20items/trend?project=p1&days=30');
  });

  it('getTestTrend defaults to a 30-day window', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      new Response(
        JSON.stringify({ testName: 't', projectId: 'p1', days: 30, direction: 'stable', trend: [] }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await getTestTrend('t', 'p1');

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('&days=30');
  });
});
