import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/adminApi', () => ({
  listProjects: vi.fn(),
  patchProject: vi.fn(),
  rotateToken: vi.fn(),
  pruneProject: vi.fn(),
  deleteProject: vi.fn(),
  adminConfigured: vi.fn(() => true),
  AdminApiError: class AdminApiError extends Error {
    statusCode: number;
    constructor(status: number, message: string) {
      super(message);
      this.statusCode = status;
    }
  },
  MissingAdminTokenError: class MissingAdminTokenError extends Error {},
}));

import { listProjects, patchProject, rotateToken, pruneProject, deleteProject } from '$lib/server/adminApi';
import { load, actions } from './+page.server';

const mockedList = vi.mocked(listProjects);
const mockedPatch = vi.mocked(patchProject);
const mockedRotate = vi.mocked(rotateToken);
const mockedPrune = vi.mocked(pruneProject);
const mockedDelete = vi.mocked(deleteProject);

const project = {
  id: 'p1',
  name: 'Proj',
  gitlabProjectId: null,
  hasToken: true,
  createdAt: 'x',
  flakeThreshold: 0.1,
  windowDays: 14,
  minRuns: 5,
  webhookUrl: null,
  webhookKind: null,
  retentionDays: 30,
  autoQuarantineEnabled: false,
  quarantineThreshold: null,
  quarantineMinRuns: null,
  quarantineTtlDays: null,
  stats: { totalRuns: 3, totalTests: 9, activeFlakyTests: 1 },
} as any;

function formEvent(fields: Record<string, string>, id = 'p1') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return { request: { formData: async () => fd }, params: { projectId: id } } as any;
}

beforeEach(() => {
  mockedList.mockReset();
  mockedPatch.mockReset();
});

describe('admin/[projectId] load', () => {
  it('returns the matching project', async () => {
    mockedList.mockResolvedValue({ projects: [project] });
    const result = await load({ params: { projectId: 'p1' } } as any);
    expect(result).toEqual({ project });
  });

  it('404s when the project id is not in the list', async () => {
    mockedList.mockResolvedValue({ projects: [project] });
    await expect(load({ params: { projectId: 'nope' } } as any)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('admin/[projectId] patch action', () => {
  it('rejects out-of-bounds input before calling the API', async () => {
    const result = (await actions.patch(formEvent({ windowDays: '0' }))) as any;
    expect(result.status).toBe(400);
    expect(result.data.errors.windowDays).toBeTruthy();
    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('builds a full patch (empty ⇒ null) and calls the API on valid input', async () => {
    mockedPatch.mockResolvedValue({});
    const result = (await actions.patch(
      formEvent({ windowDays: '20', flakeThreshold: '', webhookKind: 'slack' })
    )) as any;
    expect(mockedPatch).toHaveBeenCalledWith('p1', expect.objectContaining({
      windowDays: 20,
      flakeThreshold: null,
      webhookKind: 'slack',
      autoQuarantineEnabled: false,
    }));
    expect(result).toMatchObject({ action: 'patch', success: true });
  });

  it('sets autoQuarantineEnabled true when the checkbox is present', async () => {
    mockedPatch.mockResolvedValue({});
    await actions.patch(formEvent({ autoQuarantineEnabled: 'on' }));
    expect(mockedPatch).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ autoQuarantineEnabled: true })
    );
  });

  it('forwards an API 400 as a fail with the API message', async () => {
    const { AdminApiError } = await import('$lib/server/adminApi');
    mockedPatch.mockRejectedValue(new AdminApiError(400, 'retentionDays must be >= windowDays'));
    const result = (await actions.patch(formEvent({ windowDays: '20' }))) as any;
    expect(result.status).toBe(400);
    expect(result.data.message).toBe('retentionDays must be >= windowDays');
  });
});

describe('admin/[projectId] rotate action', () => {
  it('returns the show-once token', async () => {
    mockedRotate.mockResolvedValue({ project: { id: 'p1', name: 'Proj' }, token: 'new_tok', warning: 'gone' });
    const result = (await actions.rotate(formEvent({}))) as any;
    expect(mockedRotate).toHaveBeenCalledWith('p1');
    expect(result).toMatchObject({ action: 'rotate', token: 'new_tok', warning: 'gone' });
  });
});

describe('admin/[projectId] prune actions', () => {
  it('dry-run returns the preview counts', async () => {
    mockedPrune.mockResolvedValue({ dryRun: true, cutoff: '2026-01-01', runsToDelete: 5, resultsToDelete: 20 });
    const result = (await actions.pruneDryRun(formEvent({}))) as any;
    expect(mockedPrune).toHaveBeenCalledWith('p1', false);
    expect(result).toMatchObject({ action: 'prune', prune: { dryRun: true, runsToDelete: 5 } });
  });

  it('confirm executes the prune', async () => {
    mockedPrune.mockResolvedValue({ dryRun: false, cutoff: '2026-01-01', runsDeleted: 5, resultsDeleted: 20 });
    const result = (await actions.pruneConfirm(formEvent({}))) as any;
    expect(mockedPrune).toHaveBeenCalledWith('p1', true);
    expect(result).toMatchObject({ action: 'prune', prune: { dryRun: false, runsDeleted: 5 } });
  });
});

describe('admin/[projectId] delete action', () => {
  it('rejects when the typed name does not match', async () => {
    const result = (await actions.delete(formEvent({ name: 'Proj', confirmName: 'wrong' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it('deletes and redirects to /admin when the typed name matches', async () => {
    mockedDelete.mockResolvedValue({ success: true, message: 'gone' });
    // The success path throws redirect(303, '/admin'); catch it to inspect.
    const thrown: any = await actions.delete(formEvent({ name: 'Proj', confirmName: 'Proj' })).catch((e) => e);
    expect(mockedDelete).toHaveBeenCalledWith('p1');
    expect(thrown.status).toBe(303);
    expect(thrown.location).toBe('/admin');
  });
});
