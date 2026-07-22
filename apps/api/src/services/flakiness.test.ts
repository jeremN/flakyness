import { describe, it, expect, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  computeFlakiness,
  updateFlakyTests,
  resolveProjectConfig,
  getProjectStats,
  type ResultRow,
  type FlakinessConfig,
  type ProjectFlakinessOverrides,
} from './flakiness';
import { db, projects, testRuns, testResults, flakyTests } from '../db';

describe('Flakiness Detection', () => {
  const defaultConfig: FlakinessConfig = {
    windowDays: 14,
    flakeThreshold: 0.05,
    minRuns: 3,
  };

  /** Build a ResultRow with sane defaults, only overriding what a case cares about. */
  function row(overrides: Partial<ResultRow> & Pick<ResultRow, 'testName' | 'status'>): ResultRow {
    return {
      testFile: 'test.spec.ts',
      createdAt: new Date(),
      ...overrides,
    };
  }

  /** Shorthand: n rows with the same name/status. */
  function rows(n: number, testName: string, status: string, testFile?: string): ResultRow[] {
    return Array.from({ length: n }, () => row({ testName, status, ...(testFile ? { testFile } : {}) }));
  }

  describe('computeFlakiness', () => {
    it('should identify consistently passing tests as not flaky', () => {
      const result = computeFlakiness(rows(10, 'test-1', 'passed'), defaultConfig);

      expect(result).toHaveLength(1);
      expect(result[0].testName).toBe('test-1');
      expect(result[0].isFlaky).toBe(false);
      expect(result[0].flakeRate).toBe(0);
    });

    it('should count tests with ONLY failed runs (never passed) toward flakiness', () => {
      // Documented formula: (failed + flaky) / total. A 100%-failing test is
      // above threshold, so it is reported as flaky — assert current behavior,
      // don't "fix" it here.
      const result = computeFlakiness(rows(10, 'broken-test', 'failed'), defaultConfig);

      expect(result).toHaveLength(1);
      expect(result[0].flakeRate).toBe(1);
      expect(result[0].isFlaky).toBe(true);
    });

    it('should identify tests with mixed results as flaky', () => {
      const results = [
        ...rows(7, 'flaky-test', 'passed'),
        ...rows(3, 'flaky-test', 'failed'),
      ];

      const result = computeFlakiness(results, defaultConfig);

      expect(result).toHaveLength(1);
      expect(result[0].testName).toBe('flaky-test');
      expect(result[0].isFlaky).toBe(true);
      expect(result[0].flakeRate).toBe(0.3); // 3/10
    });

    it('should count explicit flaky status in flake rate', () => {
      const results = [
        ...rows(8, 'test-with-retries', 'passed'),
        ...rows(2, 'test-with-retries', 'flaky'), // failed then passed on retry
      ];

      const result = computeFlakiness(results, defaultConfig);

      expect(result[0].flakeRate).toBe(0.2); // 2/10
      expect(result[0].isFlaky).toBe(true);
    });

    it('should skip tests with insufficient runs', () => {
      const results = [
        row({ testName: 'new-test', status: 'passed' }),
        row({ testName: 'new-test', status: 'failed' }),
      ];

      const result = computeFlakiness(results, defaultConfig);

      expect(result).toHaveLength(0);
    });

    it('should respect custom threshold', () => {
      const results = [
        ...rows(19, 'slightly-flaky', 'passed'),
        ...rows(1, 'slightly-flaky', 'failed'),
      ];

      // With 5% threshold, 1/20 = 5% is at threshold
      const resultDefault = computeFlakiness(results, { ...defaultConfig, flakeThreshold: 0.05 });
      expect(resultDefault[0].isFlaky).toBe(true);

      // With 10% threshold, 5% is not flaky
      const resultHigher = computeFlakiness(results, { ...defaultConfig, flakeThreshold: 0.10 });
      expect(resultHigher[0].isFlaky).toBe(false);
    });

    it('should sort by flake rate descending', () => {
      const results = [
        ...rows(9, 'low-flaky', 'passed', 'a.spec.ts'),
        ...rows(1, 'low-flaky', 'failed', 'a.spec.ts'),
        ...rows(5, 'high-flaky', 'passed', 'b.spec.ts'),
        ...rows(5, 'high-flaky', 'failed', 'b.spec.ts'),
        ...rows(7, 'medium-flaky', 'passed', 'c.spec.ts'),
        ...rows(3, 'medium-flaky', 'failed', 'c.spec.ts'),
      ];

      const result = computeFlakiness(results, defaultConfig);

      expect(result[0].testName).toBe('high-flaky');
      expect(result[1].testName).toBe('medium-flaky');
      expect(result[2].testName).toBe('low-flaky');
    });

    it('should handle empty input', () => {
      const result = computeFlakiness([], defaultConfig);
      expect(result).toHaveLength(0);
    });

    it('should correctly calculate flake rate with all three status types', () => {
      const results = [
        ...rows(5, 'mixed-status', 'passed'),
        ...rows(3, 'mixed-status', 'failed'),
        ...rows(2, 'mixed-status', 'flaky'),
      ];

      const result = computeFlakiness(results, defaultConfig);

      expect(result[0].totalRuns).toBe(10);
      expect(result[0].flakeRate).toBe(0.5); // (3 + 2) / 10
    });

    it('should respect minRuns configuration', () => {
      const results = [
        ...rows(3, 'test-a', 'passed'),
        ...rows(2, 'test-a', 'failed'),
      ];

      // With minRuns:3, 5 total runs qualifies
      const resultLow = computeFlakiness(results, { ...defaultConfig, minRuns: 3 });
      expect(resultLow).toHaveLength(1);

      // With minRuns:10, 5 total runs doesn't qualify
      const resultHigh = computeFlakiness(results, { ...defaultConfig, minRuns: 10 });
      expect(resultHigh).toHaveLength(0);
    });

    it('should accumulate mixed statuses per test name independently', () => {
      const results = [
        ...rows(4, 'test-a', 'passed'),
        ...rows(1, 'test-a', 'failed'),
        ...rows(3, 'test-b', 'passed'),
        ...rows(2, 'test-b', 'flaky'),
      ];

      const result = computeFlakiness(results, defaultConfig);
      const byName = new Map(result.map((r) => [r.testName, r]));

      const testA = byName.get('test-a')!;
      expect(testA.passCount).toBe(4);
      expect(testA.failCount).toBe(1);
      expect(testA.flakyCount).toBe(0);
      expect(testA.totalRuns).toBe(5);

      const testB = byName.get('test-b')!;
      expect(testB.passCount).toBe(3);
      expect(testB.failCount).toBe(0);
      expect(testB.flakyCount).toBe(2);
      expect(testB.totalRuns).toBe(5);
    });

    it('should set lastSeen to the max createdAt per test', () => {
      const oldest = new Date('2026-01-01T00:00:00Z');
      const middle = new Date('2026-01-05T00:00:00Z');
      const newest = new Date('2026-01-10T00:00:00Z');

      // Deliberately not in chronological order.
      const results = [
        row({ testName: 'test-a', status: 'passed', createdAt: middle }),
        row({ testName: 'test-a', status: 'passed', createdAt: oldest }),
        row({ testName: 'test-a', status: 'failed', createdAt: newest }),
      ];

      const result = computeFlakiness(results, { ...defaultConfig, minRuns: 1 });

      expect(result[0].lastSeen).toEqual(newest);
    });

    it('falls back to empty string when a result has no testFile', () => {
      const result = computeFlakiness(
        [
          { testName: 't', status: 'failed', testFile: null, createdAt: new Date() },
          { testName: 't', status: 'passed', testFile: null, createdAt: new Date() },
          { testName: 't', status: 'passed', testFile: null, createdAt: new Date() },
        ],
        defaultConfig
      );
      expect(result[0].testFile).toBe('');
    });

    it('reports the most recent createdAt as lastSeen regardless of input order', () => {
      const older = new Date('2026-01-01T00:00:00Z');
      const newer = new Date('2026-02-01T00:00:00Z');
      const result = computeFlakiness(
        [
          { testName: 't', status: 'passed', testFile: 's.ts', createdAt: newer },
          { testName: 't', status: 'failed', testFile: 's.ts', createdAt: older },
          { testName: 't', status: 'passed', testFile: 's.ts', createdAt: older },
        ],
        defaultConfig
      );
      expect(result[0].lastSeen.toISOString()).toBe(newer.toISOString());
    });
  });

  describe('resolveProjectConfig', () => {
    const allNull: ProjectFlakinessOverrides = {
      flakeThreshold: null,
      windowDays: null,
      minRuns: null,
    };

    it('falls back to DEFAULT_CONFIG when all overrides are null', () => {
      expect(resolveProjectConfig(allNull)).toEqual(defaultConfig);
    });

    it('converts a decimal-string flakeThreshold to a number exactly once', () => {
      const result = resolveProjectConfig({ ...allNull, flakeThreshold: '0.2000' });
      expect(result.flakeThreshold).toBe(0.2);
      expect(typeof result.flakeThreshold).toBe('number');
    });

    it('applies a partial override, leaving unset fields at their default', () => {
      const result = resolveProjectConfig({ ...allNull, windowDays: 30 });
      expect(result).toEqual({ ...defaultConfig, windowDays: 30 });
    });

    it('applies overrides for all three fields simultaneously', () => {
      const result = resolveProjectConfig({
        flakeThreshold: '0.9000',
        windowDays: 7,
        minRuns: 10,
      });
      expect(result).toEqual({ flakeThreshold: 0.9, windowDays: 7, minRuns: 10 });
    });
  });
});

