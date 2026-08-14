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

/** One exempt request: a METHOD and a PATH, never a path alone. */
export interface AllowedRequest {
  readonly method: string;
  readonly path: string;
}

/**
 * Requests reachable while a password change is pending.
 *
 * METHOD **AND** PATH, not path alone. A path-only exemption silently extends
 * to every method that path ever grows: a future `DELETE /api/v1/auth/me`
 * ("close my account") would have been allowed mid-reset without anyone
 * deciding that, and the coverage guard — which deduped paths into a Set —
 * could not have seen the difference. Pairing is what forces the decision to
 * be made once per method.
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
 *
 * `HEAD /api/v1/auth/me` is a REAL entry, not defensive padding, and removing
 * it is a live regression. Hono answers HEAD from a GET route — measured on
 * 4.12.33: `HEAD /api/v1/auth/me` returns 200 and this middleware observes
 * `c.req.method === 'HEAD'`. Under the old path-only match that was exempt by
 * accident; under pairs it must be exempt on purpose, or every HEAD probe of
 * /me starts 403-ing mid-reset.
 *
 * `OPTIONS` is deliberately ABSENT. `cors()` is mounted globally at
 * `index.ts:29`, ahead of every router, and answers preflight itself with a
 * 204 — measured: the gate never runs for an OPTIONS request, with or without
 * preflight headers. Adding OPTIONS here would be dead code implying a
 * protection that is not this layer's to give. If `cors()` is ever moved below
 * the routers, revisit this.
 */
export const PASSWORD_CHANGE_ALLOWLIST: readonly AllowedRequest[] = [
  { method: 'POST', path: '/api/v1/auth/change-password' },
  { method: 'GET', path: '/api/v1/auth/me' },
  { method: 'HEAD', path: '/api/v1/auth/me' },
  { method: 'POST', path: '/api/v1/auth/logout' },
  { method: 'POST', path: '/api/v1/auth/login' },
];

/**
 * Is this exact request exempt from the password-change gate?
 *
 * Takes `c.req.method` / `c.req.path` rather than the Context, so it stays a
 * pure function that unit tests can drive directly.
 *
 * `path` MUST be `c.req.path` and nothing else. Hono percent-decodes and
 * resolves `..` before BOTH dispatch and `c.req.path` (measured:
 * `/api/v1/projects/../auth/me` and `/api/v1/auth/%6de` both dispatch to the
 * `/api/v1/auth/me` handler and both report `c.req.path === '/api/v1/auth/me'`),
 * so gate and router are reading the same post-normalisation key and cannot
 * disagree. Do NOT normalise again here — a second, differently-implemented
 * normalisation is the only way to desynchronise the two.
 */
export function isPasswordChangeExempt(method: string, path: string): boolean {
  return PASSWORD_CHANGE_ALLOWLIST.some((r) => r.method === method && r.path === path);
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
 *
 * The mid-reset check comes FIRST, ahead of the isGlobalAdmin shortcut, and
 * that order is the whole point. This predicate does not decide access — it
 * decides whether canReadProject is consulted at all. Returning false skips it
 * entirely, so `false` is the UNSAFE direction here, the exact inverse of the
 * four predicates above where `false` means "denied". Without this line a
 * mid-reset GLOBAL ADMIN — the highest-privilege caller on the instance — took
 * the unfiltered branch, canReadProject's mid-reset guard was never called,
 * and layer 1 provided no backstop whatsoever on the list routes
 * (routes/projects.ts, routes/admin.ts). Filtering instead makes
 * canReadProject run and short-circuit false for every row, so layer 1's
 * outcome on a LIST is a 200 carrying an empty array.
 *
 * That empty-200 is a third layer-1 outcome, alongside the 404 that
 * project-scoped reads/writes produce and the code-less 403 the team/admin
 * surface produces. Only layer 2 (passwordChangeGate) turns any of them into
 * the uniform `403 password_change_required`; layer 1 is the backstop for a
 * router that forgot to mount the gate, not a second copy of its contract.
 */
export function scopesProjectList(access: Access): boolean {
  if (requiresPasswordChange(access)) return true;
  if (access.isGlobalAdmin) return false;
  return access.kind === 'user' || access.kind === 'project-token';
}
