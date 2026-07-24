import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env as privateEnv } from '$env/dynamic/private';
import {
  listProjects,
  createProject,
  patchProject,
  rotateToken,
  pruneProject,
  deleteProject,
  adminConfigured,
  AdminApiError,
  MissingAdminTokenError,
} from './adminApi';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  privateEnv.ADMIN_TOKEN = 'admintok';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete privateEnv.ADMIN_TOKEN;
});

describe('adminConfigured', () => {
  it('reflects presence of ADMIN_TOKEN', () => {
    expect(adminConfigured()).toBe(true);
    delete privateEnv.ADMIN_TOKEN;
    expect(adminConfigured()).toBe(false);
  });
});

describe('adminApi auth + wiring', () => {
  it('throws MissingAdminTokenError and never fetches without a token', async () => {
    delete privateEnv.ADMIN_TOKEN;
    await expect(listProjects()).rejects.toBeInstanceOf(MissingAdminTokenError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the bearer token and hits the list endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ projects: [] }));
    await listProjects();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer admintok');
  });

  it('POSTs create with a JSON body and Content-Type', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ project: {}, token: 't', warning: 'w' }, 201));
    await createProject({ name: 'proj' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ name: 'proj' });
  });

  it('PATCHes the project config', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await patchProject('p1', { windowDays: 14 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ windowDays: 14 });
  });

  it('rotates the token via POST with no body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ project: {}, token: 't', warning: 'w' }));
    await rotateToken('p1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1/rotate-token');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('adds ?confirm=true only when confirming a prune', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ dryRun: true, cutoff: 'x' }));
    await pruneProject('p1', false);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/api/v1/admin/projects/p1/prune');
    await pruneProject('p1', true);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://localhost:8080/api/v1/admin/projects/p1/prune?confirm=true'
    );
  });

  it('DELETEs the project', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, message: 'gone' }));
    await deleteProject('p1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/v1/admin/projects/p1');
    expect(init.method).toBe('DELETE');
  });

  it('forwards the API error body and status on a non-2xx', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'Project with this name already exists' }, 409)
    );
    const err = await createProject({ name: 'dup' }).catch((e) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('Project with this name already exists');
  });

  it('falls back to a generic message when the error body has no `error`', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    const err = await listProjects().catch((e) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err.statusCode).toBe(500);
    expect(err.message).toBe('API request failed (500)');
  });
});