// DB-gated integration tests for the updateFlakyTests state machine.
// This suite seeds rows directly with drizzle (it tests the service, not the
// routes), so it only needs DATABASE_URL — no admin API involved.
const hasDatabase = !!process.env.DATABASE_URL;
const describeWithDb = hasDatabase ? describe : describe.skip;

// Shared DB-test helpers/state, used by both the `updateFlakyTests` and
// `getProjectStats` describeWithDb blocks below. A single tracked-id list and
// afterAll cover cascade cleanup for every project seeded by either block.
const createdProjectIds: string[] = [];

async function seedProject(label: string): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({
      name: `flakiness-test-${label}-${Date.now()}`,
      tokenHash: '0'.repeat(64),
    })
    .returning({ id: projects.id });
  createdProjectIds.push(project.id);
  return project.id;
}

async function seedRun(
  projectId: string,
  results: Array<{ testName: string; status: string }>
): Promise<string> {
  const [run] = await db
    .insert(testRuns)
    .values({
      projectId,
      branch: 'main',
      commitSha: 'a'.repeat(40),
      totalTests: results.length,
    })
    .returning({ id: testRuns.id });
  await db.insert(testResults).values(
    results.map((r) => ({
      testRunId: run.id,
      testName: r.testName,
      testFile: 'suite.spec.ts',
      status: r.status,
    }))
  );
  return run.id;
}

