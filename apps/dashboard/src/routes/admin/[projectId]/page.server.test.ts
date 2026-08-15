import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/adminApi', () => ({
  createAdminApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {
    statusCode: number;
    constructor(status: number, message: string) {
      super(message);
      this.statusCode = status;
    }
  },
  NotAuthenticatedError: class NotAuthenticatedError extends Error {
    constructor() {
      super('Not signed in.');
    }
  },
}));

import { createAdminApi, AdminApiError, NotAuthenticatedError } from '$lib/server/adminApi';
import { load, actions } from './+page.server';

const mockedList = vi.fn();
const mockedPatch = vi.fn();
const mockedRotate = vi.fn();
const mockedPrune = vi.fn();
const mockedDelete = vi.fn();

vi.mocked(createAdminApi).mockReturnValue({
  listProjects: mockedList,
  patchProject: mockedPatch,
  rotateToken: mockedRotate,
  pruneProject: mockedPrune,
  deleteProject: mockedDelete,
} as unknown as ReturnType<typeof createAdminApi>);

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

function formEvent(
  fields: Record<string, string>,
  id = 'p1',
  sessionToken: string | null = 'sess-1',
  clientIp: string | null = null
) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return {
    request: { formData: async () => fd },
    params: { projectId: id },
    locals: { sessionToken, clientIp },
  } as any;
}

function loadEvent(projectId: string, sessionToken: string | null = 'sess-1', clientIp: string | null = null) {
  return { params: { projectId }, locals: { sessionToken, clientIp } } as any;
}

beforeEach(() => {
  mockedList.mockReset();
  mockedPatch.mockReset();
  mockedRotate.mockReset();
  mockedPrune.mockReset();
  mockedDelete.mockReset();
  // Clears createAdminApi's own call history (mockReturnValue survives
  // mockClear), so an identity assertion below only sees this test's own
  // call — see the task-2b review's finding on flaky/page.server.test.ts for
  // why an un-cleared factory mock can make an argument-swap assertion
  // vacuous.
  vi.mocked(createAdminApi).mockClear();
});

describe('admin/[projectId] load', () => {
  it('returns the matching project', async () => {
    mockedList.mockResolvedValue({ projects: [project] });
    const result = await load(loadEvent('p1'));
    expect(result).toEqual({ project });
  });

  it('404s when the project id is not in the list', async () => {
    mockedList.mockResolvedValue({ projects: [project] });
    await expect(load(loadEvent('nope'))).rejects.toMatchObject({
      status: 404,
    });
  });

  it('maps NotAuthenticatedError to a 403 fail', async () => {
    mockedList.mockRejectedValue(new NotAuthenticatedError());
    await expect(load(loadEvent('p1', null))).rejects.toMatchObject({ status: 403 });
  });

  it('forwards an AdminApiError status when the list call fails', async () => {
    mockedList.mockRejectedValue(new AdminApiError(503, 'API down'));
    await expect(load(loadEvent('p1'))).rejects.toMatchObject({ status: 503 });
  });

  // Distinct, both non-null: an argument swap (createAdminApi(clientIp,
  // sessionToken)) compiles clean since both are `string | null` — only a
  // call-site assertion with two distinguishable values catches it.
  it('builds the admin client from the request session, not a swapped pair', async () => {
    mockedList.mockResolvedValue({ projects: [project] });
    await load(loadEvent('p1', 'sess-1', '203.0.113.7'));
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });
});

