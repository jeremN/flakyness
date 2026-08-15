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
import { load, actions } from './+page.server';

const mockedListUsers = vi.fn();
const mockedCreateUser = vi.fn();
const mockedPatchUser = vi.fn();
const mockedResetUserPassword = vi.fn();
const mockedDeleteUser = vi.fn();

vi.mocked(createAdminApi).mockReturnValue({
  listUsers: mockedListUsers,
  createUser: mockedCreateUser,
  patchUser: mockedPatchUser,
  resetUserPassword: mockedResetUserPassword,
  deleteUser: mockedDeleteUser,
} as unknown as ReturnType<typeof createAdminApi>);

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'alice@x.test',
    displayName: 'Alice',
    isGlobalAdmin: false,
    mustChangePassword: false,
    createdAt: '2026-01-01T00:00:00Z',
    lastLoginAt: null,
    teams: [],
    ...overrides,
  };
}

function loadEvent(
  loadUser: { isGlobalAdmin: boolean } | null = { isGlobalAdmin: true },
  sessionToken: string | null = 'sess-1',
  clientIp: string | null = null
) {
  return { locals: { user: loadUser, sessionToken, clientIp } } as any;
}

function formEvent(
  fields: Record<string, string>,
  actingUser: { isGlobalAdmin: boolean } | null = { isGlobalAdmin: true },
  sessionToken: string | null = 'sess-1',
  clientIp: string | null = null
) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return {
    request: { formData: async () => fd },
    locals: { user: actingUser, sessionToken, clientIp },
  } as any;
}

beforeEach(() => {
  mockedListUsers.mockReset();
  mockedCreateUser.mockReset();
  mockedPatchUser.mockReset();
  mockedResetUserPassword.mockReset();
  mockedDeleteUser.mockReset();
  // Clears createAdminApi's own call history (mockReturnValue survives
  // mockClear) so an identity assertion below only sees this test's own call.
  vi.mocked(createAdminApi).mockClear();
});

describe('users load', () => {
  it('404s for a non-global-admin', async () => {
    await expect(load(loadEvent({ isGlobalAdmin: false }))).rejects.toMatchObject({ status: 404 });
    expect(mockedListUsers).not.toHaveBeenCalled();
  });

  it('404s for an anonymous caller', async () => {
    await expect(load(loadEvent(null))).rejects.toMatchObject({ status: 404 });
    expect(mockedListUsers).not.toHaveBeenCalled();
  });

  it('loads users for a global admin', async () => {
    mockedListUsers.mockResolvedValue({ users: [user()] });
    const result = await load(loadEvent());
    expect(result).toEqual({ users: [user()] });
  });

  // Distinct, both non-null: an argument swap (createAdminApi(clientIp,
  // sessionToken)) compiles clean since both are `string | null` — only a
  // call-site assertion with two distinguishable values catches it.
  it('builds the admin client from the session and client IP', async () => {
    mockedListUsers.mockResolvedValue({ users: [] });
    await load(loadEvent({ isGlobalAdmin: true }, 'sess-1', '203.0.113.7'));
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });

  it('maps an AdminApiError from listUsers to that status, not an unhandled 500', async () => {
    mockedListUsers.mockRejectedValue(new AdminApiError(503, 'API down'));
    await expect(load(loadEvent())).rejects.toMatchObject({ status: 503 });
  });

  it('falls back to a 502 for a raw network error from listUsers', async () => {
    mockedListUsers.mockRejectedValue(new TypeError('fetch failed'));
    await expect(load(loadEvent())).rejects.toMatchObject({ status: 502 });
  });
});