function repeat(n: number, testName: string, status: string) {
  return Array.from({ length: n }, () => ({ testName, status }));
}

async function getFlakyRow(projectId: string, testName: string) {
  return db.query.flakyTests.findFirst({
    where: and(eq(flakyTests.projectId, projectId), eq(flakyTests.testName, testName)),
  });
}

afterAll(async () => {
  if (createdProjectIds.length > 0) {
    // FK cascades remove test_runs, test_results and flaky_tests children.
    await db.delete(projects).where(inArray(projects.id, createdProjectIds));
  }
});

describeWithDb('updateFlakyTests', () => {
  it('creates an active row with firstDetected and correct stats for a new flaky test', async () => {
    const projectId = await seedProject('new-flaky');
    await seedRun(projectId, [
      ...repeat(2, 'test-a', 'passed'),
      ...repeat(2, 'test-a', 'failed'),
    ]);

    const result = await updateFlakyTests(projectId);

    expect(result).toEqual({ updated: 1, resolved: 0, newlyFlaky: ['test-a'], newlyResolved: [] });

    const row = await getFlakyRow(projectId, 'test-a');
    expect(row).toBeDefined();
    expect(row!.testName).toBe('test-a');
    expect(row!.status).toBe('active');
    expect(row!.firstDetected).not.toBeNull();
    expect(row!.flakeCount).toBe(2);
    expect(row!.totalRuns).toBe(4);
    expect(row!.flakeRate).toBe('0.5000');
  });

  it('sums failCount and flakyCount into the persisted flakeCount', async () => {
    const projectId = await seedProject('flakecount-sum');
    await seedRun(projectId, [
      ...repeat(2, 'test-a', 'passed'),
      ...repeat(1, 'test-a', 'failed'),
      ...repeat(2, 'test-a', 'flaky'),
    ]);
    await updateFlakyTests(projectId);
    const row = await getFlakyRow(projectId, 'test-a');
    expect(row!.flakeCount).toBe(3); // 1 failed + 2 flaky — kills failCount - flakyCount
    expect(row!.totalRuns).toBe(5);
  });

  it('preserves firstDetected and updates stats on subsequent calls (conflict path)', async () => {
    const projectId = await seedProject('conflict-path');
    await seedRun(projectId, [
      ...repeat(2, 'test-a', 'passed'),
      ...repeat(2, 'test-a', 'failed'),
    ]);

    await updateFlakyTests(projectId);
    const first = await getFlakyRow(projectId, 'test-a');
    expect(first!.firstDetected).not.toBeNull();

    // New data arrives; the test is still flaky.
    await seedRun(projectId, [
      ...repeat(1, 'test-a', 'failed'),
    ]);

    const result = await updateFlakyTests(projectId);
    // Still flaky on this second call (prior status 'active') — not a
    // transition, so it must NOT appear in newlyFlaky.
    expect(result).toEqual({ updated: 1, resolved: 0, newlyFlaky: [], newlyResolved: [] });

    const second = await getFlakyRow(projectId, 'test-a');
    expect(second!.firstDetected!.toISOString()).toBe(first!.firstDetected!.toISOString());
    expect(second!.flakeCount).toBe(3);
    expect(second!.totalRuns).toBe(5);
    expect(second!.flakeRate).toBe('0.6000');
  });

  it('resolves an active row when the test drops below the flake threshold on new data', async () => {
    const projectId = await seedProject('below-threshold');
    await seedRun(projectId, [
      ...repeat(3, 'test-a', 'passed'),
      ...repeat(1, 'test-a', 'failed'),
    ]);

    await updateFlakyTests(projectId);
    const active = await getFlakyRow(projectId, 'test-a');
    expect(active!.status).toBe('active');

    // 20 more passes: 1 fail / 24 total ≈ 0.0417 < 0.05 → no longer flaky.
    await seedRun(projectId, repeat(20, 'test-a', 'passed'));

    const result = await updateFlakyTests(projectId);
    expect(result.resolved).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.newlyResolved).toEqual(['test-a']);
    expect(result.newlyFlaky).toEqual([]);

    const resolved = await getFlakyRow(projectId, 'test-a');
    expect(resolved!.status).toBe('resolved');
  });

  it('resolves an active row when the test disappears from analysis entirely', async () => {
    const projectId = await seedProject('disappeared');
    const runId = await seedRun(projectId, [
      ...repeat(2, 'test-a', 'passed'),
      ...repeat(2, 'test-a', 'failed'),
    ]);

    await updateFlakyTests(projectId);
    const active = await getFlakyRow(projectId, 'test-a');
    expect(active!.status).toBe('active');

    // Simulate the test being removed from the suite: its results vanish,
    // while another (stable) test keeps the analysis non-empty.
    await db.delete(testResults).where(eq(testResults.testRunId, runId));
    await seedRun(projectId, repeat(3, 'test-b', 'passed'));

    const result = await updateFlakyTests(projectId);
    expect(result).toEqual({ updated: 0, resolved: 1, newlyFlaky: [], newlyResolved: ['test-a'] });

    const resolved = await getFlakyRow(projectId, 'test-a');
    expect(resolved!.status).toBe('resolved');
  });

  it('preserves ignored status while refreshing stats when the test is still flaky', async () => {
    const projectId = await seedProject('ignored');
    await seedRun(projectId, [
      ...repeat(2, 'test-a', 'passed'),
      ...repeat(2, 'test-a', 'failed'),
    ]);

    await updateFlakyTests(projectId);
    await db
      .update(flakyTests)
      .set({ status: 'ignored' })
      .where(eq(flakyTests.projectId, projectId));

    // New data arrives; the test is still flaky.
    await seedRun(projectId, [
      ...repeat(1, 'test-a', 'failed'),
    ]);

    const result = await updateFlakyTests(projectId);
    // Ignored is a mute, not a transition: the test keeps meeting the
    // threshold but must not appear in newlyFlaky (or newlyResolved).
    expect(result).toEqual({ updated: 1, resolved: 0, newlyFlaky: [], newlyResolved: [] });

    const row = await getFlakyRow(projectId, 'test-a');
    expect(row!.status).toBe('ignored');
    expect(row!.flakeCount).toBe(3);
    expect(row!.totalRuns).toBe(5);
    expect(row!.flakeRate).toBe('0.6000');
  });

  it('leaves an ignored row ignored (not resolved) when its test disappears from analysis', async () => {
    const projectId = await seedProject('ignored-disappeared');
    const runId = await seedRun(projectId, [
      ...repeat(2, 'test-a', 'passed'),
      ...repeat(2, 'test-a', 'failed'),
    ]);

    await updateFlakyTests(projectId);
    await db
      .update(flakyTests)
      .set({ status: 'ignored' })
      .where(and(eq(flakyTests.projectId, projectId), eq(flakyTests.testName, 'test-a')));

    // Simulate the test being removed from the suite: its results vanish,
    // while another (stable) test keeps the analysis non-empty.
    await db.delete(testResults).where(eq(testResults.testRunId, runId));
    await seedRun(projectId, repeat(3, 'test-b', 'passed'));

    const result = await updateFlakyTests(projectId);
    expect(result).toEqual({ updated: 0, resolved: 0, newlyFlaky: [], newlyResolved: [] });

    const row = await getFlakyRow(projectId, 'test-a');
    expect(row!.status).toBe('ignored');
  });

  it('batches upserts for a large number of flaky tests in a single call', async () => {
    const projectId = await seedProject('batch-upsert');
    const testNames = Array.from({ length: 25 }, (_, i) => `batch-test-${i}`);
    for (const testName of testNames) {
      await seedRun(projectId, [
        ...repeat(2, testName, 'passed'),
        ...repeat(2, testName, 'failed'),
      ]);
    }

    const result = await updateFlakyTests(projectId);
    expect(result.updated).toBe(25);
    expect(result.resolved).toBe(0);
    expect(new Set(result.newlyFlaky)).toEqual(new Set(testNames));
    expect(result.newlyResolved).toEqual([]);

    for (const testName of testNames) {
      const row = await getFlakyRow(projectId, testName);
      expect(row).toBeDefined();
      expect(row!.status).toBe('active');
    }
  });

  it('reconciles a mix of flaky, cleaned-up, and disappeared tests in one call', async () => {
    const projectId = await seedProject('mixed-reconcile');
    const runId = await seedRun(projectId, [
      // 3 flaky tests
      ...repeat(2, 'flaky-1', 'passed'),
      ...repeat(2, 'flaky-1', 'failed'),
      ...repeat(2, 'flaky-2', 'passed'),
      ...repeat(2, 'flaky-2', 'failed'),
      ...repeat(2, 'flaky-3', 'passed'),
      ...repeat(2, 'flaky-3', 'failed'),
      // 2 tests that will later become clean
      ...repeat(2, 'clean-later-1', 'passed'),
      ...repeat(2, 'clean-later-1', 'failed'),
      ...repeat(2, 'clean-later-2', 'passed'),
      ...repeat(2, 'clean-later-2', 'failed'),
      // 1 test that will later disappear entirely
      ...repeat(2, 'vanish-later', 'passed'),
      ...repeat(2, 'vanish-later', 'failed'),
    ]);

    const firstResult = await updateFlakyTests(projectId);
    expect(firstResult.updated).toBe(6);
    expect(firstResult.resolved).toBe(0);
    expect(new Set(firstResult.newlyFlaky)).toEqual(
      new Set(['flaky-1', 'flaky-2', 'flaky-3', 'clean-later-1', 'clean-later-2', 'vanish-later'])
    );
    expect(firstResult.newlyResolved).toEqual([]);

    // Clean up two tests (lots of passing runs), and remove one entirely.
    await seedRun(projectId, [
      ...repeat(20, 'clean-later-1', 'passed'),
      ...repeat(20, 'clean-later-2', 'passed'),
      ...repeat(2, 'flaky-1', 'passed'),
      ...repeat(2, 'flaky-1', 'failed'),
      ...repeat(2, 'flaky-2', 'passed'),
      ...repeat(2, 'flaky-2', 'failed'),
      ...repeat(2, 'flaky-3', 'passed'),
      ...repeat(2, 'flaky-3', 'failed'),
    ]);
    await db.delete(testResults).where(eq(testResults.testRunId, runId));

    const result = await updateFlakyTests(projectId);
    expect(result.updated).toBe(3);
    expect(result.resolved).toBe(3);
    // The three flaky-* tests were already active from the first call, so
    // this reconciliation isn't a transition for them.
    expect(result.newlyFlaky).toEqual([]);
    expect(new Set(result.newlyResolved)).toEqual(
      new Set(['clean-later-1', 'clean-later-2', 'vanish-later'])
    );

    for (const testName of ['flaky-1', 'flaky-2', 'flaky-3']) {
      const row = await getFlakyRow(projectId, testName);
      expect(row!.status).toBe('active');
    }
    for (const testName of ['clean-later-1', 'clean-later-2', 'vanish-later']) {
      const row = await getFlakyRow(projectId, testName);
      expect(row!.status).toBe('resolved');
    }
  });

  it('honors a per-call flakeThreshold override (project-config threading)', async () => {
    const projectId = await seedProject('threshold-override');
    // 10% failure rate: 9 passed, 1 failed out of 10 runs.
    await seedRun(projectId, [
      ...repeat(9, 'test-a', 'passed'),
      ...repeat(1, 'test-a', 'failed'),
    ]);

    // A stricter (higher) threshold than the 10% flake rate: not flaky.
    const lenient = await updateFlakyTests(projectId, { flakeThreshold: 0.5 });
    expect(lenient).toEqual({ updated: 0, resolved: 0, newlyFlaky: [], newlyResolved: [] });
    expect(await getFlakyRow(projectId, 'test-a')).toBeUndefined();

    // A looser (lower) threshold than the 10% flake rate: flaky.
    const strict = await updateFlakyTests(projectId, { flakeThreshold: 0.05 });
    expect(strict).toEqual({ updated: 1, resolved: 0, newlyFlaky: ['test-a'], newlyResolved: [] });
    const row = await getFlakyRow(projectId, 'test-a');
    expect(row!.status).toBe('active');
  });

  it('flags a test as newly flaky again after a resolved→flaky re-activation', async () => {
    const projectId = await seedProject('resolved-reactivation');

    // First call: test-a is flaky (1/4 = 25%) → active, and a transition.
    await seedRun(projectId, [
      ...repeat(3, 'test-a', 'passed'),
      ...repeat(1, 'test-a', 'failed'),
    ]);
    const first = await updateFlakyTests(projectId);
    expect(first.newlyFlaky).toEqual(['test-a']);

    // Second call: enough clean passes push it below threshold (1/24 ≈ 4.2%
    // < 5%) → resolved.
    await seedRun(projectId, repeat(20, 'test-a', 'passed'));
    const second = await updateFlakyTests(projectId);
    expect(second.newlyResolved).toEqual(['test-a']);
    const resolved = await getFlakyRow(projectId, 'test-a');
    expect(resolved!.status).toBe('resolved');

    // Third call: more failures push it back above threshold (4/27 ≈ 14.8%)
    // — a resolved→flaky re-activation, which must be reported as newly
    // flaky (not silently treated as "already tracked").
    await seedRun(projectId, repeat(3, 'test-a', 'failed'));
    const third = await updateFlakyTests(projectId);
    expect(third).toEqual({ updated: 1, resolved: 0, newlyFlaky: ['test-a'], newlyResolved: [] });
    const reactivated = await getFlakyRow(projectId, 'test-a');
    expect(reactivated!.status).toBe('active');
  });
});

