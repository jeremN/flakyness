import { describe, it, expect } from 'vitest';
import {
  anonymousAccess,
  canReadProject,
  canWriteProject,
  canAdministerTeams,
  canEnterAdminApi,
  scopesProjectList,
  requiresPasswordChange,
  PASSWORD_CHANGE_ALLOWLIST,
  type Access,
  type ScopedProject,
} from './access';

const TEAM_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TEAM_B = 'bbbbbbbb-0000-0000-0000-000000000002';

const projectInA: ScopedProject = { id: 'p-a', teamId: TEAM_A };
const projectInB: ScopedProject = { id: 'p-b', teamId: TEAM_B };
const orphan: ScopedProject = { id: 'p-orphan', teamId: null };

const base: Access = {
  kind: 'anonymous',
  userId: null,
  isGlobalAdmin: false,
  teamIds: [],
  roleByTeam: {},
  projectId: null,
  mustChangePassword: false,
};

const member = (teams: Record<string, 'team_admin' | 'member'>): Access => ({
  ...base,
  kind: 'user',
  userId: 'u1',
  teamIds: Object.keys(teams),
  roleByTeam: teams,
});

const globalAdminUser: Access = { ...member({}), isGlobalAdmin: true };
const adminToken: Access = { ...base, kind: 'admin-token', isGlobalAdmin: true };
const readToken: Access = { ...base, kind: 'read-token' };
const projectToken = (id: string): Access => ({ ...base, kind: 'project-token', projectId: id });

/**
 * A type-valid Access that the real classifier never actually produces:
 * `middleware/access.ts`'s ONE construction site for `admin-token` always
 * pairs it with `isGlobalAdmin: true`, so every test above that exercises
 * `adminToken` never actually reaches `canReadProject`/`canWriteProject`'s
 * `case 'admin-token'` branches or `canAdministerTeams`'s
 * `|| kind === 'admin-token'` clause — the `isGlobalAdmin` guard at the top
 * of each function already returns first. Nothing at the type level links
 * the two fields, though: they are independently-settable. This fixture
 * asks "if a future call site ever constructed admin-token access WITHOUT
 * also setting isGlobalAdmin, would these functions still be safe?" — the
 * belt in "belt and suspenders". `false` cases below prove the reverse: the
 * kind check does not ALSO leak into non-admin-token kinds.
 */
const adminTokenKindOnly: Access = { ...base, kind: 'admin-token', isGlobalAdmin: false };

/**
 * Same shape of question for `canEnterAdminApi`'s `access.kind === 'user'`
 * guard: `roleByTeam` and `kind` are independently-settable fields, and in
 * production `roleByTeam` is only ever populated for `kind: 'user'`
 * (`resolveAccessValue`, middleware/access.ts) — every other kind is built
 * from `anonymousAccess()`'s `roleByTeam: {}`. This asks "if some other kind
 * ever carried team_admin-shaped data in roleByTeam, would the kind check
 * still refuse it?"
 */
const roleDataOnNonUserKind: Access = {
  ...base,
  kind: 'read-token',
  roleByTeam: { [TEAM_A]: 'team_admin' },
};

describe('anonymousAccess', () => {
  it('is unprivileged and un-teamed', () => {
    const a = anonymousAccess();
    expect(a.kind).toBe('anonymous');
    expect(a.isGlobalAdmin).toBe(false);
    expect(a.teamIds).toEqual([]);
    expect(a.userId).toBeNull();
  });
});

describe('canReadProject — user', () => {
  it('allows a project in one of their teams', () => {
    expect(canReadProject(member({ [TEAM_A]: 'member' }), projectInA)).toBe(true);
  });

  it('DENIES a project in another team — this is the whole feature', () => {
    expect(canReadProject(member({ [TEAM_A]: 'member' }), projectInB)).toBe(false);
  });

  it('allows a project in ANY of their teams (multi-team membership)', () => {
    const multi = member({ [TEAM_A]: 'member', [TEAM_B]: 'team_admin' });
    expect(canReadProject(multi, projectInA)).toBe(true);
    expect(canReadProject(multi, projectInB)).toBe(true);
  });

  it('denies an orphaned project — a team deletion must not hand it to everyone', () => {
    expect(canReadProject(member({ [TEAM_A]: 'member' }), orphan)).toBe(false);
  });

  it('denies everything for a user in no teams', () => {
    expect(canReadProject(member({}), projectInA)).toBe(false);
    expect(canReadProject(member({}), orphan)).toBe(false);
  });

  it('team_admin can read, same as member', () => {
    expect(canReadProject(member({ [TEAM_A]: 'team_admin' }), projectInA)).toBe(true);
  });
});

