import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project, ProjectStats, FlakyTest, TestRun } from '../app.d';

vi.mock('$lib/api', () => ({
  getProjectStats: vi.fn(),
  getFlakyTests: vi.fn(),
  getProjectRuns: vi.fn(),
  getFlakeTrend: vi.fn(),
}));

import { getProjectStats, getFlakyTests, getProjectRuns, getFlakeTrend } from '$lib/api';
import { load } from './+page.server';

const project: Project = { id: 'p1', name: 'Project A', createdAt: '2024-01-01' };

const stats: ProjectStats = {
  project: { id: 'p1', name: 'Project A' },
  activeFlakyTests: 2,
  resolvedThisWeek: 1,
  totalRuns: 10,
  totalTests: 20,
};

const flakyTests: FlakyTest[] = [
  {
    id: 'f1',
    testName: 'flaky test',
    testFile: 'foo.test.ts',
    firstDetected: '2024-01-01',
    lastSeen: '2024-01-02',
    flakeCount: 3,
    totalRuns: 10,
    flakeRate: '0.3',
    status: 'active',
  },
];

const recentRuns: TestRun[] = [
  {
    id: 'r1',
    branch: 'main',
    commitSha: 'abc1234',
    pipelineId: null,
    startedAt: null,
    finishedAt: null,
    totalTests: 10,
    passed: 9,
    failed: 1,
    skipped: 0,
    flaky: 1,
    createdAt: '2024-01-01',
  },
];

const trendData = { days: ['2024-01-01'], rates: [0.1] };

const mockedGetProjectStats = vi.mocked(getProjectStats);
const mockedGetFlakyTests = vi.mocked(getFlakyTests);
const mockedGetProjectRuns = vi.mocked(getProjectRuns);
const mockedGetFlakeTrend = vi.mocked(getFlakeTrend);

beforeEach(() => {
  mockedGetProjectStats.mockReset();
  mockedGetFlakyTests.mockReset();
  mockedGetProjectRuns.mockReset();
  mockedGetFlakeTrend.mockReset();
});

function makeEvent(selectedProject: Project | null) {
  return { parent: async () => ({ selectedProject }) } as any;
}

describe('routes/+page.server load', () => {
  it('returns the full shape with partialFailure: false when all calls resolve', async () => {
    mockedGetProjectStats.mockResolvedValue(stats);
    mockedGetFlakyTests.mockResolvedValue(flakyTests);
    mockedGetProjectRuns.mockResolvedValue(recentRuns);
    mockedGetFlakeTrend.mockResolvedValue(trendData);

    const result = await load(makeEvent(project));

    expect(result).toEqual({
      stats,
      flakyTests,
      recentRuns,
      trendData,
      partialFailure: false,
    });
  });

  it('degrades only the trend widget when getFlakeTrend rejects', async () => {
    mockedGetProjectStats.mockResolvedValue(stats);
    mockedGetFlakyTests.mockResolvedValue(flakyTests);
    mockedGetProjectRuns.mockResolvedValue(recentRuns);
    mockedGetFlakeTrend.mockRejectedValue(new Error('trend down'));

    const result = await load(makeEvent(project));

    expect(result.stats).toEqual(stats);
    expect(result.flakyTests).toEqual(flakyTests);
    expect(result.recentRuns).toEqual(recentRuns);
    expect(result.trendData).toBeNull();
    expect(result.partialFailure).toBe(true);
  });

  it('returns the empty shape when the parent gives no selected project', async () => {
    const result = await load(makeEvent(null));

    expect(result).toEqual({
      stats: null,
      flakyTests: [],
      recentRuns: [],
      trendData: null,
    });
    expect(mockedGetProjectStats).not.toHaveBeenCalled();
  });
});
