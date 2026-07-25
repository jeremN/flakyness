import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/adminApi', () => ({
  listProjects: vi.fn(),
  listRules: vi.fn(),
  createRule: vi.fn(),
  patchRule: vi.fn(),
  deleteRule: vi.fn(),
  reorderRules: vi.fn(),
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

import {
  listRules, createRule, patchRule, deleteRule, reorderRules, adminConfigured,
} from '$lib/server/adminApi';
import { load, actions } from './+page.server';

const mockedListRules = vi.mocked(listRules);
const mockedCreate = vi.mocked(createRule);
const mockedPatch = vi.mocked(patchRule);
const mockedDelete = vi.mocked(deleteRule);
const mockedReorder = vi.mocked(reorderRules);
const mockedAdminConfigured = vi.mocked(adminConfigured);

const project = { id: 'p1', name: 'Proj', stats: { totalRuns: 0, activeFlakyTests: 0 } } as any;
const ruleRow = (id: string, position: number) => ({ id, position }) as any;

function formEvent(fields: Record<string, string>, id = 'p1') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return { request: { formData: async () => fd }, params: { projectId: id } } as any;
}

// A parent() stub returning the root layout's public project list. `load` reads
// projects from here (not an admin call) — see +page.server.ts.
const parentWith = (projects: unknown[], apiError: string | null = null) =>
  (async () => ({ projects, apiError })) as any;

beforeEach(() => {
  mockedListRules.mockReset();
  mockedCreate.mockReset();
  mockedPatch.mockReset();
  mockedDelete.mockReset();
  mockedReorder.mockReset();
  mockedAdminConfigured.mockReturnValue(true);
});

describe('rules load', () => {
  it('returns the project (from the parent public list) and its rules', async () => {
    mockedListRules.mockResolvedValue({ rules: [ruleRow('r1', 0)] });
    const result = await load({ params: { projectId: 'p1' }, parent: parentWith([project]) } as any);
    expect(result).toEqual({ project, rules: [ruleRow('r1', 0)] });
  });

  it('403s when ADMIN_TOKEN is not configured, before touching parent()', async () => {
    mockedAdminConfigured.mockReturnValueOnce(false);
    const parent = vi.fn();
    await expect(load({ params: { projectId: 'p1' }, parent } as any)).rejects.toMatchObject({ status: 403 });
    expect(parent).not.toHaveBeenCalled();
  });

  it('404s when the project is not in the parent list (and never fetches rules)', async () => {
    await expect(
      load({ params: { projectId: 'nope' }, parent: parentWith([project]) } as any)
    ).rejects.toMatchObject({ status: 404 });
    expect(mockedListRules).not.toHaveBeenCalled();
  });

  it('forwards an AdminApiError status from the rules fetch', async () => {
    const { AdminApiError } = await import('$lib/server/adminApi');
    mockedListRules.mockRejectedValue(new AdminApiError(503, 'API down'));
    await expect(
      load({ params: { projectId: 'p1' }, parent: parentWith([project]) } as any)
    ).rejects.toMatchObject({ status: 503 });
  });

  it('surfaces the parent apiError as a 502 rather than a misleading 404', async () => {
    // An unreachable public API leaves parent().projects empty; without the
    // apiError guard the missing project would 404 (claiming it does not exist)
    // instead of reporting the outage.
    await expect(
      load({ params: { projectId: 'p1' }, parent: parentWith([], 'Cannot reach the Flackyness API.') } as any)
    ).rejects.toMatchObject({ status: 502 });
    expect(mockedListRules).not.toHaveBeenCalled();
  });
});

