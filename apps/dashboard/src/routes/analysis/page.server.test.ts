import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project, AnalysisResponse } from '../../app.d';

vi.mock('$lib/api', () => ({
  getAnalysis: vi.fn(),
}));

import { getAnalysis } from '$lib/api';
import { load } from './+page.server';

const project: Project = { id: 'p1', name: 'Project A', createdAt: '2024-01-01' };

const analysis: AnalysisResponse = {
  windowDays: 30,
  threshold: 0.1,
  flakyTests: [],
  allTests: [
    {
      testName: 'flaky test',
      testFile: 'foo.test.ts',
      totalRuns: 10,
      passCount: 7,
      failCount: 1,
      flakyCount: 2,
      flakeRate: 0.2,
      isFlaky: true,
      lastSeen: '2024-01-02',
    },
  ],
};

const mockedGetAnalysis = vi.mocked(getAnalysis);

beforeEach(() => {
  mockedGetAnalysis.mockReset();
});

function makeEvent(selectedProject: Project | null, searchParams = '') {
  return {
    url: new URL(`http://x/analysis${searchParams}`),
    parent: async () => ({ selectedProject }),
  } as any;
}

describe('routes/analysis/+page.server load', () => {
  it('uses default days=14, threshold=0.05 when no params are given', async () => {
    mockedGetAnalysis.mockResolvedValue(analysis);

    const result = await load(makeEvent(project));

    expect(mockedGetAnalysis).toHaveBeenCalledWith('p1', 14, 0.05);
    expect(result.days).toBe(14);
    expect(result.threshold).toBe(0.05);
    expect(result.analysis).toEqual(analysis);
    expect(result.currentProject).toEqual(project);
  });

  it('parses days and threshold from the URL search params', async () => {
    mockedGetAnalysis.mockResolvedValue(analysis);

    const result = await load(makeEvent(project, '?days=30&threshold=0.1'));

    expect(mockedGetAnalysis).toHaveBeenCalledWith('p1', 30, 0.1);
    expect(result.days).toBe(30);
    expect(result.threshold).toBe(0.1);
  });

  it('clamps days above 90 down to 90', async () => {
    mockedGetAnalysis.mockResolvedValue(analysis);

    const result = await load(makeEvent(project, '?days=500'));

    expect(result.days).toBe(90);
    expect(mockedGetAnalysis).toHaveBeenCalledWith('p1', 90, 0.05);
  });

  it('clamps days below 1 up to 1', async () => {
    mockedGetAnalysis.mockResolvedValue(analysis);

    const result = await load(makeEvent(project, '?days=-5'));

    expect(result.days).toBe(1);
    expect(mockedGetAnalysis).toHaveBeenCalledWith('p1', 1, 0.05);
  });

  it('falls back to 14 when days is garbage (e.g. "abc")', async () => {
    mockedGetAnalysis.mockResolvedValue(analysis);

    const result = await load(makeEvent(project, '?days=abc'));

    expect(result.days).toBe(14);
    expect(mockedGetAnalysis).toHaveBeenCalledWith('p1', 14, 0.05);
  });

  it('clamps threshold above 1 down to 1', async () => {
    mockedGetAnalysis.mockResolvedValue(analysis);

    const result = await load(makeEvent(project, '?threshold=5'));

    expect(result.threshold).toBe(1);
    expect(mockedGetAnalysis).toHaveBeenCalledWith('p1', 14, 1);
  });

  it('clamps threshold below 0 up to 0', async () => {
    mockedGetAnalysis.mockResolvedValue(analysis);

    const result = await load(makeEvent(project, '?threshold=-0.5'));

    expect(result.threshold).toBe(0);
    expect(mockedGetAnalysis).toHaveBeenCalledWith('p1', 14, 0);
  });

  it('falls back to 0.05 when threshold is garbage (e.g. "xyz")', async () => {
    mockedGetAnalysis.mockResolvedValue(analysis);

    const result = await load(makeEvent(project, '?threshold=xyz'));

    expect(result.threshold).toBe(0.05);
    expect(mockedGetAnalysis).toHaveBeenCalledWith('p1', 14, 0.05);
  });

  it('returns a null analysis and skips the fetch when there is no selected project', async () => {
    const result = await load(makeEvent(null, '?days=30&threshold=0.1'));

    expect(result.analysis).toBeNull();
    expect(result.currentProject).toBeNull();
    expect(result.days).toBe(30);
    expect(result.threshold).toBe(0.1);
    expect(mockedGetAnalysis).not.toHaveBeenCalled();
  });
});
