import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { SESSION_COOKIE, SESSION_SLIDE_AFTER_MS, sessionExpiry } from '../services/auth/session';

// This suite mocks the database rather than hitting a real Postgres (unlike
// the rest of the API test suite -- see AGENTS.md). That's deliberate here:
// the two catch branches added to sessionAuth() (the best-effort reap DELETE
// and slide UPDATE) can only be exercised by making a DB call reject
// mid-request, which a route test driven from the outside cannot do. Every
// other branch (no cookie / unknown cookie / expired / valid / slid) is ALSO
// covered end-to-end against real Postgres in Task 6's routes/auth.test.ts;
// this file exists specifically to reach what that suite structurally can't.
const { selectMock, deleteMock, updateMock, eqSpy } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  deleteMock: vi.fn(),
  updateMock: vi.fn(),
  eqSpy: vi.fn(),
}));

const { sessionsTable, usersTable } = vi.hoisted(() => ({
  sessionsTable: {
    id: 'sessions.id',
    tokenHash: 'sessions.token_hash',
    userId: 'sessions.user_id',
    expiresAt: 'sessions.expires_at',
    lastSeenAt: 'sessions.last_seen_at',
  },
  usersTable: {
    id: 'users.id',
    email: 'users.email',
    displayName: 'users.display_name',
    isGlobalAdmin: 'users.is_global_admin',
    mustChangePassword: 'users.must_change_password',
  },
}));

const { loggerWarnMock } = vi.hoisted(() => ({ loggerWarnMock: vi.fn() }));

vi.mock('../db', () => ({
  db: { select: selectMock, delete: deleteMock, update: updateMock },
  sessions: sessionsTable,
  users: usersTable,
}));

vi.mock('./logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: loggerWarnMock, error: vi.fn() },
}));

// Real `eq` still runs (so the query-builder plumbing behaves exactly as in
// production); it's wrapped only so tests can assert WHICH column/value pair
// a where-clause targeted, e.g. that the reap DELETE hits the row that was
// actually looked up, not some other id.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (...args: Parameters<typeof actual.eq>) => {
      eqSpy(...args);
      return actual.eq(...args);
    },
  };
});

// eslint-disable-next-line import/order -- must follow the vi.mock calls above
import { sessionAuth, getSessionUser } from './session';

/**
 * Fakes Drizzle's chainable query builder. Every intermediate method (from,
 * innerJoin, where, limit, set) returns the same object, and that object IS
 * the promise the production code eventually `await`s -- matching how real
 * Drizzle query builders work (each step is itself awaitable, regardless of
 * how many more chain calls follow it).
 */
function chain<T>(promise: Promise<T>) {
  const obj = promise as Promise<T> & Record<string, (...args: unknown[]) => unknown>;
  for (const method of ['from', 'innerJoin', 'where', 'limit', 'set']) {
    obj[method] = vi.fn(() => obj);
  }
  // A rejected chain is only awaited by production code a few synchronous
  // chain-calls later; pre-attach a silent handler so Node's unhandled-
  // rejection detector doesn't fire before that real `await` runs.
  promise.catch(() => {});
  return obj;
}

interface FakeRow {
  sessionId: string;
  expiresAt: Date;
  lastSeenAt: Date;
  id: string;
  email: string;
  displayName: string | null;
  isGlobalAdmin: boolean;
  mustChangePassword: boolean;
}

function buildApp() {
  const app = new Hono();
  app.use('*', sessionAuth());
  app.get('/', (c) => c.json({ user: getSessionUser(c) }));
  return app;
}

beforeEach(() => {
  selectMock.mockReset();
  deleteMock.mockReset();
  updateMock.mockReset();
  eqSpy.mockClear();
  loggerWarnMock.mockReset();
});

