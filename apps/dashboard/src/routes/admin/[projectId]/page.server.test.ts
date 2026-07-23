import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/adminApi', () => ({
  listProjects: vi.fn(),
  patchProject: vi.fn(),
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

import { listProjects, patchProject } from '$lib/server/adminApi';
import { load, actions } from './+page.server';

const mockedList = vi.mocked(listProjects);
const mockedPatch = vi.mocked(patchProject);

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