describe('canReadProject — global admin', () => {
  it.each([
    ['global-admin user', globalAdminUser],
    ['ADMIN_TOKEN', adminToken],
  ])('%s reads any project, including orphans', (_label, access) => {
    expect(canReadProject(access, projectInA)).toBe(true);
    expect(canReadProject(access, projectInB)).toBe(true);
    expect(canReadProject(access, orphan)).toBe(true);
  });
});

describe('canReadProject — admin-token kind alone, independent of isGlobalAdmin', () => {
  it('reads everything, including orphans, purely from kind — the belt behind the isGlobalAdmin suspenders', () => {
    expect(canReadProject(adminTokenKindOnly, projectInA)).toBe(true);
    expect(canReadProject(adminTokenKindOnly, orphan)).toBe(true);
  });
});

describe('canReadProject — machine tokens', () => {
  it('READ_TOKEN is a global machine read (unchanged from plan 041)', () => {
    expect(canReadProject(readToken, projectInA)).toBe(true);
    expect(canReadProject(readToken, orphan)).toBe(true);
  });

  it('a project token reads only its own project', () => {
    expect(canReadProject(projectToken('p-a'), projectInA)).toBe(true);
    expect(canReadProject(projectToken('p-a'), projectInB)).toBe(false);
  });

  it('a project token is not widened by the project\'s team', () => {
    // Both projects are in TEAM_A, but the token names only one of them.
    expect(canReadProject(projectToken('p-a'), { id: 'p-sibling', teamId: TEAM_A })).toBe(false);
  });
});

describe('canReadProject — anonymous', () => {
  // THE backward-compatibility seam. An anonymous caller only exists when the
  // operator left READ_TOKEN unset, i.e. chose an open deployment. Teams must
  // not silently close it. See the Global Constraints of plan 058.
  it('reads everything — teams do not turn an open deployment into a closed one', () => {
    expect(canReadProject(anonymousAccess(), projectInA)).toBe(true);
    expect(canReadProject(anonymousAccess(), orphan)).toBe(true);
  });
});

describe('canWriteProject', () => {
  it('team_admin may write in their own team', () => {
    expect(canWriteProject(member({ [TEAM_A]: 'team_admin' }), projectInA)).toBe(true);
  });

  it('team_admin may NOT write in another team', () => {
    expect(canWriteProject(member({ [TEAM_A]: 'team_admin' }), projectInB)).toBe(false);
  });

  it('member is read-only, even in their own team', () => {
    expect(canWriteProject(member({ [TEAM_A]: 'member' }), projectInA)).toBe(false);
  });

  it.each([
    ['global-admin user', globalAdminUser],
    ['ADMIN_TOKEN', adminToken],
  ])('%s may write anywhere', (_label, access) => {
    expect(canWriteProject(access, projectInA)).toBe(true);
    expect(canWriteProject(access, orphan)).toBe(true);
  });

  it('READ_TOKEN may NOT write — the name is the contract', () => {
    expect(canWriteProject(readToken, projectInA)).toBe(false);
  });

  it('a project token may write to its own project (it is the ingest credential)', () => {
    expect(canWriteProject(projectToken('p-a'), projectInA)).toBe(true);
    expect(canWriteProject(projectToken('p-a'), projectInB)).toBe(false);
  });

  it('anonymous may NOT write — open reads never implied open writes (plan 031)', () => {
    expect(canWriteProject(anonymousAccess(), projectInA)).toBe(false);
  });

  it('admin-token kind alone writes everything, independent of isGlobalAdmin', () => {
    expect(canWriteProject(adminTokenKindOnly, projectInA)).toBe(true);
    expect(canWriteProject(adminTokenKindOnly, orphan)).toBe(true);
  });
});

describe('canAdministerTeams', () => {
  it.each([
    ['global-admin user', globalAdminUser, true],
    ['ADMIN_TOKEN', adminToken, true],
    ['team_admin', member({ [TEAM_A]: 'team_admin' }), false],
    ['member', member({ [TEAM_A]: 'member' }), false],
    ['READ_TOKEN', readToken, false],
    ['anonymous', anonymousAccess(), false],
  ])('%s → %s', (_label, access, expected) => {
    expect(canAdministerTeams(access as Access)).toBe(expected);
  });

  it('admin-token kind alone administers teams, independent of isGlobalAdmin', () => {
    expect(canAdministerTeams(adminTokenKindOnly)).toBe(true);
  });
});

