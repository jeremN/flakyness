import { eq, and, gte, sql, desc } from 'drizzle-orm';
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

/**
 * Analyze test results for a project and detect flaky tests.
 * 
 * A test is considered flaky if:
 * 1. It has been run at least `minRuns` times
 * 2. It has a flake rate above `flakeThreshold`
 * 
 * Flake rate = (failed + flaky runs) / total runs
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
 * Update the flaky_tests table based on current analysis.
 * This should be called after ingesting a new report.
 */
export async function updateFlakyTests(
  projectId: string,
  config: Partial<FlakinessConfig> = {}
): Promise<{ updated: number; resolved: number }> {
  const analysis = await analyzeFlakiness(projectId, config);
  
  let updated = 0;
  let resolved = 0;

  // Get existing flaky tests for this project
  const existingFlaky = await db.query.flakyTests.findMany({
    where: eq(flakyTests.projectId, projectId),
  });

  const existingMap = new Map(existingFlaky.map(f => [f.testName, f]));

  // Track which existing flaky tests were seen in the analysis
  const seenTestNames = new Set<string>();

  for (const test of analysis) {
    seenTestNames.add(test.testName);
    const existing = existingMap.get(test.testName);

    if (test.isFlaky) {
      if (existing) {
        // Update existing flaky test
        await db
          .update(flakyTests)
          .set({
            lastSeen: test.lastSeen,
            flakeCount: test.failCount + test.flakyCount,
            totalRuns: test.totalRuns,
            flakeRate: test.flakeRate.toFixed(4),
            status: 'active',
          })
          .where(eq(flakyTests.id, existing.id));
        updated++;
      } else {
        // Insert new flaky test
        await db.insert(flakyTests).values({
          projectId,
          testName: test.testName,
          testFile: test.testFile,
          firstDetected: new Date(),
          lastSeen: test.lastSeen,
          flakeCount: test.failCount + test.flakyCount,
          totalRuns: test.totalRuns,
          flakeRate: test.flakeRate.toFixed(4),
          status: 'active',
        });
        updated++;
      }
    } else if (existing && existing.status === 'active') {
      // Test is no longer flaky - mark as resolved
      await db
        .update(flakyTests)
        .set({ status: 'resolved' })
        .where(eq(flakyTests.id, existing.id));
      resolved++;
    }
  }

  // Resolve active flaky tests that no longer appear in analysis results
  // (e.g., test was removed from the test suite or renamed)
  for (const [testName, existing] of existingMap) {
    if (existing.status === 'active' && !seenTestNames.has(testName)) {
      await db
        .update(flakyTests)
        .set({ status: 'resolved' })
        .where(eq(flakyTests.id, existing.id));
      resolved++;
    }
  }

  return { updated, resolved };
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
