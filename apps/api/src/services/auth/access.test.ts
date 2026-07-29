import { describe, it, expect } from 'vitest';
import {
  anonymousAccess,
  canReadProject,
  canWriteProject,
  canAdministerTeams,
  scopesProjectList,
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