describe('canEnterAdminApi', () => {
  it.each([
    ['global-admin user', globalAdminUser, true],
    ['ADMIN_TOKEN', adminToken, true],
    ['team_admin in one team', member({ [TEAM_A]: 'team_admin' }), true],
    // The whole point: team_admin status in ANY one team is enough, even
    // alongside plain membership elsewhere.
    ['team_admin in one team, member in another', member({ [TEAM_A]: 'team_admin', [TEAM_B]: 'member' }), true],
    // These three pin the human ruling: the gate is closed, not "any session".
    ['member only', member({ [TEAM_A]: 'member' }), false],
    ['user in no teams', member({}), false],
    ['READ_TOKEN', readToken, false],
    ['project-token', projectToken('p-a'), false],
    ['anonymous', anonymousAccess(), false],
  ])('%s → %s', (_label, access, expected) => {
    expect(canEnterAdminApi(access as Access)).toBe(expected);
  });

  it('refuses a non-user kind even if roleByTeam happens to hold team_admin-shaped data', () => {
    expect(canEnterAdminApi(roleDataOnNonUserKind)).toBe(false);
  });
});

describe('scopesProjectList', () => {
  it('scopes a plain user', () => {
    expect(scopesProjectList(member({ [TEAM_A]: 'member' }))).toBe(true);
  });

  it('scopes a project token to its one project', () => {
    expect(scopesProjectList(projectToken('p-a'))).toBe(true);
  });

  it.each([
    ['global-admin user', globalAdminUser],
    ['ADMIN_TOKEN', adminToken],
    ['READ_TOKEN', readToken],
    ['anonymous', anonymousAccess()],
  ])('does not scope %s', (_label, access) => {
    expect(scopesProjectList(access as Access)).toBe(false);
  });
});

// A mid-reset variant of each fixture the file already uses. Spreading the
// existing ones rather than rebuilding them is deliberate: if the Access shape
// changes again, these follow automatically instead of silently going stale.
const midResetMember = (teams: Record<string, 'team_admin' | 'member'>): Access => ({
  ...member(teams),
  mustChangePassword: true,
});
const midResetGlobalAdmin: Access = { ...globalAdminUser, mustChangePassword: true };

describe('requiresPasswordChange', () => {
  it('is true only for a user session carrying the flag', () => {
    expect(requiresPasswordChange(midResetMember({ [TEAM_A]: 'team_admin' }))).toBe(true);
    expect(requiresPasswordChange(member({ [TEAM_A]: 'team_admin' }))).toBe(false);
  });

  it('is false for every non-user kind, even if the flag is somehow set', () => {
    // Defence against a future edit that spreads a user Access into a token
    // one. Tokens are never mid-reset; the kind check is what guarantees it.
    for (const kind of ['project-token', 'read-token', 'admin-token', 'anonymous'] as const) {
      expect(
        requiresPasswordChange({ ...base, kind, mustChangePassword: true }),
        `${kind} must never be treated as mid-reset`
      ).toBe(false);
    }
  });

  it('anonymousAccess() never carries the flag', () => {
    expect(anonymousAccess().mustChangePassword).toBe(false);
  });
});

