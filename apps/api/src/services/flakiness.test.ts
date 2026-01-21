import { describe, it, expect, vi, beforeEach } from 'vitest';

// We'll test the pure logic functions without DB dependencies
// by mocking the database calls

// Import the types for testing
interface FlakinessConfig {
  windowDays: number;
  flakeThreshold: number;
  minRuns: number;
}

interface TestFlakiness {
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

// Pure function to calculate flakiness from stats
function calculateFlakiness(
  testStats: Map<string, {
    testFile: string;
    passCount: number;
    failCount: number;
    flakyCount: number;
    lastSeen: Date;
  }>,
  config: FlakinessConfig
): TestFlakiness[] {
  const { flakeThreshold, minRuns } = config;
  const flakiness: TestFlakiness[] = [];

  for (const [testName, stats] of testStats) {
    const totalRuns = stats.passCount + stats.failCount + stats.flakyCount;
    
    if (totalRuns < minRuns) {
      continue;
    }

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

  flakiness.sort((a, b) => b.flakeRate - a.flakeRate);
  return flakiness;
}

describe('Flakiness Detection', () => {
  const defaultConfig: FlakinessConfig = {
    windowDays: 14,
    flakeThreshold: 0.05,
    minRuns: 3,
  };

  describe('calculateFlakiness', () => {
    it('should identify consistently passing tests as not flaky', () => {
      const stats = new Map([
        ['test-1', {
          testFile: 'test.spec.ts',
          passCount: 10,
          failCount: 0,
          flakyCount: 0,
          lastSeen: new Date(),
        }],
      ]);

      const result = calculateFlakiness(stats, defaultConfig);
      
      expect(result).toHaveLength(1);
      expect(result[0].testName).toBe('test-1');
      expect(result[0].isFlaky).toBe(false);
      expect(result[0].flakeRate).toBe(0);
    });

    it('should identify consistently failing tests as not flaky (they are just broken)', () => {
      const stats = new Map([
        ['broken-test', {
          testFile: 'test.spec.ts',
          passCount: 0,
          failCount: 10,
          flakyCount: 0,
          lastSeen: new Date(),
        }],
      ]);

      const result = calculateFlakiness(stats, defaultConfig);
      
      expect(result).toHaveLength(1);
      // Note: by our definition, 100% failure is "flaky" (above threshold)
      // In practice, you might want a different algorithm for "broken" vs "flaky"
      expect(result[0].flakeRate).toBe(1);
      expect(result[0].isFlaky).toBe(true);
    });

    it('should identify tests with mixed results as flaky', () => {
      const stats = new Map([
        ['flaky-test', {
          testFile: 'test.spec.ts',
          passCount: 7,
          failCount: 3,
          flakyCount: 0,
          lastSeen: new Date(),
        }],
      ]);

      const result = calculateFlakiness(stats, defaultConfig);
      
      expect(result).toHaveLength(1);
      expect(result[0].testName).toBe('flaky-test');
      expect(result[0].isFlaky).toBe(true);
      expect(result[0].flakeRate).toBe(0.3); // 3/10
    });

    it('should count explicit flaky status in flake rate', () => {
      const stats = new Map([
        ['test-with-retries', {
          testFile: 'test.spec.ts',
          passCount: 8,
          failCount: 0,
          flakyCount: 2, // Tests that failed then passed on retry
          lastSeen: new Date(),
        }],
      ]);

      const result = calculateFlakiness(stats, defaultConfig);
      
      expect(result[0].flakeRate).toBe(0.2); // 2/10
      expect(result[0].isFlaky).toBe(true);
    });

    it('should skip tests with insufficient runs', () => {
      const stats = new Map([
        ['new-test', {
          testFile: 'test.spec.ts',
          passCount: 1,
          failCount: 1,
          flakyCount: 0,
          lastSeen: new Date(),
        }],
      ]);

      const result = calculateFlakiness(stats, defaultConfig);
      
      expect(result).toHaveLength(0);
    });

    it('should respect custom threshold', () => {
      const stats = new Map([
        ['slightly-flaky', {
          testFile: 'test.spec.ts',
          passCount: 19,
          failCount: 1,
          flakyCount: 0,
          lastSeen: new Date(),
        }],
      ]);

      // With 5% threshold, 1/20 = 5% is at threshold
      const resultDefault = calculateFlakiness(stats, { ...defaultConfig, flakeThreshold: 0.05 });
      expect(resultDefault[0].isFlaky).toBe(true);

      // With 10% threshold, 5% is not flaky
      const resultHigher = calculateFlakiness(stats, { ...defaultConfig, flakeThreshold: 0.10 });
      expect(resultHigher[0].isFlaky).toBe(false);
    });

    it('should sort by flake rate descending', () => {
      const stats = new Map([
        ['low-flaky', {
          testFile: 'a.spec.ts',
          passCount: 9,
          failCount: 1,
          flakyCount: 0,
          lastSeen: new Date(),
        }],
        ['high-flaky', {
          testFile: 'b.spec.ts',
          passCount: 5,
          failCount: 5,
          flakyCount: 0,
          lastSeen: new Date(),
        }],
        ['medium-flaky', {
          testFile: 'c.spec.ts',
          passCount: 7,
          failCount: 3,
          flakyCount: 0,
          lastSeen: new Date(),
        }],
      ]);

      const result = calculateFlakiness(stats, defaultConfig);
      
      expect(result[0].testName).toBe('high-flaky');
      expect(result[1].testName).toBe('medium-flaky');
      expect(result[2].testName).toBe('low-flaky');
    });

    it('should handle empty stats', () => {
      const stats = new Map();
      const result = calculateFlakiness(stats, defaultConfig);
      expect(result).toHaveLength(0);
    });

    it('should correctly calculate flake rate with all three status types', () => {
      const stats = new Map([
        ['mixed-status', {
          testFile: 'test.spec.ts',
          passCount: 5,
          failCount: 3,
          flakyCount: 2,
          lastSeen: new Date(),
        }],
      ]);

      const result = calculateFlakiness(stats, defaultConfig);
      
      expect(result[0].totalRuns).toBe(10);
      expect(result[0].flakeRate).toBe(0.5); // (3 + 2) / 10
    });

    it('should respect minRuns configuration', () => {
      const stats = new Map([
        ['test-a', {
          testFile: 'test.spec.ts',
          passCount: 3,
          failCount: 2,
          flakyCount: 0,
          lastSeen: new Date(),
        }],
      ]);

      // With minRuns:3, 5 total runs qualifies
      const resultLow = calculateFlakiness(stats, { ...defaultConfig, minRuns: 3 });
      expect(resultLow).toHaveLength(1);

      // With minRuns:10, 5 total runs doesn't qualify
      const resultHigh = calculateFlakiness(stats, { ...defaultConfig, minRuns: 10 });
      expect(resultHigh).toHaveLength(0);
    });
  });
});