describe('create action', () => {
  it('creates a user and returns the show-once temporary password', async () => {
    mockedCreateUser.mockResolvedValue({
      user: user(),
      temporaryPassword: 'tmp_pw_1',
      warning: 'Save this password securely.',
    });
    const result = (await actions.create(
      formEvent({ email: 'new@x.test', displayName: 'New', isGlobalAdmin: 'on' })
    )) as any;
    expect(mockedCreateUser).toHaveBeenCalledWith({
      email: 'new@x.test',
      displayName: 'New',
      isGlobalAdmin: true,
    });
    expect(result).toEqual({ success: true, temporaryPassword: 'tmp_pw_1', warning: 'Save this password securely.' });
  });

  it('omits displayName and defaults isGlobalAdmin to false when neither is submitted', async () => {
    mockedCreateUser.mockResolvedValue({ user: user(), temporaryPassword: 'tmp', warning: 'w' });
    await actions.create(formEvent({ email: 'new@x.test' }));
    expect(mockedCreateUser).toHaveBeenCalledWith({ email: 'new@x.test', isGlobalAdmin: false });
  });

  it('rejects an empty email without calling the API', async () => {
    const result = (await actions.create(formEvent({ email: '   ' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedCreateUser).not.toHaveBeenCalled();
  });

  it('refuses for a non-global-admin without calling the API', async () => {
    const result = (await actions.create(formEvent({ email: 'new@x.test' }, { isGlobalAdmin: false }))) as any;
    expect(result.status).toBe(403);
    expect(mockedCreateUser).not.toHaveBeenCalled();
  });

  it('surfaces the API message on a 409 (duplicate email)', async () => {
    mockedCreateUser.mockRejectedValue(new AdminApiError(409, 'A user with this email already exists'));
    const result = (await actions.create(formEvent({ email: 'dup@x.test' }))) as any;
    expect(result.status).toBe(409);
    expect(result.data.error).toBe('A user with this email already exists');
  });

  it('maps a NotAuthenticatedError from the API to a 403 fail', async () => {
    mockedCreateUser.mockRejectedValue(new NotAuthenticatedError());
    const result = (await actions.create(formEvent({ email: 'new@x.test' }))) as any;
    expect(result.status).toBe(403);
  });

  // A raw network failure (e.g. `fetch` to a dead API) rejects with a plain
  // `TypeError`, not an `AdminApiError`/`NotAuthenticatedError` — proves it
  // degrades to an inline `fail(502, ...)` instead of a full-page 500.
  it('maps an unrecognized throw to a 502 fail instead of propagating it', async () => {
    mockedCreateUser.mockRejectedValue(new TypeError('fetch failed'));
    const result = (await actions.create(formEvent({ email: 'new@x.test' }))) as any;
    expect(result.status).toBe(502);
    expect(result.data.error).toBe('Unexpected error contacting the API.');
  });

  it('builds the admin client from the session and client IP', async () => {
    mockedCreateUser.mockResolvedValue({ user: user(), temporaryPassword: 'tmp', warning: 'w' });
    await actions.create(
      formEvent({ email: 'new@x.test' }, { isGlobalAdmin: true }, 'sess-1', '203.0.113.7')
    );
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });
});

describe('resetPassword action', () => {
  it('resets the password and returns the show-once value', async () => {
    mockedResetUserPassword.mockResolvedValue({
      temporaryPassword: 'tmp_pw_2',
      warning: "All of this user's sessions have been revoked.",
    });
    const result = (await actions.resetPassword(formEvent({ userId: 'u1' }))) as any;
    expect(mockedResetUserPassword).toHaveBeenCalledWith('u1');
    expect(result).toEqual({
      success: true,
      temporaryPassword: 'tmp_pw_2',
      warning: "All of this user's sessions have been revoked.",
    });
  });

  it('rejects a missing userId without calling the API', async () => {
    const result = (await actions.resetPassword(formEvent({}))) as any;
    expect(result.status).toBe(400);
    expect(mockedResetUserPassword).not.toHaveBeenCalled();
  });

  it('refuses for a non-global-admin without calling the API', async () => {
    const result = (await actions.resetPassword(formEvent({ userId: 'u1' }, { isGlobalAdmin: false }))) as any;
    expect(result.status).toBe(403);
    expect(mockedResetUserPassword).not.toHaveBeenCalled();
  });

  it('maps an unrecognized throw to a 502 fail instead of propagating it', async () => {
    mockedResetUserPassword.mockRejectedValue(new TypeError('fetch failed'));
    const result = (await actions.resetPassword(formEvent({ userId: 'u1' }))) as any;
    expect(result.status).toBe(502);
  });

  it('builds the admin client from the session and client IP', async () => {
    mockedResetUserPassword.mockResolvedValue({ temporaryPassword: 'tmp', warning: 'w' });
    await actions.resetPassword(formEvent({ userId: 'u1' }, { isGlobalAdmin: true }, 'sess-1', '203.0.113.7'));
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });
});

describe('toggleGlobalAdmin action', () => {
  it('promotes a user', async () => {
    mockedPatchUser.mockResolvedValue({ user: user({ isGlobalAdmin: true }) });
    const result = await actions.toggleGlobalAdmin(formEvent({ userId: 'u1', isGlobalAdmin: 'true' }));
    expect(mockedPatchUser).toHaveBeenCalledWith('u1', { isGlobalAdmin: true });
    expect(result).toEqual({ success: true });
  });

  it('demotes a user', async () => {
    mockedPatchUser.mockResolvedValue({ user: user({ isGlobalAdmin: false }) });
    await actions.toggleGlobalAdmin(formEvent({ userId: 'u1', isGlobalAdmin: 'false' }));
    expect(mockedPatchUser).toHaveBeenCalledWith('u1', { isGlobalAdmin: false });
  });

  // CRITICAL: the last-global-admin guard must reach the operator as a
  // readable inline message, not a generic failure — proves the API's exact
  // wording (admin-users.ts:270) survives `toFail` unmodified.
  it('surfaces the last-global-admin 409 message verbatim', async () => {
    mockedPatchUser.mockRejectedValue(new AdminApiError(409, 'Cannot demote the last global admin'));
    const result = (await actions.toggleGlobalAdmin(formEvent({ userId: 'u1', isGlobalAdmin: 'false' }))) as any;
    expect(result.status).toBe(409);
    expect(result.data.error).toBe('Cannot demote the last global admin');
  });

  it('rejects a missing userId without calling the API', async () => {
    const result = (await actions.toggleGlobalAdmin(formEvent({ isGlobalAdmin: 'true' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedPatchUser).not.toHaveBeenCalled();
  });

  it('refuses for a non-global-admin without calling the API', async () => {
    const result = (await actions.toggleGlobalAdmin(
      formEvent({ userId: 'u1', isGlobalAdmin: 'true' }, { isGlobalAdmin: false })
    )) as any;
    expect(result.status).toBe(403);
    expect(mockedPatchUser).not.toHaveBeenCalled();
  });

  it('builds the admin client from the session and client IP', async () => {
    mockedPatchUser.mockResolvedValue({ user: user() });
    await actions.toggleGlobalAdmin(
      formEvent({ userId: 'u1', isGlobalAdmin: 'true' }, { isGlobalAdmin: true }, 'sess-1', '203.0.113.7')
    );
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });
});

describe('delete action', () => {
  it('deletes a user', async () => {
    mockedDeleteUser.mockResolvedValue({ success: true });
    const result = await actions.delete(formEvent({ userId: 'u1' }));
    expect(mockedDeleteUser).toHaveBeenCalledWith('u1');
    expect(result).toEqual({ success: true });
  });

  // CRITICAL: same as toggleGlobalAdmin above, but for the delete path's
  // distinct 409 wording (admin-users.ts:360).
  it('surfaces the last-global-admin 409 message verbatim', async () => {
    mockedDeleteUser.mockRejectedValue(new AdminApiError(409, 'Cannot delete the last global admin'));
    const result = (await actions.delete(formEvent({ userId: 'u1' }))) as any;
    expect(result.status).toBe(409);
    expect(result.data.error).toBe('Cannot delete the last global admin');
  });

  it('rejects a missing userId without calling the API', async () => {
    const result = (await actions.delete(formEvent({}))) as any;
    expect(result.status).toBe(400);
    expect(mockedDeleteUser).not.toHaveBeenCalled();
  });

  it('refuses for a non-global-admin without calling the API', async () => {
    const result = (await actions.delete(formEvent({ userId: 'u1' }, { isGlobalAdmin: false }))) as any;
    expect(result.status).toBe(403);
    expect(mockedDeleteUser).not.toHaveBeenCalled();
  });

  it('builds the admin client from the session and client IP', async () => {
    mockedDeleteUser.mockResolvedValue({ success: true });
    await actions.delete(formEvent({ userId: 'u1' }, { isGlobalAdmin: true }, 'sess-1', '203.0.113.7'));
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });
});

describe('authorization', () => {
  // A hand-listed set of action names cannot see a NEWLY added action with no
  // guard — the new action contributes nothing to either side of a
  // hand-written comparison, so both stay equal and the test passes
  // regardless (the repo's own documented lesson from
  // password-change-coverage.test.ts, carried into admin/teams' own version
  // of this test). Iterating `Object.entries(actions)` instead sees every
  // CURRENTLY exported action, including one added after this test was
  // written. The `{ name, status }` object comparison (not a bare
  // `expect(r?.status).toBe(403)`) puts the offending action's name in the
  // failure message.
  it('every exported action refuses a non-global-admin', async () => {
    for (const [name, action] of Object.entries(actions)) {
      const r = (await (action as any)(formEvent({}, { isGlobalAdmin: false }))) as any;
      expect({ name, status: r?.status }).toEqual({ name, status: 403 });
    }
    expect(mockedCreateUser).not.toHaveBeenCalled();
    expect(mockedPatchUser).not.toHaveBeenCalled();
    expect(mockedResetUserPassword).not.toHaveBeenCalled();
    expect(mockedDeleteUser).not.toHaveBeenCalled();
  });
});