describe('create action', () => {
  it('rejects an invalid rule before calling the API', async () => {
    const result = (await actions.create(formEvent({ action: 'exempt', conditionType: 'flake_rate' }))) as any;
    expect(result.status).toBe(400);
    expect(result.data.errors.action).toBeTruthy();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('builds the payload and creates on valid input', async () => {
    mockedCreate.mockResolvedValue({ rule: {} as any });
    const result = (await actions.create(
      formEvent({ action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: '0.3', selectorBranch: 'main', enabled: 'on' })
    )) as any;
    expect(mockedCreate).toHaveBeenCalledWith('p1', expect.objectContaining({
      action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: 0.3, selectorBranch: 'main', enabled: true,
    }));
    expect(result).toMatchObject({ action: 'create', success: true });
  });

  it('forwards an API 400 as a fail with the API message', async () => {
    const { AdminApiError } = await import('$lib/server/adminApi');
    mockedCreate.mockRejectedValue(new AdminApiError(400, 'flake_rate needs flakeThreshold'));
    const result = (await actions.create(
      formEvent({ action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: '0.3' })
    )) as any;
    expect(result.status).toBe(400);
    expect(result.data.message).toBe('flake_rate needs flakeThreshold');
  });

  it('maps a MissingAdminTokenError from the API to a 403 fail', async () => {
    const { MissingAdminTokenError } = await import('$lib/server/adminApi');
    const err = new MissingAdminTokenError();
    mockedCreate.mockRejectedValue(err);
    const result = (await actions.create(
      formEvent({ action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: '0.3' })
    )) as any;
    expect(result.status).toBe(403);
    expect(result.data).toMatchObject({ action: 'create', message: err.message });
  });

  it('403s up front when ADMIN_TOKEN is not configured, without calling the API', async () => {
    mockedAdminConfigured.mockReturnValueOnce(false);
    const result = (await actions.create(
      formEvent({ action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: '0.3' })
    )) as any;
    expect(result.status).toBe(403);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});

describe('update action', () => {
  it('fails when ruleId is missing', async () => {
    const result = (await actions.update(formEvent({ action: 'exempt' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('patches the rule with the built payload', async () => {
    mockedPatch.mockResolvedValue({ rule: {} as any });
    await actions.update(formEvent({ ruleId: 'r1', action: 'exempt' }));
    expect(mockedPatch).toHaveBeenCalledWith('p1', 'r1', expect.objectContaining({ action: 'exempt', conditionType: null }));
  });

  it('rejects an invalid rule before calling the API', async () => {
    const result = (await actions.update(
      formEvent({ ruleId: 'r1', action: 'exempt', conditionType: 'flake_rate' })
    )) as any;
    expect(result.status).toBe(400);
    expect(result.data.errors).toBeTruthy();
    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('forwards an API error as a fail with the API message', async () => {
    const { AdminApiError } = await import('$lib/server/adminApi');
    mockedPatch.mockRejectedValue(new AdminApiError(400, 'flake_rate needs flakeThreshold'));
    const result = (await actions.update(
      formEvent({ ruleId: 'r1', action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: '0.3' })
    )) as any;
    expect(result.status).toBe(400);
    expect(result.data.message).toBe('flake_rate needs flakeThreshold');
  });

  it('403s up front when ADMIN_TOKEN is not configured, without calling the API', async () => {
    mockedAdminConfigured.mockReturnValueOnce(false);
    const result = (await actions.update(formEvent({ ruleId: 'r1', action: 'exempt' }))) as any;
    expect(result.status).toBe(403);
    expect(mockedPatch).not.toHaveBeenCalled();
  });
});

describe('toggle action', () => {
  it('patches only the enabled flag to the requested value', async () => {
    mockedPatch.mockResolvedValue({ rule: {} as any });
    await actions.toggle(formEvent({ ruleId: 'r1', enabled: 'false' }));
    expect(mockedPatch).toHaveBeenCalledWith('p1', 'r1', { enabled: false });
  });

  it('fails when ruleId is missing', async () => {
    const result = (await actions.toggle(formEvent({ enabled: 'true' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('forwards an API error as a fail with the API message', async () => {
    const { AdminApiError } = await import('$lib/server/adminApi');
    mockedPatch.mockRejectedValue(new AdminApiError(409, 'conflict'));
    const result = (await actions.toggle(formEvent({ ruleId: 'r1', enabled: 'true' }))) as any;
    expect(result.status).toBe(409);
    expect(result.data.message).toBe('conflict');
  });

  it('403s up front when ADMIN_TOKEN is not configured, without calling the API', async () => {
    mockedAdminConfigured.mockReturnValueOnce(false);
    const result = (await actions.toggle(formEvent({ ruleId: 'r1', enabled: 'true' }))) as any;
    expect(result.status).toBe(403);
    expect(mockedPatch).not.toHaveBeenCalled();
  });
});

describe('delete action', () => {
  it('deletes the rule by id', async () => {
    mockedDelete.mockResolvedValue({ success: true });
    const result = (await actions.delete(formEvent({ ruleId: 'r1' }))) as any;
    expect(mockedDelete).toHaveBeenCalledWith('p1', 'r1');
    expect(result).toMatchObject({ action: 'delete', success: true });
  });

  it('fails when ruleId is missing', async () => {
    const result = (await actions.delete(formEvent({}))) as any;
    expect(result.status).toBe(400);
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it('forwards an API error as a fail with the API message', async () => {
    const { AdminApiError } = await import('$lib/server/adminApi');
    mockedDelete.mockRejectedValue(new AdminApiError(409, 'in use'));
    const result = (await actions.delete(formEvent({ ruleId: 'r1' }))) as any;
    expect(result.status).toBe(409);
    expect(result.data.message).toBe('in use');
  });

  it('maps a non-AdminApiError throw to a generic 502', async () => {
    mockedDelete.mockRejectedValue(new Error('boom'));
    const result = (await actions.delete(formEvent({ ruleId: 'r1' }))) as any;
    expect(result.status).toBe(502);
  });

  it('403s up front when ADMIN_TOKEN is not configured, without calling the API', async () => {
    mockedAdminConfigured.mockReturnValueOnce(false);
    const result = (await actions.delete(formEvent({ ruleId: 'r1' }))) as any;
    expect(result.status).toBe(403);
    expect(mockedDelete).not.toHaveBeenCalled();
  });
});

describe('reorder action', () => {
  it('re-fetches the current order, swaps up, and posts the full set', async () => {
    mockedListRules.mockResolvedValue({ rules: [ruleRow('r1', 0), ruleRow('r2', 1)] });
    mockedReorder.mockResolvedValue({ success: true });
    await actions.reorder(formEvent({ ruleId: 'r2', direction: 'up' }));
    expect(mockedReorder).toHaveBeenCalledWith('p1', ['r2', 'r1']);
  });

  it('is a guarded no-op at the top (no API call)', async () => {
    mockedListRules.mockResolvedValue({ rules: [ruleRow('r1', 0), ruleRow('r2', 1)] });
    const result = (await actions.reorder(formEvent({ ruleId: 'r1', direction: 'up' }))) as any;
    expect(mockedReorder).not.toHaveBeenCalled();
    expect(result).toMatchObject({ action: 'reorder', success: true });
  });

  it('re-fetches the current order, swaps down, and posts the full set', async () => {
    mockedListRules.mockResolvedValue({ rules: [ruleRow('r1', 0), ruleRow('r2', 1)] });
    mockedReorder.mockResolvedValue({ success: true });
    await actions.reorder(formEvent({ ruleId: 'r1', direction: 'down' }));
    expect(mockedReorder).toHaveBeenCalledWith('p1', ['r2', 'r1']);
  });

  it('is a guarded no-op at the bottom (no API call)', async () => {
    mockedListRules.mockResolvedValue({ rules: [ruleRow('r1', 0), ruleRow('r2', 1)] });
    const result = (await actions.reorder(formEvent({ ruleId: 'r2', direction: 'down' }))) as any;
    expect(mockedReorder).not.toHaveBeenCalled();
    expect(result).toMatchObject({ action: 'reorder', success: true });
  });

  it('rejects a bad direction', async () => {
    const result = (await actions.reorder(formEvent({ ruleId: 'r1', direction: 'sideways' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedListRules).not.toHaveBeenCalled();
  });

  it('fails when the rule id is not in the current order', async () => {
    mockedListRules.mockResolvedValue({ rules: [ruleRow('r1', 0), ruleRow('r2', 1)] });
    const result = (await actions.reorder(formEvent({ ruleId: 'missing', direction: 'up' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedReorder).not.toHaveBeenCalled();
  });

  it('forwards an AdminApiError from the re-fetch as a fail', async () => {
    const { AdminApiError } = await import('$lib/server/adminApi');
    mockedListRules.mockRejectedValue(new AdminApiError(503, 'API down'));
    const result = (await actions.reorder(formEvent({ ruleId: 'r1', direction: 'up' }))) as any;
    expect(result.status).toBe(503);
    expect(mockedReorder).not.toHaveBeenCalled();
  });

  it('forwards an AdminApiError from the reorder call itself as a fail', async () => {
    const { AdminApiError } = await import('$lib/server/adminApi');
    mockedListRules.mockResolvedValue({ rules: [ruleRow('r1', 0), ruleRow('r2', 1)] });
    mockedReorder.mockRejectedValue(new AdminApiError(500, 'db down'));
    const result = (await actions.reorder(formEvent({ ruleId: 'r2', direction: 'up' }))) as any;
    expect(result.status).toBe(500);
  });

  it('403s up front when ADMIN_TOKEN is not configured, without calling the API', async () => {
    mockedAdminConfigured.mockReturnValueOnce(false);
    const result = (await actions.reorder(formEvent({ ruleId: 'r1', direction: 'up' }))) as any;
    expect(result.status).toBe(403);
    expect(mockedReorder).not.toHaveBeenCalled();
  });
});
