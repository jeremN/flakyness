import { env } from '$env/dynamic/public';
import { SESSION_COOKIE } from '../session';
import type {
  AdminProject,
  CreateProjectResult,
  RotateTokenResult,
  PruneResult,
  QuarantineRule,
  AdminTeam,
  AdminUser,
  TeamSummary,
} from '../../app.d';

const API_URL = env.PUBLIC_API_URL || 'http://localhost:8080';

// A non-2xx from the admin API. Carries the status + the API's own error
// message so the calling action can forward both to the user.
export class AdminApiError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

/**
 * The request carries no session, so there is nobody to act as.
 *
 * Replaces plan 053's MissingAdminTokenError: the dashboard no longer holds an
 * ADMIN_TOKEN to be missing. Actions convert this to a 403 fail; it must never
 * become an unauthenticated request to the API.
 */
export class NotAuthenticatedError extends Error {
  constructor() {
    super('Not signed in.');
    this.name = 'NotAuthenticatedError';
  }
}

export function createAdminApi(sessionToken: string | null, clientIp: string | null) {
  async function adminFetch<T>(
    path: string,
    init: { method: string; body?: unknown } = { method: 'GET' }
  ): Promise<T> {
    if (!sessionToken) throw new NotAuthenticatedError();

    const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${sessionToken}` };
    // Delta §D1.2. Set only when present: an empty X-Forwarded-For would key
    // every such request into one bucket instead of falling back to the socket
    // address, which is the opposite of the intent.
    if (clientIp) headers['X-Forwarded-For'] = clientIp;
    const hasBody = init.body !== undefined;
    if (hasBody) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${API_URL}${path}`, {
      method: init.method,
      headers,
      body: hasBody ? JSON.stringify(init.body) : undefined,
    });

    if (!res.ok) {
      let message = `API request failed (${res.status})`;
      try {
        const errBody = (await res.clone().json()) as { error?: unknown };
        if (errBody && typeof errBody.error === 'string') message = errBody.error;
      } catch {
        // keep the generic message
      }
      throw new AdminApiError(res.status, message);
    }

    return res.clone().json() as Promise<T>;
  }

  return {
    listProjects: () => adminFetch<{ projects: AdminProject[] }>('/api/v1/admin/projects'),

    createProject: (body: { name: string; gitlabProjectId?: string }) =>
      adminFetch<CreateProjectResult>('/api/v1/admin/projects', { method: 'POST', body }),

    patchProject: (id: string, body: Record<string, number | string | boolean | null>) =>
      adminFetch<unknown>(`/api/v1/admin/projects/${id}`, { method: 'PATCH', body }),

    rotateToken: (id: string) =>
      adminFetch<RotateTokenResult>(`/api/v1/admin/projects/${id}/rotate-token`, { method: 'POST' }),

    pruneProject: (id: string, confirm: boolean) => {
      const query = confirm ? '?confirm=true' : '';
      return adminFetch<PruneResult>(`/api/v1/admin/projects/${id}/prune${query}`, { method: 'POST' });
    },

    deleteProject: (id: string) =>
      adminFetch<{ success: boolean; message: string }>(`/api/v1/admin/projects/${id}`, { method: 'DELETE' }),

    listRules: (id: string) => adminFetch<{ rules: QuarantineRule[] }>(`/api/v1/admin/projects/${id}/rules`),

    createRule: (id: string, body: Record<string, number | string | boolean | null>) =>
      adminFetch<{ rule: QuarantineRule }>(`/api/v1/admin/projects/${id}/rules`, { method: 'POST', body }),

    patchRule: (id: string, ruleId: string, body: Record<string, number | string | boolean | null>) =>
      adminFetch<{ rule: QuarantineRule }>(`/api/v1/admin/projects/${id}/rules/${ruleId}`, {
        method: 'PATCH',
        body,
      }),

    deleteRule: (id: string, ruleId: string) =>
      adminFetch<{ success: boolean }>(`/api/v1/admin/projects/${id}/rules/${ruleId}`, { method: 'DELETE' }),

    reorderRules: (id: string, order: string[]) =>
      adminFetch<{ success: boolean }>(`/api/v1/admin/projects/${id}/rules/reorder`, {
        method: 'POST',
        body: { order },
      }),

    // New in this plan:
    listTeams: () => adminFetch<{ teams: AdminTeam[] }>('/api/v1/admin/teams'),
    createTeam: (name: string) =>
      adminFetch<{ team: AdminTeam }>('/api/v1/admin/teams', { method: 'POST', body: { name } }),
    patchTeam: (teamId: string, name: string) =>
      adminFetch<{ team: AdminTeam }>(`/api/v1/admin/teams/${teamId}`, { method: 'PATCH', body: { name } }),
    deleteTeam: (teamId: string) =>
      adminFetch<{ success: boolean; orphanedProjects: number }>(`/api/v1/admin/teams/${teamId}`, {
        method: 'DELETE',
      }),
    listTeamMembers: (teamId: string) =>
      adminFetch<{ members: { userId: string; email: string; displayName: string | null; role: TeamSummary['role'] }[] }>(
        `/api/v1/admin/teams/${teamId}/members`
      ),
    addTeamMember: (teamId: string, userId: string, role: TeamSummary['role']) =>
      adminFetch(`/api/v1/admin/teams/${teamId}/members`, { method: 'POST', body: { userId, role } }),
    patchTeamMember: (teamId: string, userId: string, role: TeamSummary['role']) =>
      adminFetch(`/api/v1/admin/teams/${teamId}/members/${userId}`, { method: 'PATCH', body: { role } }),
    removeTeamMember: (teamId: string, userId: string) =>
      adminFetch(`/api/v1/admin/teams/${teamId}/members/${userId}`, { method: 'DELETE' }),

    listUsers: () => adminFetch<{ users: AdminUser[] }>('/api/v1/admin/users'),
    createUser: (body: { email: string; displayName?: string; isGlobalAdmin?: boolean }) =>
      adminFetch<{ user: AdminUser; temporaryPassword: string; warning: string }>('/api/v1/admin/users', {
        method: 'POST',
        body,
      }),
    patchUser: (userId: string, body: { displayName?: string | null; isGlobalAdmin?: boolean }) =>
      adminFetch<{ user: AdminUser }>(`/api/v1/admin/users/${userId}`, { method: 'PATCH', body }),
    resetUserPassword: (userId: string) =>
      adminFetch<{ temporaryPassword: string; warning: string }>(`/api/v1/admin/users/${userId}/reset-password`, {
        method: 'POST',
      }),
    deleteUser: (userId: string) =>
      adminFetch<{ success: boolean }>(`/api/v1/admin/users/${userId}`, { method: 'DELETE' }),
  };
}
