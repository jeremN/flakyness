import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/adminApi', () => ({
  createProject: vi.fn(),
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

import { createProject } from '$lib/server/adminApi';
import { actions } from './+page.server';

const mockedCreate = vi.mocked(createProject);

function formEvent(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return { request: { formData: async () => fd } } as any;
}

// Braced body: mockReset() returns `this` (the mock itself, a function), and
// an arrow with an implicit-return function body would make Vitest treat that
// returned function as a post-test cleanup callback — auto-invoking the mock
// again after each test. For the 409 test below, which leaves the mock
// rejecting, that phantom call raises an uncaught rejection misattributed to
// the test. Braces force `undefined` to be returned instead.
beforeEach(() => {
  mockedCreate.mockReset();
});

describe('admin/new create action', () => {
  it('rejects a blank name with a 400', async () => {
    const result = (await actions.default(formEvent({ name: '   ' }))) as any;
    expect(result.status).toBe(400);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('returns the show-once token on success', async () => {
    mockedCreate.mockResolvedValue({
      project: { id: 'p1', name: 'proj', gitlabProjectId: null, createdAt: 'x' },
      token: 'flk_abc',
      warning: 'Save it.',
    });
    const result = (await actions.default(formEvent({ name: 'proj' }))) as any;
    expect(mockedCreate).toHaveBeenCalledWith({ name: 'proj' });
    expect(result).toMatchObject({ created: true, token: 'flk_abc', warning: 'Save it.', projectName: 'proj' });
  });

  it('passes gitlabProjectId through only when non-empty', async () => {
    mockedCreate.mockResolvedValue({
      project: { id: 'p1', name: 'proj', gitlabProjectId: '42', createdAt: 'x' },
      token: 't',
      warning: 'w',
    });
    await actions.default(formEvent({ name: 'proj', gitlabProjectId: '42' }));
    expect(mockedCreate).toHaveBeenCalledWith({ name: 'proj', gitlabProjectId: '42' });
  });

  it('forwards a duplicate-name 409 as a fail', async () => {
    const { AdminApiError } = await import('$lib/server/adminApi');
    mockedCreate.mockRejectedValue(new AdminApiError(409, 'Project with this name already exists'));
    const result = (await actions.default(formEvent({ name: 'dup' }))) as any;
    expect(result.status).toBe(409);
    expect(result.data.message).toBe('Project with this name already exists');
  });
});
