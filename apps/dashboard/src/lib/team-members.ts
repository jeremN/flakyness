import type { AdminUser, TeamSummary } from '../app.d';

export interface TeamMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: TeamSummary['role'];
}

/**
 * Members of team `teamId`, derived from the admin user list rather than a
 * per-team API call.
 *
 * Task 7a brief (resolved for the implementer): `GET /api/v1/admin/users`
 * already joins `team_members` to `teams` and attaches `teams: TeamSummary[]`
 * to every `AdminUser` — so team T's members are `users.filter((u) =>
 * u.teams.some((t) => t.id === T.id))`, with that entry's `role` as the
 * member's role in T. Deriving here avoids an N+1 against
 * `GET /admin/teams/:id/members` for data `listUsers()` already returned.
 * Pure and unit-tested in the node env so the `.svelte` component stays a
 * renderer (the established pattern — `$lib/project-groups.ts` from Task 6,
 * `$lib/rules-validation.ts` from plan 055).
 */
export function membersOfTeam(users: AdminUser[], teamId: string): TeamMember[] {
  const members: TeamMember[] = [];
  for (const user of users) {
    const membership = user.teams.find((t) => t.id === teamId);
    if (membership) {
      members.push({ userId: user.id, email: user.email, displayName: user.displayName, role: membership.role });
    }
  }
  return members;
}

/**
 * Users who are NOT yet a member of team `teamId` — the add-member picker's
 * option list. A user already in the team must not be offered again (the API
 * would 409 on the duplicate-membership check anyway; this keeps the picker
 * from offering a choice that can't succeed).
 */
export function usersAvailableForTeam(users: AdminUser[], teamId: string): AdminUser[] {
  return users.filter((user) => !user.teams.some((t) => t.id === teamId));
}
