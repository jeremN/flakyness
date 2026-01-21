import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parsePlaywrightReport, PlaywrightReportSchema } from './playwright';

const sampleReport = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/sample-report.json'), 'utf-8')
);

describe('Playwright Parser', () => {
  describe('PlaywrightReportSchema', () => {
    it('should validate a valid Playwright report', () => {
      const result = PlaywrightReportSchema.safeParse(sampleReport);
      expect(result.success).toBe(true);
    });

    it('should reject invalid report structure', () => {
      const invalidReport = { invalid: 'structure' };
      const result = PlaywrightReportSchema.safeParse(invalidReport);
      expect(result.success).toBe(false);
    });

    it('should reject report without suites', () => {
      const reportWithoutSuites = { config: {} };
      const result = PlaywrightReportSchema.safeParse(reportWithoutSuites);
      expect(result.success).toBe(false);
    });
  });

  describe('parsePlaywrightReport', () => {
    it('should parse sample report correctly', () => {
      const parsed = parsePlaywrightReport(sampleReport);

      expect(parsed.totalTests).toBe(6);
      expect(parsed.passed).toBe(4);
      expect(parsed.failed).toBe(1);
      expect(parsed.flaky).toBe(1);
      expect(parsed.skipped).toBe(0);
    });

    it('should extract test names correctly', () => {
      const parsed = parsePlaywrightReport(sampleReport);
      const testNames = parsed.results.map(r => r.testName);

      expect(testNames).toContain('Login flow › should login with valid credentials');
      expect(testNames).toContain('Dashboard › should filter by date');
      expect(testNames).toContain('Checkout › should complete purchase');
    });

    it('should extract test files correctly', () => {
      const parsed = parsePlaywrightReport(sampleReport);
      const authTest = parsed.results.find(r => r.testName.includes('login with valid'));

      expect(authTest?.testFile).toBe('e2e/auth.spec.ts');
    });

    it('should detect flaky tests (failed then passed on retry)', () => {
      const parsed = parsePlaywrightReport(sampleReport);
      const flakyTest = parsed.results.find(r => r.testName.includes('filter by date'));

      expect(flakyTest?.status).toBe('flaky');
      expect(flakyTest?.retryCount).toBe(1);
    });

    it('should detect failed tests (failed on all retries)', () => {
      const parsed = parsePlaywrightReport(sampleReport);
      const failedTest = parsed.results.find(r => r.testName.includes('complete purchase'));

      expect(failedTest?.status).toBe('failed');
      expect(failedTest?.retryCount).toBe(1);
    });

    it('should extract error messages from failed tests', () => {
      const parsed = parsePlaywrightReport(sampleReport);
      const failedTest = parsed.results.find(r => r.testName.includes('complete purchase'));

      expect(failedTest?.errorMessage).toContain('toBeVisible');
    });

    it('should extract error messages from flaky tests', () => {
      const parsed = parsePlaywrightReport(sampleReport);
      const flakyTest = parsed.results.find(r => r.testName.includes('filter by date'));

      expect(flakyTest?.errorMessage).toContain('Timeout');
    });

    it('should calculate total duration', () => {
      const parsed = parsePlaywrightReport(sampleReport);

      // Sum of all test durations
      const expectedDuration = 2500 + 1800 + 3200 + (2100 + 2400) + 2800 + (5500 + 5600);
      expect(parsed.durationMs).toBe(expectedDuration);
    });

    it('should throw on invalid report', () => {
      expect(() => parsePlaywrightReport({ invalid: 'data' })).toThrow();
    });
  });
});