describe('sessionAuth() - no or unknown cookie', () => {
  it('no cookie -> anonymous, next() still runs, no DB call', async () => {
    const app = buildApp();
    const res = await app.request('/');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('cookie present but no matching row -> anonymous, next() still runs', async () => {
    selectMock.mockReturnValue(chain(Promise.resolve([])));
    const app = buildApp();

    const res = await app.request('/', { headers: { Cookie: `${SESSION_COOKIE}=unknown-token` } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
    expect(deleteMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('sessionAuth() - valid session', () => {
  it('populates sessionUser with all six fields', async () => {
    const row: FakeRow = {
      sessionId: 'sess-live',
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(Date.now() - 1_000), // well inside the slide threshold
      id: 'user-1',
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
      isGlobalAdmin: true,
      mustChangePassword: false,
    };
    selectMock.mockReturnValue(chain(Promise.resolve([row])));
    const app = buildApp();

    const res = await app.request('/', { headers: { Cookie: `${SESSION_COOKIE}=live-token` } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: {
        id: 'user-1',
        email: 'ada@example.com',
        displayName: 'Ada Lovelace',
        isGlobalAdmin: true,
        mustChangePassword: false,
        sessionId: 'sess-live',
      },
    });
  });
});

describe('sessionAuth() - expired session', () => {
  it('deletes the right row, then falls through anonymous, still calling next()', async () => {
    const row: FakeRow = {
      sessionId: 'sess-expired',
      expiresAt: new Date(Date.now() - 1_000), // in the past: dead
      lastSeenAt: new Date(Date.now() - 1_000),
      id: 'user-1',
      email: 'ada@example.com',
      displayName: null,
      isGlobalAdmin: false,
      mustChangePassword: false,
    };
    selectMock.mockReturnValue(chain(Promise.resolve([row])));
    deleteMock.mockReturnValue(chain(Promise.resolve(undefined)));
    const app = buildApp();

    const res = await app.request('/', { headers: { Cookie: `${SESSION_COOKIE}=expired-token` } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
    expect(deleteMock).toHaveBeenCalledTimes(1);
    // Proves the DELETE targeted THIS session's row, not e.g. the user id.
    expect(eqSpy).toHaveBeenCalledWith(sessionsTable.id, 'sess-expired');
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('sessionAuth() - sliding TTL', () => {
  it('past the slide threshold -> UPDATE writes fresh lastSeenAt AND expiresAt', async () => {
    const staleLastSeenAt = new Date(Date.now() - SESSION_SLIDE_AFTER_MS - 1_000);
    const staleExpiresAt = new Date(Date.now() + 60_000);
    const row: FakeRow = {
      sessionId: 'sess-slide',
      expiresAt: staleExpiresAt,
      lastSeenAt: staleLastSeenAt,
      id: 'user-1',
      email: 'ada@example.com',
      displayName: null,
      isGlobalAdmin: false,
      mustChangePassword: false,
    };
    selectMock.mockReturnValue(chain(Promise.resolve([row])));
    updateMock.mockReturnValue(chain(Promise.resolve(undefined)));
    const app = buildApp();
    const before = Date.now();

    const res = await app.request('/', { headers: { Cookie: `${SESSION_COOKIE}=slide-token` } });

    const after = Date.now();
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(eqSpy).toHaveBeenCalledWith(sessionsTable.id, 'sess-slide');

    const updateChain = updateMock.mock.results[0]!.value as ReturnType<typeof chain>;
    expect(updateChain.set).toHaveBeenCalledTimes(1);
    const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      lastSeenAt: Date;
      expiresAt: Date;
    };

    // Both fields written, with real "now" values -- not the stale ones read
    // from the row. A test that only checked `set` was called would stay
    // green even if the expiresAt write were deleted from the middleware;
    // pinning both values here is what makes that mutation visible.
    expect(setArg.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(setArg.lastSeenAt.getTime()).toBeLessThanOrEqual(after);
    expect(setArg.lastSeenAt.getTime()).toBeGreaterThan(staleLastSeenAt.getTime());
    expect(setArg.expiresAt).toEqual(sessionExpiry(setArg.lastSeenAt));
    expect(setArg.expiresAt.getTime()).toBeGreaterThan(staleExpiresAt.getTime());
  });

  it('inside the slide threshold -> no UPDATE issued', async () => {
    const row: FakeRow = {
      sessionId: 'sess-fresh',
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(Date.now() - 1_000), // well inside the threshold
      id: 'user-1',
      email: 'ada@example.com',
      displayName: null,
      isGlobalAdmin: false,
      mustChangePassword: false,
    };
    selectMock.mockReturnValue(chain(Promise.resolve([row])));
    const app = buildApp();

    const res = await app.request('/', { headers: { Cookie: `${SESSION_COOKIE}=fresh-token` } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: {
        id: 'user-1',
        email: 'ada@example.com',
        displayName: null,
        isGlobalAdmin: false,
        mustChangePassword: false,
        sessionId: 'sess-fresh',
      },
    });
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('sessionAuth() - best-effort writes swallow their own failures', () => {
  it('reap DELETE rejects -> request still succeeds anonymously, warns with sessionId only', async () => {
    const row: FakeRow = {
      sessionId: 'sess-reap-fail',
      expiresAt: new Date(Date.now() - 1_000),
      lastSeenAt: new Date(Date.now() - 1_000),
      id: 'user-1',
      email: 'ada@example.com',
      displayName: null,
      isGlobalAdmin: false,
      mustChangePassword: false,
    };
    selectMock.mockReturnValue(chain(Promise.resolve([row])));
    deleteMock.mockReturnValue(chain(Promise.reject(new Error('connection reset'))));
    const app = buildApp();

    const res = await app.request('/', { headers: { Cookie: `${SESSION_COOKIE}=reap-fail-token` } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'Failed to reap expired session',
      expect.objectContaining({ sessionId: 'sess-reap-fail' })
    );
    // Never the token or a raw Error object -- only the safe name/message shape.
    const [, extra] = loggerWarnMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(JSON.stringify(extra)).not.toContain('reap-fail-token');
  });

  it('slide UPDATE rejects -> request still succeeds AUTHENTICATED, warns with sessionId only', async () => {
    const row: FakeRow = {
      sessionId: 'sess-slide-fail',
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(Date.now() - SESSION_SLIDE_AFTER_MS - 1_000),
      id: 'user-1',
      email: 'ada@example.com',
      displayName: 'Ada',
      isGlobalAdmin: true,
      mustChangePassword: true,
    };
    selectMock.mockReturnValue(chain(Promise.resolve([row])));
    updateMock.mockReturnValue(chain(Promise.reject(new Error('connection reset'))));
    const app = buildApp();

    const res = await app.request('/', { headers: { Cookie: `${SESSION_COOKIE}=slide-fail-token` } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: {
        id: 'user-1',
        email: 'ada@example.com',
        displayName: 'Ada',
        isGlobalAdmin: true,
        mustChangePassword: true,
        sessionId: 'sess-slide-fail',
      },
    });
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'Failed to slide session TTL',
      expect.objectContaining({ sessionId: 'sess-slide-fail' })
    );
  });
});

describe('sessionAuth() - the one unguarded call', () => {
  it('SELECT rejects -> the middleware itself rejects, is not swallowed to anonymous', async () => {
    selectMock.mockReturnValue(chain(Promise.reject(new Error('connection refused'))));
    const app = buildApp();

    const res = await app.request('/', { headers: { Cookie: `${SESSION_COOKIE}=any-token` } });

    // Hono's default error handler turns an uncaught middleware rejection
    // into a 500. That's the observable proof the SELECT's failure
    // propagated instead of being swallowed -- a swallowed failure would
    // instead read 200 with an anonymous `{ user: null }` body, same as the
    // "unknown cookie" case above.
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Internal Server Error');
    expect(deleteMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });
});
