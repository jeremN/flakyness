import type { Project } from '../app.d';

/**
 * Split a project list into team-owned and unassigned (`teamId === null`)
 * groups.
 *
 * This is the client-side half of a Global Constraint from plan 059 (Task 6,
 * Step 2b): `POST /admin/projects` keeps `teamId` optional (plan 058's
 * pre-flight ruling), so a project created without one stays
 * `team_id IS NULL` and — by `canReadProject`'s design — is invisible to
 * every non-global-admin, INCLUDING the team that created it. Global admins
 * are the only callers who can read such a project at all, so the caller
 * (+layout.svelte) renders `unassigned` under an explicit "Unassigned"
 * heading gated on `data.user?.isGlobalAdmin`, never merged silently into
 * the regular list.
 *
 * Pure and order-preserving so it is unit-testable in the node env without a
 * running SvelteKit context.
 */
export function partitionProjects(projects: Project[]): { assigned: Project[]; unassigned: Project[] } {
  const assigned: Project[] = [];
  const unassigned: Project[] = [];
  for (const project of projects) {
    if (project.teamId === null) {
      unassigned.push(project);
    } else {
      assigned.push(project);
    }
  }
  return { assigned, unassigned };
}
