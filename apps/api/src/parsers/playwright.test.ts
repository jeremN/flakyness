import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { parsePlaywrightReport, PlaywrightReportSchema } from './playwright';

const sampleReport = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/sample-report.json'), 'utf-8')
);

const realReport = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/real-report.json'), 'utf-8')
);

const edgeCasesReport = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/real-report-edge-cases.json'), 'utf-8')
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

  describe('real Playwright reporter format', () => {
    it('parses the real Playwright reporter format', () => {
      const parsed = parsePlaywrightReport(realReport);

      expect(parsed.totalTests).toBeGreaterThan(0);
      expect(parsed.totalTests).toBe(7);
      expect(parsed.passed).toBe(2);
      expect(parsed.failed).toBe(3);
      expect(parsed.skipped).toBe(1);
      expect(parsed.flaky).toBe(1);
    });

    it('derives one result per project entry and suffixes names when multi-project', () => {
      const parsed = parsePlaywrightReport(realReport);

      const chromiumResult = parsed.results.find(
        (r) => r.testName.includes('render cart total') && r.testName.endsWith('[chromium]')
      );
      const firefoxResult = parsed.results.find(
        (r) => r.testName.includes('render cart total') && r.testName.endsWith('[firefox]')
      );

      expect(chromiumResult).toBeDefined();
      expect(firefoxResult).toBeDefined();
      expect(chromiumResult?.status).toBe('passed');
      expect(firefoxResult?.status).toBe('failed');
    });

    it('does not suffix names for single-project reports', () => {
      const singleProjectReport = {
        config: {},
        suites: [
          {
            title: 'single.spec.ts',
            file: 'single.spec.ts',
            specs: [
              {
                title: 'test one',
                ok: true,
                tags: [],
                file: 'single.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      { workerIndex: 0, status: 'passed', duration: 100, retry: 0, startTime: '2026-07-01T00:00:00.000Z' },
                    ],
                  },
                ],
              },
              {
                title: 'test two',
                ok: true,
                tags: [],
                file: 'single.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      { workerIndex: 0, status: 'passed', duration: 100, retry: 0, startTime: '2026-07-01T00:00:01.000Z' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const parsed = parsePlaywrightReport(singleProjectReport);

      expect(parsed.totalTests).toBe(2);
      for (const result of parsed.results) {
        expect(result.testName).not.toContain('[');
      }
    });

    it('scans past message-less errors entries', () => {
      const parsed = parsePlaywrightReport(realReport);
      const test = parsed.results.find((r) => r.testName.includes('flaky network response'));

      expect(test?.errorMessage).toBe('real message');
    });

    it('handles edge cases without crashing', () => {
      expect(() => parsePlaywrightReport(edgeCasesReport)).not.toThrow();

      const parsed = parsePlaywrightReport(edgeCasesReport);
      const testNames = parsed.results.map((r) => r.testName);

      // Specs with no results (spec.tests: [], or a tests[] entry with an
      // empty results[]) are skipped, not crashed on.
      expect(testNames.some((n) => n.includes('no tests entries'))).toBe(false);
      expect(testNames.some((n) => n.includes('empty results'))).toBe(false);

      // A spec with no location/file falls back to the containing suite's file.
      const nolocation = parsed.results.find((r) => r.testName.includes('without location field'));
      expect(nolocation?.testFile).toBe('nolocation.spec.ts');

      // A deeply nested suite chain is still traversed.
      expect(testNames.some((n) => n.includes('deeply nested test'))).toBe(true);
    });

    it('truncates oversized names and error messages', () => {
      const longTitle = 'x'.repeat(600);
      const longMessage = 'e'.repeat(10_000); // at the zod schema's own max bound

      const report = {
        config: {},
        suites: [
          {
            title: 'long.spec.ts',
            file: 'long.spec.ts',
            specs: [
              {
                title: longTitle,
                ok: false,
                tags: [],
                file: 'long.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      {
                        workerIndex: 0,
                        status: 'failed',
                        duration: 100,
                        retry: 0,
                        startTime: '2026-07-01T00:00:00.000Z',
                        errors: [{ message: longMessage }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const parsed = parsePlaywrightReport(report);

      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].testName.length).toBeLessThanOrEqual(500);
      expect(parsed.results[0].errorMessage?.length).toBeLessThanOrEqual(10_000);
    });

    it('rejects strings beyond schema bounds', () => {
      const tooLongMessage = 'e'.repeat(10_001);

      const report = {
        config: {},
        suites: [
          {
            title: 'toolong.spec.ts',
            file: 'toolong.spec.ts',
            specs: [
              {
                title: 'oversized error',
                ok: false,
                tags: [],
                file: 'toolong.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      {
                        workerIndex: 0,
                        status: 'failed',
                        duration: 100,
                        retry: 0,
                        startTime: '2026-07-01T00:00:00.000Z',
                        errors: [{ message: tooLongMessage }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      expect(() => parsePlaywrightReport(report)).toThrow(z.ZodError);
    });
  });

  describe('tags and annotations', () => {
    it('carries tags through from the test case', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'tags.spec.ts',
            file: 'tags.spec.ts',
            specs: [
              {
                title: 'tagged test',
                ok: true,
                tags: ['@smoke', '@quarantine'],
                file: 'tags.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      { workerIndex: 0, status: 'passed', duration: 100, retry: 0, startTime: '2026-07-01T00:00:00.000Z' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const parsed = parsePlaywrightReport(report);

      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].tags).toEqual(['@smoke', '@quarantine']);
    });

    it('merges case-level and entry-level annotations, case-level first, deduping exact matches', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'annotations.spec.ts',
            file: 'annotations.spec.ts',
            specs: [
              {
                title: 'annotated test',
                ok: true,
                tags: [],
                file: 'annotations.spec.ts',
                annotations: [
                  { type: 'issue', description: 'JIRA-123' },
                  { type: 'slow' },
                ],
                tests: [
                  {
                    projectName: 'chromium',
                    annotations: [
                      { type: 'slow' }, // duplicate of the case-level entry -> deduped
                      { type: 'issue', description: 'JIRA-456' }, // same type, different description -> kept
                    ],
                    results: [
                      { workerIndex: 0, status: 'passed', duration: 100, retry: 0, startTime: '2026-07-01T00:00:00.000Z' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const parsed = parsePlaywrightReport(report);

      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].annotations).toEqual([
        { type: 'issue', description: 'JIRA-123' },
        { type: 'slow' },
        { type: 'issue', description: 'JIRA-456' },
      ]);
    });

    it('truncates tags and annotations to at most 20 entries', () => {
      const manyTags = Array.from({ length: 25 }, (_, i) => `tag-${i}`);
      const manyAnnotations = Array.from({ length: 25 }, (_, i) => ({ type: `type-${i}` }));

      const report = {
        config: {},
        suites: [
          {
            title: 'many.spec.ts',
            file: 'many.spec.ts',
            specs: [
              {
                title: 'over-capped test',
                ok: true,
                tags: manyTags,
                file: 'many.spec.ts',
                annotations: manyAnnotations,
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      { workerIndex: 0, status: 'passed', duration: 100, retry: 0, startTime: '2026-07-01T00:00:00.000Z' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const parsed = parsePlaywrightReport(report);

      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].tags).toHaveLength(20);
      expect(parsed.results[0].annotations).toHaveLength(20);
    });

    it('defaults to empty tags and annotations arrays when absent from the source report', () => {
      const parsed = parsePlaywrightReport(sampleReport);

      expect(parsed.results.length).toBeGreaterThan(0);
      for (const result of parsed.results) {
        expect(result.tags).toEqual([]);
        expect(result.annotations).toEqual([]);
      }
    });
  });

  describe('failureDetail', () => {
    it('captures deduped errors (stack + snippet), mixed stdout/stderr chunks, and attachment metadata only (never body)', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'detail.spec.ts',
            file: 'detail.spec.ts',
            specs: [
              {
                title: 'captures rich failure detail',
                ok: false,
                tags: [],
                file: 'detail.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      {
                        workerIndex: 0,
                        status: 'failed',
                        duration: 100,
                        retry: 0,
                        startTime: '2026-07-01T00:00:00.000Z',
                        error: {
                          message: 'expect(received).toBe(expected)',
                          stack: 'Error: expect(received).toBe(expected)\n    at detail.spec.ts:10:5',
                          snippet: '  9 | ...\n> 10 | expect(a).toBe(b)',
                        },
                        errors: [
                          // Duplicate of `error` above (same message + stack) -> deduped
                          {
                            message: 'expect(received).toBe(expected)',
                            stack: 'Error: expect(received).toBe(expected)\n    at detail.spec.ts:10:5',
                          },
                          // Distinct second assertion -> kept
                          { message: 'second assertion failed' },
                        ],
                        stdout: ['first line\n', { text: 'second line\n' }],
                        stderr: ['warn: something\n', { text: 'stderr chunk\n' }],
                        attachments: [
                          { name: 'screenshot', contentType: 'image/png', path: 'test-results/detail/screenshot.png' },
                          {
                            name: 'trace',
                            contentType: 'application/zip',
                            path: 'test-results/detail/trace.zip',
                            body: 'QmFzZTY0Qm9keQ==', // must NEVER reach the parsed output
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const parsed = parsePlaywrightReport(report);
      expect(parsed.results).toHaveLength(1);
      const detail = parsed.results[0].failureDetail;
      expect(detail).not.toBeNull();

      expect(detail?.errors).toHaveLength(2);
      expect(detail?.errors[0].message).toBe('expect(received).toBe(expected)');
      expect(detail?.errors[0].stack).toContain('at detail.spec.ts:10:5');
      expect(detail?.errors[0].snippet).toContain('expect(a).toBe(b)');
      expect(detail?.errors[1].message).toBe('second assertion failed');
      expect(detail?.errors[1].stack).toBeUndefined();

      expect(detail?.stdout).toBe('first line\nsecond line\n');
      expect(detail?.stderr).toBe('warn: something\nstderr chunk\n');

      expect(detail?.attachments).toHaveLength(2);
      for (const att of detail?.attachments ?? []) {
        // The metadata-only guarantee: a screenshot/trace's base64 body must
        // never reach the parsed output, let alone the DB. See plan 037.
        expect(att).not.toHaveProperty('body');
      }
      const trace = detail?.attachments?.find((a) => a.name === 'trace');
      expect(trace).toEqual({
        name: 'trace',
        contentType: 'application/zip',
        path: 'test-results/detail/trace.zip',
      });
    });

    it('is null for a passing result with no errors, output, or attachments', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'pass.spec.ts',
            file: 'pass.spec.ts',
            specs: [
              {
                title: 'passes cleanly',
                ok: true,
                tags: [],
                file: 'pass.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      { workerIndex: 0, status: 'passed', duration: 50, retry: 0, startTime: '2026-07-01T00:00:00.000Z' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const parsed = parsePlaywrightReport(report);
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].failureDetail).toBeNull();
    });

    it('clamps oversized stdout to 10,000 chars, keeps an at-bound stack intact, and caps attachments to MAX_ATTACHMENTS (25)', () => {
      // Not bounded by TestErrorSchema's own zod max (stdout chunks are
      // `z.any()`) — this is what actually exercises our own clamp(), unlike
      // the stack case below which is already capped upstream by zod.
      const hugeChunk = 'y'.repeat(15_000);
      // At the zod schema's own max bound (10,000) — the largest value that
      // can reach our extractor at all; confirms it survives intact.
      const maxStack = 'x'.repeat(10_000);

      const attachments = Array.from({ length: 30 }, (_, i) => ({
        name: `att-${i}`,
        contentType: 'text/plain',
        path: `test-results/att-${i}.txt`,
      }));

      const report = {
        config: {},
        suites: [
          {
            title: 'caps.spec.ts',
            file: 'caps.spec.ts',
            specs: [
              {
                title: 'exceeds every cap',
                ok: false,
                tags: [],
                file: 'caps.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      {
                        workerIndex: 0,
                        status: 'failed',
                        duration: 50,
                        retry: 0,
                        startTime: '2026-07-01T00:00:00.000Z',
                        errors: [{ stack: maxStack }],
                        stdout: [hugeChunk],
                        attachments,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const parsed = parsePlaywrightReport(report);
      const detail = parsed.results[0].failureDetail;
      expect(detail).not.toBeNull();
      expect(detail?.errors[0].stack?.length).toBe(10_000);
      expect(detail?.stdout?.length).toBe(10_000);
      expect(detail?.attachments).toHaveLength(25);
    });
  });
});
