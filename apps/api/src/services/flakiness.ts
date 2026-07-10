import { eq, and, gte, sql, desc, inArray } from 'drizzle-orm';
import { db, testResults, testRuns, flakyTests, projects } from '../db';

export interface FlakinessConfig {
  /** Number of days to look back for analysis */
  windowDays: number;
  /** Minimum flake rate (0-1) to consider a test flaky */
  flakeThreshold: number;
  /** Minimum number of runs required for analysis */
  minRuns: number;
}

const DEFAULT_CONFIG: FlakinessConfig = {
  windowDays: 14,
  flakeThreshold: 0.05, // 5% flake rate
  minRuns: 3,
};

export interface TestFlakiness {
  testName: string;
  testFile: string;
  totalRuns: number;
  passCount: number;
  failCount: number;
  flakyCount: number;
  flakeRate: number;
  isFlaky: boolean;
  lastSeen: Date;
}

export interface ResultRow {
  testName: string;
  testFile: string | null;
  status: string;
  createdAt: Date;
}

/**
 * Pure in-memory aggregation: group raw test result rows by test name and
 * compute flakiness stats for each. No I/O.
 *
 * A test is considered flaky if:
 * 1. It has been run at least `minRuns` times
 * 2. It has a flake rate above `flakeThreshold`
 *
 * Flake rate = (failed + flaky runs) / total runs
 */
export function computeFlakiness(
  results: ResultRow[],
  config: FlakinessConfig
): TestFlakiness[] {
  const { flakeThreshold, minRuns } = config;

  // Group by test name and calculate stats
  const testStats = new Map<string, {
    testFile: string;
    passCount: number;
    failCount: number;
    flakyCount: number;
    lastSeen: Date;
  }>();

  for (const result of results) {
    const key = result.testName;
    const existing = testStats.get(key) || {
      testFile: result.testFile || '',
      passCount: 0,
      failCount: 0,
      flakyCount: 0,
      lastSeen: result.createdAt,
    };

    switch (result.status) {
      case 'passed':
        existing.passCount++;
        break;
      case 'failed':
        existing.failCount++;
        break;
      case 'flaky':
        existing.flakyCount++;
        break;
    }

    // Update last seen if this result is more recent
    if (result.createdAt > existing.lastSeen) {
      existing.lastSeen = result.createdAt;
    }

    testStats.set(key, existing);
  }

  // Calculate flakiness for each test
  const flakiness: TestFlakiness[] = [];

  for (const [testName, stats] of testStats) {
    const totalRuns = stats.passCount + stats.failCount + stats.flakyCount;

    // Skip tests with insufficient runs
    if (totalRuns < minRuns) {
      continue;
    }

    // Flake rate = (failures + explicit flaky) / total
    const flakeRate = (stats.failCount + stats.flakyCount) / totalRuns;
    const isFlaky = flakeRate >= flakeThreshold;

    flakiness.push({
      testName,
      testFile: stats.testFile,
      totalRuns,
      passCount: stats.passCount,
      failCount: stats.failCount,
      flakyCount: stats.flakyCount,
      flakeRate,
      isFlaky,
      lastSeen: stats.lastSeen,
    });
  }

  // Sort by flake rate (highest first)
  flakiness.sort((a, b) => b.flakeRate - a.flakeRate);

  return flakiness;
}

/**
 * Analyze test results for a project and detect flaky tests.
 *
 * Runs the DB query for the time window, then delegates the pure
 * aggregation to `computeFlakiness`.
 */
export async function analyzeFlakiness(
  projectId: string,
  config: Partial<FlakinessConfig> = {}
): Promise<TestFlakiness[]> {
  const { windowDays, flakeThreshold, minRuns } = { ...DEFAULT_CONFIG, ...config };

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - windowDays);

  // Get all test results for this project within the time window
  const results = await db
    .select({
      testName: testResults.testName,
      testFile: testResults.testFile,
      status: testResults.status,
      createdAt: testResults.createdAt,
    })
    .from(testResults)
    .innerJoin(testRuns, eq(testResults.testRunId, testRuns.id))
    .where(
      and(
        eq(testRuns.projectId, projectId),
        gte(testResults.createdAt, cutoffDate)
      )
    )
    .orderBy(desc(testResults.createdAt));

  return computeFlakiness(results, { windowDays, flakeThreshold, minRuns });
}

