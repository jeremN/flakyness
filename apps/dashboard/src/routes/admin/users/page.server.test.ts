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

  // M-2: the client's hidden field only ever sends 'true'/'false' — this is
  // the privilege-flag field, so a hand-crafted request sending anything else
  // must be refused rather than silently treated as "not true" ⇒ demote
  // (mirrors admin/teams' setRole rejecting an invalid `role`).
  it('rejects an invalid isGlobalAdmin value without calling the API', async () => {
    const result = (await actions.toggleGlobalAdmin(formEvent({ userId: 'u1', isGlobalAdmin: 'maybe' }))) as any;
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
  // Fix round 1 (findings-r1, "Also fix"): the delete confirmation is now
  // server-side, mirroring admin/teams' delete — re-fetch the authoritative
  // email via listUsers() and compare there, rather than trusting a
  // client-submitted "expected" value. Before this, the most destructive
  // action on this page was guarded by nothing but `isGlobalAdmin` — the
  // same single guard as the fully-reversible `toggleGlobalAdmin` — and the
  // API's 409 only refuses the *last* global admin, so deleting the
  // second-to-last, or any team_admin, was otherwise ungated.
  it('rejects when the typed email does not match', async () => {
    mockedListUsers.mockResolvedValue({ users: [user({ email: 'alice@x.test' })] });
    const result = (await actions.delete(formEvent({ userId: 'u1', confirmEmail: 'wrong@x.test' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedDeleteUser).not.toHaveBeenCalled();
  });

  it('compares the typed email against the freshly-fetched server email, not a submitted one', async () => {
    mockedListUsers.mockResolvedValue({ users: [user({ email: 'real@x.test' })] });

    // A forged `expectedEmail` field must not be able to substitute for the
    // live `listUsers()` read — the action has never read that field, but
    // submitting it alongside a matching `confirmEmail` is exactly the shape
    // a naive "compare against a submitted expected value" implementation
    // would accept. Without this field present, a mutant that reads
    // `form.get('expectedEmail') ?? user.email` instead of `user.email`
    // behaves identically to the real code under this test (both fall back
    // to `user.email` when the field is absent) and survives undetected —
    // this is the exact gap 7a's own review found missing on its first pass.
    const stale = (await actions.delete(
      formEvent({ userId: 'u1', confirmEmail: 'stale@x.test', expectedEmail: 'stale@x.test' })
    )) as any;
    expect(stale.status).toBe(400);
    expect(mockedDeleteUser).not.toHaveBeenCalled();

    mockedDeleteUser.mockResolvedValue({ success: true });
    const ok = await actions.delete(formEvent({ userId: 'u1', confirmEmail: 'real@x.test' }));
    expect(mockedDeleteUser).toHaveBeenCalledWith('u1');
    expect(ok).toEqual({ success: true });
  });

  it('404s when the user is not found', async () => {
    mockedListUsers.mockResolvedValue({ users: [] });
    const result = (await actions.delete(formEvent({ userId: 'missing', confirmEmail: 'x' }))) as any;
    expect(result.status).toBe(404);
    expect(mockedDeleteUser).not.toHaveBeenCalled();
  });

  // The pre-check listUsers() call (fetching the authoritative email to
  // compare against) is the most reachable of delete's unhandled-error
  // sites — no outage needed, just an expired session or a 429 while an
  // operator is on the confirm form — and without its own try/catch it would
  // leak even a *handled* AdminApiError as a full-page 500 (same class of
  // gap as admin/teams' delete pre-check).
  it('surfaces an AdminApiError from the pre-check listUsers() as an inline fail, not a throw', async () => {
    mockedListUsers.mockRejectedValue(new AdminApiError(429, 'Too many requests'));
    const result = (await actions.delete(formEvent({ userId: 'u1', confirmEmail: 'x' }))) as any;
    expect(result.status).toBe(429);
    expect(result.data.error).toBe('Too many requests');
    expect(mockedDeleteUser).not.toHaveBeenCalled();
  });

  it('deletes a user once the typed email matches', async () => {
    mockedListUsers.mockResolvedValue({ users: [user({ email: 'alice@x.test' })] });
    mockedDeleteUser.mockResolvedValue({ success: true });
    const result = await actions.delete(formEvent({ userId: 'u1', confirmEmail: 'alice@x.test' }));
    expect(mockedDeleteUser).toHaveBeenCalledWith('u1');
    expect(result).toEqual({ success: true });
  });

  // CRITICAL: same as toggleGlobalAdmin above, but for the delete path's
  // distinct 409 wording (admin-users.ts:360).
  it('surfaces the last-global-admin 409 message verbatim', async () => {
    mockedListUsers.mockResolvedValue({ users: [user({ email: 'alice@x.test' })] });
    mockedDeleteUser.mockRejectedValue(new AdminApiError(409, 'Cannot delete the last global admin'));
    const result = (await actions.delete(formEvent({ userId: 'u1', confirmEmail: 'alice@x.test' }))) as any;
    expect(result.status).toBe(409);
    expect(result.data.error).toBe('Cannot delete the last global admin');
  });

  it('rejects a missing userId without calling the API', async () => {
    const result = (await actions.delete(formEvent({}))) as any;
    expect(result.status).toBe(400);
    expect(mockedListUsers).not.toHaveBeenCalled();
    expect(mockedDeleteUser).not.toHaveBeenCalled();
  });

  it('refuses for a non-global-admin without calling the API', async () => {
    const result = (await actions.delete(
      formEvent({ userId: 'u1', confirmEmail: 'x' }, { isGlobalAdmin: false })
    )) as any;
    expect(result.status).toBe(403);
    expect(mockedListUsers).not.toHaveBeenCalled();
    expect(mockedDeleteUser).not.toHaveBeenCalled();
  });

  it('builds the admin client from the session and client IP', async () => {
    mockedListUsers.mockResolvedValue({ users: [user({ email: 'alice@x.test' })] });
    mockedDeleteUser.mockResolvedValue({ success: true });
    await actions.delete(
      formEvent({ userId: 'u1', confirmEmail: 'alice@x.test' }, { isGlobalAdmin: true }, 'sess-1', '203.0.113.7')
    );
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
    expect(mockedListUsers).not.toHaveBeenCalled();
  });
});

// findings-r1, IMPORTANT #1: no `fail()` in this file carries a credential
// today, but nothing STOPPED one from doing so — proven by the reviewer
// adding `temporaryPassword` to `toFail`'s 502 fallback (450/450 still
// passed) and then to all 11 `fail()` sites simultaneously (450/450 still
// passed). Every 403/400 assertion above checks only `result.status`; every
// 409/502 assertion checks only `result.data.error`. Extra keys were
// invisible to all of them — and a `fail()` payload is serialized into the
// page's `__sveltekit_data` and reaches the browser DOM, where `TokenReveal`
// is gated on `form.success`, so a smuggled password would ship to the
// client WITHOUT ever being visibly rendered.
//
// This guards it two ways, matching the two reproduction mutations above:
//
// 1. A fully DERIVED loop over `Object.entries(actions)` for the two
//    branches every action reaches with NO action-specific knowledge — the
//    auth guard (empty fields, non-admin) and the first field-validation
//    check (empty fields, admin). A fifth action added later, with its own
//    guard/validation fail(), is covered automatically without this file
//    being touched — the same property that makes the authorization test
//    above robust to a newly added action, applied to payload SHAPE instead
//    of status.
// 2. A small per-action fixture map (`TOFAIL_FIXTURES`) for the
//    `toFail`-routed branches (AdminApiError → its own status; an
//    unrecognized throw → 502), which unavoidably needs to know each
//    action's minimal valid fields and which mock to reject — the same
//    narrow, per-call-site knowledge the identity assertions elsewhere in
//    this file already require. `toFail` is shared code, so exercising it
//    via any action proves its 3 fail() sites; this exercises it via all
//    four.
//
//    Tier 2 is HAND-MAINTAINED and does NOT auto-extend the way tier 1 does
//    (findings-r2, proven by two executed escapes): a fifth action, added
//    with its own leaking `fail()` in a catch block not routed through
//    `toFail`, passed 54/54 with the leak uncaught, because it has no entry
//    here; the completeness check right below turns THAT specific escape
//    loud (a missing/extra key in `TOFAIL_FIXTURES` now fails by name,
//    mirroring `routes-auth-coverage.test.ts` and
//    `password-change-coverage.test.ts`'s hard-coded counts that "you must
//    bump deliberately"). It does NOT close a narrower escape: a NEW
//    `fail()` branch added inside an EXISTING, already-fixtured action,
//    reachable only via a field `validFields()` doesn't supply, also passed
//    52/52 uncaught — that is genuinely hard to catch generically, and nothing
//    below closes it. Covering such a branch costs a deliberate edit to that
//    action's `validFields()` (or a dedicated test), same as everywhere else
//    in this file.
describe('fail() payloads never carry an extra field (findings-r1 I-1)', () => {
  function assertOnlyErrorKey(result: any) {
    expect(result).toBeTruthy();
    expect(Object.keys(result.data ?? {})).toEqual(['error']);
  }

  for (const [name, action] of Object.entries(actions)) {
    it(`${name}: the auth-guard fail() carries only { error }`, async () => {
      const r = await (action as any)(formEvent({}, { isGlobalAdmin: false }));
      assertOnlyErrorKey(r);
    });

    it(`${name}: a validation fail() carries only { error }`, async () => {
      const r = await (action as any)(formEvent({})); // admin, but missing required fields
      assertOnlyErrorKey(r);
    });
  }

  const TOFAIL_FIXTURES: Record<string, { validFields: () => Record<string, string>; primaryMock: ReturnType<typeof vi.fn> }> = {
    create: { validFields: () => ({ email: 'probe@x.test' }), primaryMock: mockedCreateUser },
    resetPassword: { validFields: () => ({ userId: 'u1' }), primaryMock: mockedResetUserPassword },
    toggleGlobalAdmin: {
      validFields: () => ({ userId: 'u1', isGlobalAdmin: 'true' }),
      primaryMock: mockedPatchUser,
    },
    delete: {
      validFields: () => ({ userId: 'u1', confirmEmail: 'alice@x.test' }),
      primaryMock: mockedDeleteUser,
    },
  };

  // findings-r2 (a): closes the bigger of the two escapes — a NEW action can
  // no longer be added without a matching `TOFAIL_FIXTURES` entry, or this
  // fails and names the missing key. Derived from `actions`, the same move
  // as tier 1 and the derived authorization test above. It does NOT close
  // the narrower escape (a new fail() branch inside an EXISTING, already-
  // fixtured action) — see the block comment above this describe.
  it('TOFAIL_FIXTURES covers every exported action', () => {
    expect(Object.keys(TOFAIL_FIXTURES).sort()).toEqual(Object.keys(actions).sort());
  });

  for (const [name, fixture] of Object.entries(TOFAIL_FIXTURES)) {
    const action = (actions as any)[name];

    it(`${name}: toFail's AdminApiError branch carries only { error }`, async () => {
      if (name === 'delete') mockedListUsers.mockResolvedValue({ users: [user({ email: 'alice@x.test' })] });
      fixture.primaryMock.mockRejectedValue(new AdminApiError(409, 'conflict'));
      const r = await action(formEvent(fixture.validFields()));
      assertOnlyErrorKey(r);
    });

    it(`${name}: toFail's unrecognized-throw (502) branch carries only { error }`, async () => {
      if (name === 'delete') mockedListUsers.mockResolvedValue({ users: [user({ email: 'alice@x.test' })] });
      fixture.primaryMock.mockRejectedValue(new TypeError('fetch failed'));
      const r = await action(formEvent(fixture.validFields()));
      assertOnlyErrorKey(r);
    });
  }
});
