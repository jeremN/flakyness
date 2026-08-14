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
  /**
   * The caller is a `user` whose password was admin-provisioned or admin-reset
   * and not yet rotated. Only ever true for kind === 'user' — every token-kind
   * Access is built by spreading anonymousAccess(), which sets it false.
   */
  mustChangePassword: boolean;
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
    mustChangePassword: false,
  };
}

/**
 * Is this caller holding an unrotated temporary password?
 *
 * The `kind` check is load-bearing, not defensive noise: it is what guarantees
 * a token can never be classified as mid-reset even if a future edit spreads a
 * user Access into one.
 */
export function requiresPasswordChange(access: Access): boolean {
  return access.kind === 'user' && access.mustChangePassword;
}

/**
 * Routes reachable while a password change is pending.
 *
 * EXPLICIT ABSOLUTE PATHS, never an `/api/v1/auth` prefix — plan 041's
 * SELF_GATED carries the same warning, for the same reason: a prefix silently
 * exempts every future auth route. Adding an entry here must be a deliberate,
 * reviewed edit, and password-change-coverage.test.ts fails CI if a new auth
 * route appears without one.
 *
 * The contents follow AWS IAM's PasswordResetRequired rule — allow what
 * COMPLETES the remedy, not only the remedy itself:
 *   change-password  the remedy
 *   me               the dashboard cannot render the change-password page without it
 *   logout           never trap a user in a session they cannot leave
 *   login            re-authenticating must not be blocked by a pending reset
 */
export const PASSWORD_CHANGE_ALLOWLIST: readonly string[] = [
  '/api/v1/auth/change-password',
  '/api/v1/auth/me',
  '/api/v1/auth/logout',
  '/api/v1/auth/login',
];

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
  if (requiresPasswordChange(access)) return false;
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
  if (requiresPasswordChange(access)) return false;
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
  if (requiresPasswordChange(access)) return false;
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
  // Guarded here as well as in canAdministerTeams: the second branch below
  // does NOT go through canAdministerTeams, so guarding only that function
  // would leave a mid-reset team_admin with full admin-API entry.
  if (requiresPasswordChange(access)) return false;
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