describeWithDb('getProjectStats', () => {
  it('returns null for a project that does not exist', async () => {
    expect(await getProjectStats('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('counts active flaky tests, resolved-this-week, and run totals', async () => {
    const projectId = await seedProject('stats');
    await seedRun(projectId, [...repeat(3, 'x', 'passed')]); // 1 run, totalTests 3
    const base = { projectId, testFile: 's.ts', flakeCount: 1, totalRuns: 3, flakeRate: '0.3300' };
    await db.insert(flakyTests).values([
      { ...base, testName: 'a', status: 'active', firstDetected: new Date(), lastSeen: new Date() },
      { ...base, testName: 'b', status: 'active', firstDetected: new Date(), lastSeen: new Date() },
      { ...base, testName: 'c', status: 'resolved', firstDetected: new Date(), lastSeen: new Date() },
      { ...base, testName: 'd', status: 'resolved', firstDetected: new Date(),
        lastSeen: new Date(Date.now() - 30 * 864e5) }, // outside the 7-day window
    ]);
    const stats = await getProjectStats(projectId);
    expect(stats!.activeFlakyTests).toBe(2);   // kills status='active'→'' and count(*)→''
    expect(stats!.resolvedThisWeek).toBe(1);    // kills the -7→+7 window flip and status='resolved'
    expect(stats!.totalRuns).toBe(1);
    expect(stats!.totalTests).toBe(3);          // kills the select({}) mutant
  });
});
