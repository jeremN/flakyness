import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchMe } from './session';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchMe', () => {
  it('forwards the session cookie and returns the user + teams on success', async () => {
    const user = { id: 'u1', email: 'a@b.c', displayName: null, isGlobalAdmin: false, mustChangePassword: false };
    const teams = [{ id: 't1', name: 'Team A', role: 'member' as const }];
    fetchMock.mockResolvedValue(jsonResponse({ user, teams }));

    const result = await fetchMe('sess-abc', null);

    expect(result).toEqual({ user, teams });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/auth/me');
    expect(init.headers.Cookie).toBe('fk_session=sess-abc');
  });

  it('forwards the browser IP as X-Forwarded-For so the API keys per user', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: {}, teams: [] }));

    await fetchMe('sess-abc', '203.0.113.7');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['X-Forwarded-For']).toBe('203.0.113.7');
  });

  it('omits X-Forwarded-For entirely when there is no client IP', async () => {
    // An empty header is worse than none: getClientIp takes the first
    // comma-separated hop, so '' would key every such request to the same
    // empty-string bucket rather than falling back to the socket address.
    fetchMock.mockResolvedValue(jsonResponse({ user: {}, teams: [] }));

    await fetchMe('sess-abc', null);

    const [, init] = fetchMock.mock.calls[0];
    expect('X-Forwarded-For' in init.headers).toBe(false);
  });

  it('returns null (not a throw) on an invalid/expired session', async () => {
    // A well-formed JSON body on the 401, not plain text: if the `!res.ok`
    // check were dropped or flipped, res.json() would parse successfully and
    // return a truthy object instead of null, so this — unlike a non-JSON
    // body, which would fail to parse and land on null via the catch either
    // way — actually proves the status check runs.
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, 401));

    const result = await fetchMe('bad-token', null);

    expect(result).toBeNull();
  });

  it('returns null (not a throw) when the API is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const result = await fetchMe('sess-abc', null);

    expect(result).toBeNull();
  });

  // Pins the docstring's claim that a hung API can't hang every page load:
  // deleting `signal: AbortSignal.timeout(5000)` would leave `init.signal`
  // undefined and fail this. fetchMe runs on every request once Task 3
  // lands, so this is the one call in the dashboard where a missing timeout
  // matters most.
  it('bounds the request with an abort signal so a hung API cannot hang the page load', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: {}, teams: [] }));

    await fetchMe('sess-abc', null);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
