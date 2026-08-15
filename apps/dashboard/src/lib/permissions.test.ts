import { describe, it, expect } from 'vitest';
import { canMuteTests } from './permissions';
import type { SessionUser, TeamSummary } from '../app.d';

const user = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: 'u1',
  email: 'a@b.c',
  displayName: null,
  isGlobalAdmin: false,
  mustChangePassword: false,
  ...over,
});

const TEAMS: TeamSummary[] = [
  { id: 't-admin', name: 'Owned', role: 'team_admin' },
  { id: 't-member', name: 'Joined', role: 'member' },
];

describe('canMuteTests', () => {
  it('lets a team_admin mute tests in that team\'s project', () => {
    expect(canMuteTests(user(), TEAMS, { teamId: 't-admin' })).toBe(true);
  });

  it('refuses a plain member of the owning team', () => {
    expect(canMuteTests(user(), TEAMS, { teamId: 't-member' })).toBe(false);
  });

  it('refuses a team_admin of a DIFFERENT team', () => {
    expect(canMuteTests(user(), TEAMS, { teamId: 't-other' })).toBe(false);
  });

  it('lets a global admin mute regardless of membership', () => {
    expect(canMuteTests(user({ isGlobalAdmin: true }), [], { teamId: 't-other' })).toBe(true);
  });

  it('refuses an unassigned project even for a team_admin', () => {
    // Mirrors canWriteProject: `project.teamId !== null` is a precondition, so
    // a team_admin has no path to a project that belongs to no team.
    expect(canMuteTests(user(), TEAMS, { teamId: null })).toBe(false);
  });

  it('lets a global admin mute an unassigned project', () => {
    expect(canMuteTests(user({ isGlobalAdmin: true }), [], { teamId: null })).toBe(true);
  });

  it('refuses an anonymous caller', () => {
    expect(canMuteTests(null, TEAMS, { teamId: 't-admin' })).toBe(false);
  });

  it('refuses when there is no selected project', () => {
    expect(canMuteTests(user({ isGlobalAdmin: true }), TEAMS, null)).toBe(false);
  });

  it('refuses a mid-reset user even when they are a global admin', () => {
    // Mirrors requiresPasswordChange()'s short-circuit, which is the FIRST
    // check in every API predicate (plan 058b). Without this the console would
    // offer a button the API answers with 403 password_change_required.
    expect(
      canMuteTests(user({ isGlobalAdmin: true, mustChangePassword: true }), TEAMS, {
        teamId: 't-admin',
      })
    ).toBe(false);
  });

  it('refuses a mid-reset team_admin', () => {
    expect(
      canMuteTests(user({ mustChangePassword: true }), TEAMS, { teamId: 't-admin' })
    ).toBe(false);
  });
});
