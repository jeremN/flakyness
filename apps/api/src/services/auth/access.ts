import type { TeamRole } from './membership';

/**
 * How the caller authenticated. Every branch of the authorization model keys
 * off this plus `isGlobalAdmin` — there is no sixth case, and adding one means
 * revisiting every function below.
 */
export type AccessKind = 'user' | 'project-token' | 'read-token' | 'admin-token' | 'anonymous';

export interface Access {
  kind: AccessKind;
  userId: string | null;
  isGlobalAdmin: boolean;
  teamIds: string[];
  roleByTeam: Record<string, TeamRole>;
  /** Set only for kind === 'project-token': the single project it may touch. */
  projectId: string | null;
}

/** The scope-relevant shape of a project. */
export interface ScopedProject {
  id: string;
  teamId: string | null;
}

export function anonymousAccess(): Access {
  return {
    kind: 'anonymous',
    userId: null,
    isGlobalAdmin: false,
    teamIds: [],
    roleByTeam: {},
    projectId: null,
  };
}

/**
 * May this caller READ this project?
 *
 * `anonymous` returns true on purpose. An anonymous caller can only exist on a
 * deployment where the operator left READ_TOKEN unset — i.e. deliberately open
 * reads (plan 041, D1). Teams scope *identified* callers; they do not
 * retroactively close a deployment its owner chose to leave open. Denying here
 * would break every existing install the moment this plan merges.
 */
export function canReadProject(access: Access, project: ScopedProject): boolean {
  if (access.isGlobalAdmin) return true;

  switch (access.kind) {
    case 'admin-token':
      return true;
    case 'read-token':
      return true;
    case 'anonymous':
      return true;
    case 'project-token':
      return access.projectId === project.id;
    case 'user':
      // An orphaned project (teamId === null) is readable by global admins
      // only — deleting a team must not publish its projects to everyone.
      return project.teamId !== null && access.teamIds.includes(project.teamId);
  }
}

/**
 * May this caller MUTATE this project (settings, rules, token rotation, mute)?
 *
 * Note the asymmetry with reads: `read-token` and `anonymous` are read-only.
 * Plan 031 closed a confused deputy that let an unauthenticated POST mute a
 * test — and a muted test feeds the CI skip-list. Open reads never implied
 * open writes, and must not start to here.
 */
export function canWriteProject(access: Access, project: ScopedProject): boolean {
  if (access.isGlobalAdmin) return true;

  switch (access.kind) {
    case 'admin-token':
      return true;
    case 'project-token':
      return access.projectId === project.id;
    case 'user':
      return project.teamId !== null && access.roleByTeam[project.teamId] === 'team_admin';
    case 'read-token':
    case 'anonymous':
      return false;
  }
}

/** Team CRUD and user CRUD are global-admin only — never delegated per team. */
export function canAdministerTeams(access: Access): boolean {
  return access.isGlobalAdmin || access.kind === 'admin-token';
}

/**
 * May this caller reach the admin API at all?
 *
 * Wider than canAdministerTeams (a team_admin belongs here; the routes below
 * scope them per project) and narrower than "has a session". A plain member is
 * refused: everything they need is on /api/v1/projects, so admitting them and
 * trusting each route to filter would put the burden of not leaking on every
 * admin route ever added, instead of on one gate.
 */
export function canEnterAdminApi(access: Access): boolean {
  if (canAdministerTeams(access)) return true;
  return access.kind === 'user' && Object.values(access.roleByTeam).includes('team_admin');
}

/**
 * Should a project LIST be filtered for this caller?
 *
 * The complement of "sees everything". Kept as its own function so a list
 * route cannot drift from the per-project rule by re-deriving the condition
 * inline.
 */
export function scopesProjectList(access: Access): boolean {
  if (access.isGlobalAdmin) return false;
  return access.kind === 'user' || access.kind === 'project-token';
}
