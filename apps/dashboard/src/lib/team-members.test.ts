import { describe, it, expect } from 'vitest';
import type { AdminUser } from '../app.d';
import { membersOfTeam, usersAvailableForTeam } from './team-members';

function user(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: 'u1',
    email: 'alice@example.com',
    displayName: 'Alice',
    isGlobalAdmin: false,
    mustChangePassword: false,
    createdAt: '2026-01-01T00:00:00Z',
    lastLoginAt: null,
    teams: [],
    ...overrides,
  };
}

describe('membersOfTeam', () => {
  it('returns a user who belongs to the team, with their role in that team', () => {
    const alice = user({ id: 'u1', teams: [{ id: 't1', name: 'Team One', role: 'team_admin' }] });
    const result = membersOfTeam([alice], 't1');
    expect(result).toEqual([{ userId: 'u1', email: 'alice@example.com', displayName: 'Alice', role: 'team_admin' }]);
  });

  it('excludes a user who belongs to a different team', () => {
    const bob = user({ id: 'u2', email: 'bob@example.com', teams: [{ id: 't2', name: 'Team Two', role: 'member' }] });
    expect(membersOfTeam([bob], 't1')).toEqual([]);
  });

  it('excludes a user with no team memberships at all', () => {
    const carol = user({ id: 'u3', teams: [] });
    expect(membersOfTeam([carol], 't1')).toEqual([]);
  });

  it('picks the role from the matching team entry, not from a different membership on the same user', () => {
    // A user can belong to multiple teams with different roles in each —
    // the returned role must come from the entry matching `teamId`, not
    // from whichever entry happens to be first in the array.
    const dana = user({
      id: 'u4',
      teams: [
        { id: 't2', name: 'Team Two', role: 'team_admin' },
        { id: 't1', name: 'Team One', role: 'member' },
      ],
    });
    expect(membersOfTeam([dana], 't1')).toEqual([
      { userId: 'u4', email: dana.email, displayName: dana.displayName, role: 'member' },
    ]);
  });

  it('preserves input order across multiple matching users', () => {
    const a = user({ id: 'a', teams: [{ id: 't1', name: 'Team One', role: 'member' }] });
    const b = user({ id: 'b', teams: [{ id: 't1', name: 'Team One', role: 'team_admin' }] });
    expect(membersOfTeam([a, b], 't1').map((m) => m.userId)).toEqual(['a', 'b']);
  });

  it('returns an empty array for an empty user list', () => {
    expect(membersOfTeam([], 't1')).toEqual([]);
  });
});

describe('usersAvailableForTeam', () => {
  it('includes a user who is not a member of the team', () => {
    const bob = user({ id: 'u2', teams: [] });
    expect(usersAvailableForTeam([bob], 't1').map((u) => u.id)).toEqual(['u2']);
  });

  it('excludes a user who is already a member of the team', () => {
    const alice = user({ id: 'u1', teams: [{ id: 't1', name: 'Team One', role: 'member' }] });
    expect(usersAvailableForTeam([alice], 't1')).toEqual([]);
  });

  it('includes a user who belongs to a different team but not this one', () => {
    const bob = user({ id: 'u2', teams: [{ id: 't2', name: 'Team Two', role: 'member' }] });
    expect(usersAvailableForTeam([bob], 't1').map((u) => u.id)).toEqual(['u2']);
  });
});
