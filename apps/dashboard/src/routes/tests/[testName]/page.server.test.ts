import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TestHistory, TestTrend } from '../../../app.d';

vi.mock('$lib/server/api', () => ({
  getTestHistory: vi.fn(),
  getTestTrend: vi.fn(),
}));

import { getTestHistory, getTestTrend } from '$lib/server/api';
import { load } from './+page.server';

const testHistory: TestHistory = {
  testName: 'flaky test',
  flakyInfo: null,
  stats: { totalRuns: 5, passed: 4, failed: 1, flaky: 0, skipped: 0, avgDuration: 100 },
  history: [],
};

const testTrend: TestTrend = {
  testName: 'flaky test',
  projectId: 'p1',
  days: 30,
  direction: 'worsening',
  trend: [
    { date: '2026-07-12', totalRuns: 0, failed: 0, flaky: 0, flakeRate: null },
    { date: '2026-07-13', totalRuns: 4, failed: 1, flaky: 1, flakeRate: 0.5 },
  ],
};

const mockedGetTestHistory = vi.mocked(getTestHistory);
const mockedGetTestTrend = vi.mocked(getTestTrend);

beforeEach(() => {
  mockedGetTestHistory.mockReset();
  mockedGetTestTrend.mockReset();
});

function makeEvent(searchParams = '?project=p1') {
  return {
    params: { testName: 'flaky test' },
    url: new URL(`http://x/tests/flaky%20test${searchParams}`),
  } as any;
}

describe('routes/tests/[testName]/+page.server load', () => {
  it('loads history and trend together, with the default 30-day window', async () => {
    mockedGetTestHistory.mockResolvedValue(testHistory);
    mockedGetTestTrend.mockResolvedValue(testTrend);

    const result = await load(makeEvent());

    expect(mockedGetTestHistory).toHaveBeenCalledWith('flaky test', 'p1');
    expect(mockedGetTestTrend).toHaveBeenCalledWith('flaky test', 'p1', 30);
    expect(result).toEqual({
      testHistory,
      testTrend,
      trendFailed: false,
      projectId: 'p1',
    });
  });

  it('parses days from the URL and clamps above 90 down to 90', async () => {
    mockedGetTestHistory.mockResolvedValue(testHistory);
    mockedGetTestTrend.mockResolvedValue(testTrend);

    await load(makeEvent('?project=p1&days=500'));

    expect(mockedGetTestTrend).toHaveBeenCalledWith('flaky test', 'p1', 90);
  });

  it('clamps days below 1 up to 1', async () => {
    mockedGetTestHistory.mockResolvedValue(testHistory);
    mockedGetTestTrend.mockResolvedValue(testTrend);

    await load(makeEvent('?project=p1&days=-5'));

    expect(mockedGetTestTrend).toHaveBeenCalledWith('flaky test', 'p1', 1);
  });

  it('falls back to the default 30 when days is garbage ("abc"), not an empty trend', async () => {
    mockedGetTestHistory.mockResolvedValue(testHistory);
    mockedGetTestTrend.mockResolvedValue(testTrend);

    await load(makeEvent('?project=p1&days=abc'));

    expect(mockedGetTestTrend).toHaveBeenCalledWith('flaky test', 'p1', 30);
  });

  it('degrades gracefully when getTestTrend rejects: testTrend is null, trendFailed is true, history still returned', async () => {
    mockedGetTestHistory.mockResolvedValue(testHistory);
    mockedGetTestTrend.mockRejectedValue(new Error('trend down'));

    const result = await load(makeEvent());

    expect(result.testHistory).toEqual(testHistory);
    expect(result.testTrend).toBeNull();
    expect(result.trendFailed).toBe(true);
  });

  it('throws a 400 when the project query parameter is missing', async () => {
    await expect(load(makeEvent(''))).rejects.toMatchObject({ status: 400 });
    expect(mockedGetTestHistory).not.toHaveBeenCalled();
    expect(mockedGetTestTrend).not.toHaveBeenCalled();
  });
});
