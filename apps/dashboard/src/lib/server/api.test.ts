import { describe, it, expect, afterEach, vi } from 'vitest';
import { env as privateEnv } from '../../tests/env-private-stub';
import { createApi } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  // api.ts reads privateEnv.READ_TOKEN fresh on every call (not cached at
  // import time), so mutating the shared stub object here is enough — no
  // vi.resetModules() needed. But it must be cleaned up, or a READ_TOKEN set
  // by one test would leak into the next and break the `headers: {}`
  // assertions above.
  delete privateEnv.READ_TOKEN;
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

    const projects = await createApi(null, null).getProjects();

    expect(projects).toEqual([{ id: 'a', name: 'x', createdAt: '2024-01-01' }]);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8080/api/v1/projects', {
      headers: {},
    });
  });

  // Regression guard. This assertion used to demand `Authorization` be ABSENT
  // whenever a session was present, which pinned a real production defect: the
  // API's readAuth (middleware/auth.ts:192-229) has no session path, so with
  // READ_TOKEN set a cookie-only read 401s before team scoping ever runs, and
  // signing in made the dashboard strictly worse than staying anonymous.
  //
  // Sending both is the correct behaviour, not a compromise: the API's
  // precedence rule at middleware/access.ts:42-43 — "A user session outranks a
  // bearer token when both are present: the session is the more specific
  // credential, and the dashboard forwards both" — is what makes the session
  // win, so scoping is preserved. The bearer only satisfies the readAuth gate
  // in front of it. Reverting to `else if` must fail here.
  it("forwards BOTH the caller's session cookie and the READ_TOKEN bearer", async () => {
    privateEnv.READ_TOKEN = 'super-secret-read-token';
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ projects: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await createApi('sess-abc', null).getProjects();

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Cookie).toBe('fk_session=sess-abc');
    expect(init.headers.Authorization).toBe('Bearer super-secret-read-token');
  });

  // The same combination on the one WRITE that shares buildHeaders(). PATCH
  // /tests/flaky/:id is readAuth-mounted, so a cookie-only mute hits the exact
  // same 401 as a read; the mute test below covers the no-READ_TOKEN case.
  it('sends both credentials on setFlakyStatus too, since it shares buildHeaders', async () => {
    privateEnv.READ_TOKEN = 'super-secret-read-token';
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await createApi('sess-abc', null).setFlakyStatus('ft-1', 'ignored');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Cookie).toBe('fk_session=sess-abc');
    expect(init.headers.Authorization).toBe('Bearer super-secret-read-token');
  });

  // Delta 2026-08-15 (§D1.2): without these the dashboard puts every user in
  // one rate-limit bucket. Task 0 made the API able to trust the header; these
  // prove the dashboard actually sends it.
  it('forwards the browser IP as X-Forwarded-For so the API keys per user', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ projects: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await createApi('sess-abc', '203.0.113.7').getProjects();

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['X-Forwarded-For']).toBe('203.0.113.7');
  });

  it('omits X-Forwarded-For entirely when there is no client IP', async () => {
    // An empty header is worse than none: getClientIp takes the first
    // comma-separated hop, so '' would key every such request to the same
    // empty-string bucket rather than falling back to the socket address.
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ projects: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await createApi('sess-abc', null).getProjects();

    const [, init] = fetchMock.mock.calls[0];
    expect('X-Forwarded-For' in init.headers).toBe(false);
  });

  it('throws a kit HttpError with the upstream status on a non-OK response', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 404, statusText: 'Not Found' }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      await createApi(null, null).getProjects();
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
      await createApi(null, null).getProjects();
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
      await createApi(null, null).getProjects();
      throw new Error('expected getProjects to reject');
    } catch (err) {
      expect((err as { status: number }).status).toBe(503);
      expect((err as { body: { message: string } }).body.message).toContain('http://localhost:8080');
    }
  });

  it('sends READ_TOKEN as a Bearer credential when set and there is no session (proves the fallback is actually wired up)', async () => {
    privateEnv.READ_TOKEN = 'super-secret-read-token';
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ projects: [] }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await createApi(null, null).getProjects();

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8080/api/v1/projects', {
      headers: { Authorization: 'Bearer super-secret-read-token' },
    });
  });

  it('surfaces a configuration message, not a network message, on 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 }))
    );

    await expect(createApi(null, null).getProjects()).rejects.toMatchObject({
      status: 500,
      body: { message: expect.stringContaining('READ_TOKEN') },
    });

    vi.unstubAllGlobals();
  });

  it('getFlakyTests builds the URL with the given status', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ flakyTests: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await createApi(null, null).getFlakyTests('p1', 'resolved');

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/projects/p1/flaky-tests?status=resolved');
  });

  it('getProjectRuns builds the URL with the given limit', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ runs: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await createApi(null, null).getProjectRuns('p1', 7);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('?limit=7');
  });

  it('getRunDetail builds the URL from project id and run id, with no status param by default', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      new Response(JSON.stringify({ run: {}, results: [], truncated: false }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await createApi(null, null).getRunDetail('p1', 'r1');

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('http://localhost:8080/api/v1/projects/p1/runs/r1');
  });

  it('getRunDetail appends ?status= only when a status is passed', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      new Response(JSON.stringify({ run: {}, results: [], truncated: false }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await createApi(null, null).getRunDetail('p1', 'r1', 'all');

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('http://localhost:8080/api/v1/projects/p1/runs/r1?status=all');
  });

  it('getTestHistory encodes the test name exactly once', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await createApi(null, null).getTestHistory('loads 100% of items', 'p1');

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

    await createApi(null, null).getAnalysis('p1', 30, 0.1);

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

    await createApi(null, null).getAnalysis('p1');

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/projects/p1/analysis?days=14&threshold=0.05');
  });

  it('getFlakeTrend passes a null entry in `rates` straight through (no coercion to 0)', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      new Response(JSON.stringify({ days: ['Jul 12', 'Jul 13'], rates: [null, 1.2] }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createApi(null, null).getFlakeTrend('p1', 7);

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

    await createApi(null, null).getTestTrend('loads 100% of items', 'p1', 30);

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

    await createApi(null, null).getTestTrend('t', 'p1');

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('&days=30');
  });

  // `Authorization` is undefined here only because READ_TOKEN is unset in this
  // test (the afterEach clears it) — this asserts the client never invents an
  // ADMIN_TOKEN of its own, NOT that a bearer is never sent. When READ_TOKEN is
  // set one IS sent; that is the `setFlakyStatus` test near the top of the file.
  it('sends the mute as a PATCH carrying the session cookie, never an ADMIN_TOKEN', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await createApi('sess-abc', '203.0.113.7').setFlakyStatus('ft-1', 'ignored');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/tests/flaky/ft-1');
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ status: 'ignored' }));
    expect(init.headers.Cookie).toBe('fk_session=sess-abc');
    expect(init.headers['X-Forwarded-For']).toBe('203.0.113.7');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('surfaces a mute rejection as an APIError carrying the status', async () => {
    // The action maps this to fail(); it must NOT become a thrown error page,
    // which would replace the form with a 500 screen instead of an inline message.
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createApi('s', null).setFlakyStatus('ft-1', 'ignored')).rejects.toMatchObject({
      name: 'APIError',
      statusCode: 403,
    });
  });
});