describe('the four predicates refuse a mid-reset user', () => {
  // Every case is asserted BOTH ways. A bare `toBe(false)` would also pass if
  // the predicate refused for an unrelated reason — wrong team, wrong role —
  // so each refusal is paired with the permit it would otherwise have been.
  it('canReadProject', () => {
    expect(canReadProject(member({ [TEAM_A]: 'member' }), projectInA)).toBe(true);
    expect(canReadProject(midResetMember({ [TEAM_A]: 'member' }), projectInA)).toBe(false);
  });

  it('canWriteProject', () => {
    expect(canWriteProject(member({ [TEAM_A]: 'team_admin' }), projectInA)).toBe(true);
    expect(canWriteProject(midResetMember({ [TEAM_A]: 'team_admin' }), projectInA)).toBe(false);
  });

  it('canAdministerTeams', () => {
    expect(canAdministerTeams(globalAdminUser)).toBe(true);
    expect(canAdministerTeams(midResetGlobalAdmin)).toBe(false);
  });

  it('canEnterAdminApi — both branches, not just the global-admin one', () => {
    expect(canEnterAdminApi(globalAdminUser)).toBe(true);
    expect(canEnterAdminApi(midResetGlobalAdmin)).toBe(false);
    // canEnterAdminApi's second branch (a plain team_admin) does NOT go through
    // canAdministerTeams. Guarding only that function is the obvious half-fix,
    // and this pair is what catches it.
    expect(canEnterAdminApi(member({ [TEAM_A]: 'team_admin' }))).toBe(true);
    expect(canEnterAdminApi(midResetMember({ [TEAM_A]: 'team_admin' }))).toBe(false);
  });

  it('scopesProjectList — a mid-reset caller is FILTERED, including a global admin', () => {
    // The odd one out, and the one a reviewer found unguarded. scopesProjectList
    // does not decide access; it decides whether canReadProject is consulted at
    // all. So `false` is the UNSAFE answer here — the inverse of every
    // predicate above — and "its safe direction is already true" is wrong for
    // exactly one caller: the global admin, who took the unfiltered branch and
    // so never reached canReadProject's mid-reset guard at all.
    //
    // Each case is paired with its non-mid-reset counterpart, so a predicate
    // that returned true unconditionally would fail on the second half.
    expect(scopesProjectList(globalAdminUser)).toBe(false);
    expect(
      scopesProjectList(midResetGlobalAdmin),
      'a mid-reset GLOBAL ADMIN must be filtered — otherwise the list route hands them every project'
    ).toBe(true);

    // The already-filtered kinds must stay filtered. These passed before the
    // fix too, which is precisely why the existing coverage missed the hole.
    expect(scopesProjectList(midResetMember({ [TEAM_A]: 'team_admin' }))).toBe(true);
    expect(scopesProjectList(member({ [TEAM_A]: 'team_admin' }))).toBe(true);

    // Token kinds are never mid-reset (requiresPasswordChange gates on
    // kind === 'user'), so the new first line must not perturb them.
    expect(scopesProjectList(adminToken)).toBe(false);
    expect(scopesProjectList(readToken)).toBe(false);
    expect(scopesProjectList(anonymousAccess())).toBe(false);
    expect(scopesProjectList(projectToken('p-a'))).toBe(true);
  });

  it('a filtered mid-reset global admin sees NO project — the end-to-end layer-1 outcome on a list', () => {
    // scopesProjectList and canReadProject compose into the actual behaviour
    // the list routes get. Asserting the composition, not just each half,
    // is what pins the outcome as "empty list" rather than "some filter ran".
    // `orphan` is in the set on purpose: it is global-admin-only, so a leak
    // through the isGlobalAdmin branch would show up here first.
    const rows = [projectInA, projectInB, orphan];
    const visible = scopesProjectList(midResetGlobalAdmin)
      ? rows.filter((p) => canReadProject(midResetGlobalAdmin, p))
      : rows;
    expect(visible).toEqual([]);

    // The control: the same admin, not mid-reset, still sees everything. Without
    // this the assertion above would also pass against a predicate that hid
    // every project from every global admin.
    const healthy = scopesProjectList(globalAdminUser)
      ? rows.filter((p) => canReadProject(globalAdminUser, p))
      : rows;
    expect(healthy).toEqual(rows);
  });

  it('the check is ordered BEFORE the isGlobalAdmin shortcut', () => {
    // canReadProject and canWriteProject both open with
    // `if (access.isGlobalAdmin) return true`. Putting the new check after it
    // leaves global admins — the highest-value accounts — entirely unenforced.
    // `orphan` (teamId: null) is readable by global admins ONLY, so a true here
    // can come from nothing but the isGlobalAdmin branch having run first.
    expect(canReadProject(globalAdminUser, orphan)).toBe(true);
    expect(canReadProject(midResetGlobalAdmin, orphan)).toBe(false);
    expect(canWriteProject(globalAdminUser, orphan)).toBe(true);
    expect(canWriteProject(midResetGlobalAdmin, orphan)).toBe(false);
  });
});

describe('PASSWORD_CHANGE_ALLOWLIST', () => {
  it('is exactly the four recovery paths, spelled in full', () => {
    // Full absolute paths, not suffixes: the gate matches against c.req.path,
    // which Hono reports as the whole request path even inside a sub-router.
    expect([...PASSWORD_CHANGE_ALLOWLIST].sort()).toEqual([
      '/api/v1/auth/change-password',
      '/api/v1/auth/login',
      '/api/v1/auth/logout',
      '/api/v1/auth/me',
    ]);
  });
});
