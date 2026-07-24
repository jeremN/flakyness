import { env } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import type {
  AdminProject,
  CreateProjectResult,
  RotateTokenResult,
  PruneResult,
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

// The dashboard has no ADMIN_TOKEN — it cannot spend a token it does not hold.
// Actions convert this to a 403 fail; it must never become an unauthenticated
// request to the API.
export class MissingAdminTokenError extends Error {
  constructor() {
    super('The dashboard server has no ADMIN_TOKEN configured; admin actions are disabled.');
    this.name = 'MissingAdminTokenError';
  }
}

export function adminConfigured(): boolean {
  return Boolean(privateEnv.ADMIN_TOKEN);
}

async function adminFetch<T>(
  path: string,
  init: { method: string; body?: unknown } = { method: 'GET' }
): Promise<T> {
  const token = privateEnv.ADMIN_TOKEN;
  if (!token) throw new MissingAdminTokenError();

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
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

export function listProjects(): Promise<{ projects: AdminProject[] }> {
  return adminFetch('/api/v1/admin/projects');
}

export function createProject(body: {
  name: string;
  gitlabProjectId?: string;
}): Promise<CreateProjectResult> {
  return adminFetch('/api/v1/admin/projects', { method: 'POST', body });
}

export function patchProject(
  id: string,
  body: Record<string, number | string | boolean | null>
): Promise<unknown> {
  return adminFetch(`/api/v1/admin/projects/${id}`, { method: 'PATCH', body });
}

export function rotateToken(id: string): Promise<RotateTokenResult> {
  return adminFetch(`/api/v1/admin/projects/${id}/rotate-token`, { method: 'POST' });
}

export function pruneProject(id: string, confirm: boolean): Promise<PruneResult> {
  const query = confirm ? '?confirm=true' : '';
  return adminFetch(`/api/v1/admin/projects/${id}/prune${query}`, { method: 'POST' });
}

export function deleteProject(id: string): Promise<{ success: boolean; message: string }> {
  return adminFetch(`/api/v1/admin/projects/${id}`, { method: 'DELETE' });
}