// Postgres bind-param limit forces chunking multi-row statements; matches
// BATCH_SIZE in apps/api/src/routes/reports.ts.
const BATCH_SIZE = 1000;

/** Split an array into consecutive chunks of at most `size` elements. */
function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Update the flaky_tests table based on current analysis.
 * This should be called after ingesting a new report.
 */
export async function updateFlakyTests(
  projectId: string,
  config: Partial<FlakinessConfig> = {}
): Promise<{ updated: number; resolved: number }> {
  const analysis = await analyzeFlakiness(projectId, config);

  // Get existing flaky tests for this project
  const existingFlaky = await db.query.flakyTests.findMany({
    where: eq(flakyTests.projectId, projectId),
  });

  // Rows to upsert: every currently-flaky test.
  const flakyRows = analysis
    .filter(test => test.isFlaky)
    .map(test => ({
      projectId,
      testName: test.testName,
      testFile: test.testFile,
      firstDetected: new Date(),
      lastSeen: test.lastSeen,
      flakeCount: test.failCount + test.flakyCount,
      totalRuns: test.totalRuns,
      flakeRate: test.flakeRate.toFixed(4),
      status: 'active',
    }));

  // Ids to resolve: active rows that are (a) analyzed but no longer flaky, or
  // (b) absent from the analysis entirely. Built from a Map lookup (not
  // analysis.find() inside a filter) to stay O(n) on large projects.
  const isFlakyByName = new Map(analysis.map(test => [test.testName, test.isFlaky]));
  const resolveIds = existingFlaky
    .filter(existing => existing.status === 'active')
    .filter(existing => !(isFlakyByName.get(existing.testName) ?? false))
    .map(existing => existing.id);

  if (flakyRows.length > 0 || resolveIds.length > 0) {
    await db.transaction(async (tx) => {
      for (const chunk of chunks(flakyRows, BATCH_SIZE)) {
        // Atomic upsert keyed on the (project_id, test_name) unique index —
        // avoids the read-then-write race that let concurrent ingests insert
        // duplicates. firstDetected is only set on insert; the conflict path
        // never overwrites it. status preserves 'ignored' across refreshes —
        // an operator-muted test doesn't get silently un-muted by the next
        // ingest — and otherwise (re)activates the row.
        await tx
          .insert(flakyTests)
          .values(chunk)
          .onConflictDoUpdate({
            target: [flakyTests.projectId, flakyTests.testName],
            set: {
              testFile: sql`excluded.test_file`,
              lastSeen: sql`excluded.last_seen`,
              flakeCount: sql`excluded.flake_count`,
              totalRuns: sql`excluded.total_runs`,
              flakeRate: sql`excluded.flake_rate`,
              status: sql`CASE WHEN ${flakyTests.status} = 'ignored' THEN 'ignored' ELSE 'active' END`,
            },
          });
      }

      for (const chunk of chunks(resolveIds, BATCH_SIZE)) {
        await tx
          .update(flakyTests)
          .set({ status: 'resolved' })
          .where(inArray(flakyTests.id, chunk));
      }
    });
  }

  return { updated: flakyRows.length, resolved: resolveIds.length };
}

/**
 * Get flaky test statistics for a project
 */
export async function getProjectStats(projectId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    return null;
  }

  // Count active flaky tests
  const [flakyCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(flakyTests)
    .where(
      and(
        eq(flakyTests.projectId, projectId),
        eq(flakyTests.status, 'active')
      )
    );

  // Count resolved flaky tests (in last 7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const [resolvedCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(flakyTests)
    .where(
      and(
        eq(flakyTests.projectId, projectId),
        eq(flakyTests.status, 'resolved'),
        gte(flakyTests.lastSeen, sevenDaysAgo)
      )
    );

  // Get total test runs
  const [runStats] = await db
    .select({
      totalRuns: sql<number>`count(*)`,
      totalTests: sql<number>`sum(${testRuns.totalTests})`,
    })
    .from(testRuns)
    .where(eq(testRuns.projectId, projectId));

  return {
    project: {
      id: project.id,
      name: project.name,
    },
    activeFlakyTests: Number(flakyCount?.count ?? 0),
    resolvedThisWeek: Number(resolvedCount?.count ?? 0),
    totalRuns: Number(runStats?.totalRuns ?? 0),
    totalTests: Number(runStats?.totalTests ?? 0),
  };
}
