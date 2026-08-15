import type { SessionUser, TeamSummary } from '../app.d';

/**
 * May this user mute/unmute flaky tests in this project?
 *
 * This is a UI affordance, NOT the security boundary. The API decides, in
 * `canWriteProject` plus PATCH /tests/flaky/:id's own narrowing; this function
 * only decides whether to render a button the API would honour. Keep the two in
 * agreement: a mismatch shows a control that always fails (annoying) or hides
 * one the user is entitled to (worse — it looks like a permissions bug).
 *
 * Deliberately mirrors the API's ordering, including the mustChangePassword
 * short-circuit first (plan 058b), so the shapes stay comparable when either
 * side changes.
 */
export function canMuteTests(
  user: SessionUser | null,
  teams: TeamSummary[],
  project: { teamId: string | null } | null
): boolean {
  if (!user) return false;
  if (user.mustChangePassword) return false;
  if (user.isGlobalAdmin) return project !== null;
  if (!project || project.teamId === null) return false;
  return teams.some((t) => t.id === project.teamId && t.role === 'team_admin');
}