describe('admin/[projectId] patch action', () => {
  it('rejects out-of-bounds input before calling the API', async () => {
    const result = (await actions.patch(formEvent({ windowDays: '0' }))) as any;
    expect(result.status).toBe(400);
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
    mockedPatch.mockRejectedValue(new AdminApiError(400, 'retentionDays must be >= windowDays'));
    const result = (await actions.patch(formEvent({ windowDays: '20' }))) as any;
    expect(result.status).toBe(400);
    expect(result.data.message).toBe('retentionDays must be >= windowDays');
  });

  it('maps NotAuthenticatedError to a 403 fail', async () => {
    const err = new NotAuthenticatedError();
    mockedPatch.mockRejectedValue(err);
    const result = (await actions.patch(formEvent({ windowDays: '20' }, 'p1', null))) as any;
    expect(result.status).toBe(403);
    expect(result.data.message).toBe(err.message);
  });

  // Distinct, both non-null: an argument swap (createAdminApi(clientIp,
  // sessionToken)) compiles clean since both are `string | null` — only a
  // call-site assertion with two distinguishable values catches it. `load`'s
  // own identity test above only covers `load`'s call site, not this one —
  // each action builds its own client (task-2b review, single-call-site gap).
  it('builds the admin client from the request session, not a swapped pair', async () => {
    mockedPatch.mockResolvedValue({});
    await actions.patch(formEvent({ windowDays: '20' }, 'p1', 'sess-1', '203.0.113.7'));
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });
});

describe('admin/[projectId] rotate action', () => {
  it('returns the show-once token', async () => {
    mockedRotate.mockResolvedValue({ project: { id: 'p1', name: 'Proj' }, token: 'new_tok', warning: 'gone' });
    const result = (await actions.rotate(formEvent({}))) as any;
    expect(mockedRotate).toHaveBeenCalledWith('p1');
    expect(result).toMatchObject({ action: 'rotate', token: 'new_tok', warning: 'gone' });
  });

  // Distinct, both non-null: an argument swap (createAdminApi(clientIp,
  // sessionToken)) compiles clean since both are `string | null` — only a
  // call-site assertion with two distinguishable values catches it.
  it('builds the admin client from the request session, not a swapped pair', async () => {
    mockedRotate.mockResolvedValue({ project: { id: 'p1', name: 'Proj' }, token: 't', warning: 'w' });
    await actions.rotate(formEvent({}, 'p1', 'sess-1', '203.0.113.7'));
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
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

  // pruneDryRun and pruneConfirm are separate call sites in production
  // (each builds its own adminApi); both need their own identity coverage.
  // Distinct, both non-null: an argument swap (createAdminApi(clientIp,
  // sessionToken)) compiles clean since both are `string | null` — only a
  // call-site assertion with two distinguishable values catches it.
  it('pruneDryRun builds the admin client from the request session, not a swapped pair', async () => {
    mockedPrune.mockResolvedValue({ dryRun: true, cutoff: '2026-01-01' });
    await actions.pruneDryRun(formEvent({}, 'p1', 'sess-1', '203.0.113.7'));
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });

  it('pruneConfirm builds the admin client from the request session, not a swapped pair', async () => {
    mockedPrune.mockResolvedValue({ dryRun: false, cutoff: '2026-01-01' });
    await actions.pruneConfirm(formEvent({}, 'p1', 'sess-1', '203.0.113.7'));
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
  });
});

describe('admin/[projectId] delete action', () => {
  it('maps NotAuthenticatedError to a 403 fail', async () => {
    mockedDelete.mockRejectedValue(new NotAuthenticatedError());
    const result = (await actions.delete(formEvent({ name: 'Proj', confirmName: 'Proj' }, 'p1', null))) as any;
    expect(result.status).toBe(403);
  });

  it('rejects when the typed name does not match', async () => {
    const result = (await actions.delete(formEvent({ name: 'Proj', confirmName: 'wrong' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  // Distinct, both non-null: an argument swap (createAdminApi(clientIp,
  // sessionToken)) compiles clean since both are `string | null` — only a
  // call-site assertion with two distinguishable values catches it.
  it('builds the admin client from the request session, not a swapped pair', async () => {
    mockedDelete.mockResolvedValue({ success: true, message: 'gone' });
    await actions.delete(formEvent({ name: 'Proj', confirmName: 'Proj' }, 'p1', 'sess-1', '203.0.113.7')).catch(() => {});
    expect(createAdminApi).toHaveBeenCalledWith('sess-1', '203.0.113.7');
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
