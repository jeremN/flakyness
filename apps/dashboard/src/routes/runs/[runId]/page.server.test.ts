import { describe, it, expect, vi, beforeEach } from 'vitest';
import { error } from '@sveltejs/kit';
import type { Project, RunDetail } from '../../../app.d';

vi.mock('$lib/server/api', () => ({
  getRunDetail: vi.fn(),
}));

import { getRunDetail } from '$lib/server/api';
import { load } from './+page.server';

const project: Project = { id: 'p1', name: 'Project One', createdAt: '2024-01-01' };

const runDetail: RunDetail = {
  run: {
    id: 'run-1',
    branch: 'main',
    commitSha: 'abc123def456',
    pipelineId: '42',
    startedAt: '2026-07-01T10:00:00.000Z',
    finishedAt: '2026-07-01T10:05:00.000Z',
    totalTests: 3,
    passed: 1,
    failed: 1,
    skipped: 0,
    flaky: 1,
    createdAt: '2026-07-01T10:00:00.000Z',
  },
  results: [
    { testName: 'fails consistently', testFile: 'a.spec.ts', status: 'failed', durationMs: 50, retryCount: 0, errorMessage: 'boom', tags: [], annotations: [], failureDetail: null },
    { testName: 'flakes on retry', testFile: 'a.spec.ts', status: 'flaky', durationMs: 85, retryCount: 1, errorMessage: null, tags: [], annotations: [], failureDetail: null },
  ],
  truncated: false,
};

const mockedGetRunDetail = vi.mocked(getRunDetail);

beforeEach(() => {
  mockedGetRunDetail.mockReset();
});

// `error(...)` from '@sveltejs/kit' throws immediately (it never returns —
// see its `@return {never}` contract) rather than returning an HttpError for
// the caller to throw, so building a rejection value out of it means
// catching that throw ourselves.
function makeHttpError(status: number, message: string): unknown {
  try {
    error(status, message);
  } catch (e) {
    return e;
  }
  throw new Error('unreachable: error() did not throw');
}

function makeEvent(selectedProject: Project | null, searchParams = '') {
  return {
    parent: async () => ({ selectedProject }),
    params: { runId: 'run-1' },
    url: new URL(`http://x/runs/run-1${searchParams}`),
  };
}

describe('routes/runs/[runId]/+page.server load', () => {
  it('returns an empty, non-failed shape when no project is selected', async () => {
    const result = await load(makeEvent(null));

    expect(result).toEqual({ runDetail: null, projectId: null, statusFilter: null, loadFailed: false });
    expect(mockedGetRunDetail).not.toHaveBeenCalled();
  });

  it('loads run detail with no status filter by default (failures-first)', async () => {
    mockedGetRunDetail.mockResolvedValue(runDetail);

    const result = await load(makeEvent(project));

    expect(mockedGetRunDetail).toHaveBeenCalledWith('p1', 'run-1', undefined);
    expect(result).toEqual({
      runDetail,
      projectId: 'p1',
      statusFilter: null,
      loadFailed: false,
    });
  });

  it('passes ?status=all through to getRunDetail', async () => {
    mockedGetRunDetail.mockResolvedValue(runDetail);

    const result = await load(makeEvent(project, '?status=all'));

    expect(mockedGetRunDetail).toHaveBeenCalledWith('p1', 'run-1', 'all');
    expect(result.statusFilter).toBe('all');
  });

  it('degrades gracefully to loadFailed:true on a non-404 API error', async () => {
    mockedGetRunDetail.mockRejectedValue(new Error('network down'));

    const result = await load(makeEvent(project));

    expect(result.runDetail).toBeNull();
    expect(result.loadFailed).toBe(true);
  });

  it('rethrows a 404 HttpError instead of degrading to loadFailed, so +error.svelte renders it', async () => {
    mockedGetRunDetail.mockRejectedValue(makeHttpError(404, 'Run not found'));

    await expect(load(makeEvent(project))).rejects.toMatchObject({ status: 404 });
  });

  it('does not rethrow a non-404 HttpError (e.g. a 502) — it still degrades to loadFailed', async () => {
    mockedGetRunDetail.mockRejectedValue(makeHttpError(502, 'Bad gateway'));

    const result = await load(makeEvent(project));

    expect(result.runDetail).toBeNull();
    expect(result.loadFailed).toBe(true);
  });
});
