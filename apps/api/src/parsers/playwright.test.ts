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

    it('rejects an oversized error `value` field beyond the schema bound', () => {
      const tooLongValue = 'v'.repeat(10_001);

      const report = {
        config: {},
        suites: [
          {
            title: 'oversized-value.spec.ts',
            file: 'oversized-value.spec.ts',
            specs: [
              {
                title: 'oversized value field',
                ok: false,
                tags: [],
                file: 'oversized-value.spec.ts',
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
                        errors: [{ value: tooLongValue }],
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

    it('defaults tags to an empty array (not a placeholder) when the field is entirely absent', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'no-tags-field.spec.ts',
            file: 'no-tags-field.spec.ts',
            specs: [
              {
                title: 'never declares a tags field',
                ok: true,
                // `tags` omitted entirely (not even an empty array) - exercises
                // the `spec.tags ?? []` default itself, not a pre-populated [].
                file: 'no-tags-field.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      { workerIndex: 0, status: 'passed', duration: 10, retry: 0, startTime: '2026-07-01T00:00:00.000Z' },
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
      expect(parsed.results[0].tags).toEqual([]);
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

    it('skips malformed stdout/stderr chunks (non-string, no .text) without crashing', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'malformed-chunks.spec.ts',
            file: 'malformed-chunks.spec.ts',
            specs: [
              {
                title: 'has a null chunk mixed in',
                ok: false,
                tags: [],
                file: 'malformed-chunks.spec.ts',
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
                        errors: [{ message: 'boom' }],
                        stdout: ['before\n', null, { text: 'after\n' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      expect(() => parsePlaywrightReport(report)).not.toThrow();
      const parsed = parsePlaywrightReport(report);
      expect(parsed.results[0].failureDetail?.stdout).toBe('before\nafter\n');
    });

    it('captures the error value field alongside message/stack/snippet', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'value-field.spec.ts',
            file: 'value-field.spec.ts',
            specs: [
              {
                title: 'assertion with a captured value',
                ok: false,
                tags: [],
                file: 'value-field.spec.ts',
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
                        errors: [{ message: 'expect(received).toBe(expected)', value: 'expected 42, received 7' }],
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
      expect(detail?.errors[0].value).toBe('expected 42, received 7');
    });

    it('dedupes errors by the exact message+stack pair, not by either field alone', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'dedup-key.spec.ts',
            file: 'dedup-key.spec.ts',
            specs: [
              {
                title: 'three distinct errors that share partial fields',
                ok: false,
                tags: [],
                file: 'dedup-key.spec.ts',
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
                        errors: [
                          { message: 'msgA', stack: 'stackX' },
                          { message: 'msgB', stack: 'stackX' }, // same stack, different message -> distinct
                          { message: 'msgA', stack: 'stackY' }, // same message, different stack -> distinct
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
      const detail = parsed.results[0].failureDetail;
      expect(detail?.errors).toHaveLength(3);
    });

    it('caps captured errors to MAX_ERRORS (10) even when more are present', () => {
      const manyErrors = Array.from({ length: 12 }, (_, i) => ({ message: `error-${i}` }));

      const report = {
        config: {},
        suites: [
          {
            title: 'many-errors.spec.ts',
            file: 'many-errors.spec.ts',
            specs: [
              {
                title: 'exceeds MAX_ERRORS',
                ok: false,
                tags: [],
                file: 'many-errors.spec.ts',
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
                        errors: manyErrors,
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
      expect(detail?.errors).toHaveLength(10);
    });

    it('skips non-object attachment entries without crashing', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'malformed-attachments.spec.ts',
            file: 'malformed-attachments.spec.ts',
            specs: [
              {
                title: 'has a stray non-object attachment',
                ok: false,
                tags: [],
                file: 'malformed-attachments.spec.ts',
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
                        errors: [{ message: 'boom' }],
                        attachments: [
                          'not-an-object',
                          null,
                          { name: 'valid', contentType: 'text/plain', path: 'a.txt' },
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

      expect(() => parsePlaywrightReport(report)).not.toThrow();
      const parsed = parsePlaywrightReport(report);
      expect(parsed.results[0].failureDetail?.attachments).toHaveLength(1);
      expect(parsed.results[0].failureDetail?.attachments?.[0].name).toBe('valid');
    });

    it('skips an attachment entry missing a usable name', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'nameless-attachment.spec.ts',
            file: 'nameless-attachment.spec.ts',
            specs: [
              {
                title: 'has an attachment without a name',
                ok: false,
                tags: [],
                file: 'nameless-attachment.spec.ts',
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
                        errors: [{ message: 'boom' }],
                        attachments: [
                          { contentType: 'text/plain', path: 'noname.txt' },
                          { name: '', contentType: 'text/plain', path: 'emptyname.txt' },
                          { name: 42, contentType: 'text/plain', path: 'numericname.txt' },
                          { name: 'valid', contentType: 'text/plain', path: 'a.txt' },
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
      expect(parsed.results[0].failureDetail?.attachments).toHaveLength(1);
      expect(parsed.results[0].failureDetail?.attachments?.[0].name).toBe('valid');
    });

    it('defaults a missing attachment contentType to an empty string', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'no-contenttype.spec.ts',
            file: 'no-contenttype.spec.ts',
            specs: [
              {
                title: 'attachment without contentType',
                ok: false,
                tags: [],
                file: 'no-contenttype.spec.ts',
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
                        errors: [{ message: 'boom' }],
                        attachments: [{ name: 'shot', path: 'shot.png' }],
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
      expect(parsed.results[0].failureDetail?.attachments?.[0]).toEqual({
        name: 'shot',
        contentType: '',
        path: 'shot.png',
      });
    });

    it('omits the attachment path entirely when the source has none (not `path: undefined`)', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'no-path.spec.ts',
            file: 'no-path.spec.ts',
            specs: [
              {
                title: 'attachment without a path',
                ok: false,
                tags: [],
                file: 'no-path.spec.ts',
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
                        errors: [{ message: 'boom' }],
                        attachments: [{ name: 'shot', contentType: 'image/png' }],
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
      const attachment = parsed.results[0].failureDetail?.attachments?.[0];
      expect(attachment).not.toHaveProperty('path');
    });

    it('is non-null when only attachments are present (no errors/stdout/stderr)', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'only-attachments.spec.ts',
            file: 'only-attachments.spec.ts',
            specs: [
              {
                title: 'passed but left an attachment behind',
                ok: true,
                tags: [],
                file: 'only-attachments.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      {
                        workerIndex: 0,
                        status: 'passed',
                        duration: 100,
                        retry: 0,
                        startTime: '2026-07-01T00:00:00.000Z',
                        attachments: [{ name: 'trace', contentType: 'application/zip', path: 'trace.zip' }],
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
      expect(detail?.errors).toHaveLength(0);
      expect(detail?.attachments).toHaveLength(1);
    });

    it('is non-null when only stdout is present (no errors/stderr/attachments)', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'only-stdout.spec.ts',
            file: 'only-stdout.spec.ts',
            specs: [
              {
                title: 'passed but logged something',
                ok: true,
                tags: [],
                file: 'only-stdout.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      {
                        workerIndex: 0,
                        status: 'passed',
                        duration: 100,
                        retry: 0,
                        startTime: '2026-07-01T00:00:00.000Z',
                        stdout: ['just some output\n'],
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
      expect(detail?.stdout).toBe('just some output\n');
    });

    it('is non-null when only stderr is present (no errors/stdout/attachments)', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'only-stderr.spec.ts',
            file: 'only-stderr.spec.ts',
            specs: [
              {
                title: 'passed but warned on stderr',
                ok: true,
                tags: [],
                file: 'only-stderr.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      {
                        workerIndex: 0,
                        status: 'passed',
                        duration: 100,
                        retry: 0,
                        startTime: '2026-07-01T00:00:00.000Z',
                        stderr: ['a warning\n'],
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
      expect(detail?.stderr).toBe('a warning\n');
    });

    it('omits the attachments key entirely when there are none, not an empty array', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'no-attachments.spec.ts',
            file: 'no-attachments.spec.ts',
            specs: [
              {
                title: 'failed with no attachments',
                ok: false,
                tags: [],
                file: 'no-attachments.spec.ts',
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
                        errors: [{ message: 'boom' }],
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
      expect(detail).not.toHaveProperty('attachments');
    });
  });

  describe('extractSpecs (file-suite title detection)', () => {
    it('treats a suite title ending in .ts (no slash) as a file marker, excluding it from the title path', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'unit.spec.ts',
            file: 'unit.spec.ts',
            specs: [
              {
                title: 'bare ts-titled test',
                ok: true,
                tags: [],
                file: 'unit.spec.ts',
                tests: [
                  { projectName: 'chromium', results: [{ workerIndex: 0, status: 'passed', duration: 10, retry: 0, startTime: '2026-07-01T00:00:00.000Z' }] },
                ],
              },
            ],
          },
        ],
      };

      const parsed = parsePlaywrightReport(report);
      expect(parsed.results).toHaveLength(1);
      // If the suite title were NOT recognized as a file marker, it would be
      // prepended to the name: 'unit.spec.ts › bare ts-titled test'.
      expect(parsed.results[0].testName).toBe('bare ts-titled test');
    });

    it('treats a suite title ending in .js (no slash) as a file marker, excluding it from the title path', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'legacy.spec.js',
            file: 'legacy.spec.js',
            specs: [
              {
                title: 'bare js-titled test',
                ok: true,
                tags: [],
                file: 'legacy.spec.js',
                tests: [
                  { projectName: 'chromium', results: [{ workerIndex: 0, status: 'passed', duration: 10, retry: 0, startTime: '2026-07-01T00:00:00.000Z' }] },
                ],
              },
            ],
          },
        ],
      };

      const parsed = parsePlaywrightReport(report);
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].testName).toBe('bare js-titled test');
    });

    it('treats a suite title containing a slash as a file marker even without a .ts/.js extension', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'features/checkout',
            file: 'features/checkout',
            specs: [
              {
                title: 'slash-only test',
                ok: true,
                tags: [],
                file: 'features/checkout',
                tests: [
                  { projectName: 'chromium', results: [{ workerIndex: 0, status: 'passed', duration: 10, retry: 0, startTime: '2026-07-01T00:00:00.000Z' }] },
                ],
              },
            ],
          },
        ],
      };

      const parsed = parsePlaywrightReport(report);
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].testName).toBe('slash-only test');
    });

    it('defaults an unset top-level file to empty string, not a stray placeholder', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'no file or slash',
            // no top-level `file` field: exercises extractSpecs's parentFile
            // default value directly.
            specs: [
              {
                title: 'test with nothing to attribute a file to',
                ok: true,
                tags: [],
                tests: [
                  { projectName: 'chromium', results: [{ workerIndex: 0, status: 'passed', duration: 10, retry: 0, startTime: '2026-07-01T00:00:00.000Z' }] },
                ],
              },
            ],
          },
        ],
      };

      const parsed = parsePlaywrightReport(report);
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].testFile).toBe('');
    });
  });

  describe('determineStatus (via full parse)', () => {
    it('treats a timedOut attempt followed by a pass as flaky (not just "failed")', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'timeout-retry.spec.ts',
            file: 'timeout-retry.spec.ts',
            specs: [
              {
                title: 'flaky via timeout then pass',
                ok: true,
                tags: [],
                file: 'timeout-retry.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      { workerIndex: 0, status: 'timedOut', duration: 30000, retry: 0, startTime: '2026-07-01T00:00:00.000Z' },
                      { workerIndex: 0, status: 'passed', duration: 500, retry: 1, startTime: '2026-07-01T00:00:31.000Z' },
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
      expect(parsed.results[0].status).toBe('flaky');
      expect(parsed.results[0].retryCount).toBe(1);
    });

    it('treats a partial skip (one skipped attempt, one passed) as passed, not skipped', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'partial-skip.spec.ts',
            file: 'partial-skip.spec.ts',
            specs: [
              {
                title: 'skipped once then passed',
                ok: true,
                tags: [],
                file: 'partial-skip.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      { workerIndex: 0, status: 'skipped', duration: 0, retry: 0, startTime: '2026-07-01T00:00:00.000Z' },
                      { workerIndex: 0, status: 'passed', duration: 500, retry: 1, startTime: '2026-07-01T00:00:01.000Z' },
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
      expect(parsed.results[0].status).toBe('passed');
    });

    it('treats a failed attempt followed by a skipped final attempt as skipped, not failed', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'fail-then-skip.spec.ts',
            file: 'fail-then-skip.spec.ts',
            specs: [
              {
                title: 'aborted after failure',
                ok: false,
                tags: [],
                file: 'fail-then-skip.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      { workerIndex: 0, status: 'failed', duration: 1000, retry: 0, startTime: '2026-07-01T00:00:00.000Z' },
                      { workerIndex: 0, status: 'skipped', duration: 0, retry: 1, startTime: '2026-07-01T00:00:02.000Z' },
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
      expect(parsed.results[0].status).toBe('skipped');
    });

    it('maps a lone "interrupted" attempt to failed (the fallback branch, not passed/skipped)', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'interrupted.spec.ts',
            file: 'interrupted.spec.ts',
            specs: [
              {
                title: 'run was interrupted',
                ok: false,
                tags: [],
                file: 'interrupted.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      { workerIndex: 0, status: 'interrupted', duration: 0, retry: 0, startTime: '2026-07-01T00:00:00.000Z' },
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
      expect(parsed.results[0].status).toBe('failed');
    });
  });

  describe('getExecutions (spec.tests vs legacy spec.results)', () => {
    it('falls back to legacy spec.results when spec.tests is present but empty', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'legacy-fallback.spec.ts',
            file: 'legacy-fallback.spec.ts',
            specs: [
              {
                title: 'uses legacy results shape',
                ok: true,
                tags: [],
                file: 'legacy-fallback.spec.ts',
                tests: [], // present but empty -> must not short-circuit the legacy fallback
                results: [
                  { workerIndex: 0, status: 'passed', duration: 250, retry: 0, startTime: '2026-07-01T00:00:00.000Z' },
                ],
              },
            ],
          },
        ],
      };

      const parsed = parsePlaywrightReport(report);
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].status).toBe('passed');
      expect(parsed.results[0].durationMs).toBe(250);
    });

    it('excludes a spec whose legacy spec.results is present but empty (no tests[] at all)', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'legacy-empty.spec.ts',
            file: 'legacy-empty.spec.ts',
            specs: [
              {
                title: 'never actually ran',
                ok: true,
                tags: [],
                file: 'legacy-empty.spec.ts',
                results: [], // present but empty, and no tests[] field at all
              },
            ],
          },
        ],
      };

      const parsed = parsePlaywrightReport(report);
      expect(parsed.results).toHaveLength(0);
      expect(parsed.totalTests).toBe(0);
    });
  });

  describe('startedAt / finishedAt tracking', () => {
    it('tracks the earliest start and latest end across specs, independent of processing order', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'first.spec.ts',
            file: 'first.spec.ts',
            specs: [
              {
                title: 'starts earliest, runs longest',
                ok: true,
                tags: [],
                file: 'first.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      { workerIndex: 0, status: 'passed', duration: 10_000, retry: 0, startTime: '2026-07-01T10:00:00.000Z' },
                    ],
                  },
                ],
              },
            ],
          },
          {
            title: 'second.spec.ts',
            file: 'second.spec.ts',
            specs: [
              {
                title: 'starts later, runs shorter',
                ok: true,
                tags: [],
                file: 'second.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      { workerIndex: 1, status: 'passed', duration: 1_000, retry: 0, startTime: '2026-07-01T10:00:05.000Z' },
                    ],
                  },
                ],
              },
            ],
          },
          {
            title: 'third.spec.ts',
            file: 'third.spec.ts',
            specs: [
              {
                title: 'starts last, but runs longest of all - must still win the max-end check',
                ok: true,
                tags: [],
                file: 'third.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      { workerIndex: 2, status: 'passed', duration: 20_000, retry: 0, startTime: '2026-07-01T10:00:08.000Z' },
                    ],
                  },
                ],
              },
            ],
          },
          {
            title: 'fourth.spec.ts',
            file: 'fourth.spec.ts',
            specs: [
              {
                title: 'processed last of all, but ends earlier than the third spec - must NOT override the true max',
                ok: true,
                tags: [],
                file: 'fourth.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      { workerIndex: 3, status: 'passed', duration: 100, retry: 0, startTime: '2026-07-01T10:00:20.000Z' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const parsed = parsePlaywrightReport(report);

      // Earliest start comes from the FIRST spec (10:00:00) even though it is
      // processed (and starts) before the others.
      expect(parsed.startedAt?.toISOString()).toBe('2026-07-01T10:00:00.000Z');
      // Latest end comes from the THIRD spec (10:00:08 + 20s = 10:00:28), NOT
      // the fourth (last-processed) spec's earlier end (10:00:20.1) - proving
      // finishedAt is a running max, not "whichever result is processed
      // first" (first: end 10:00:10, second: end 10:00:06) nor "whichever is
      // processed last" (fourth: end 10:00:20.100).
      expect(parsed.finishedAt?.toISOString()).toBe('2026-07-01T10:00:28.000Z');
    });

    it('ignores a result with an empty startTime string when tracking start/end', () => {
      const report = {
        config: {},
        suites: [
          {
            title: 'blank-starttime.spec.ts',
            file: 'blank-starttime.spec.ts',
            specs: [
              {
                title: 'has a blank startTime attempt then a real one',
                ok: true,
                tags: [],
                file: 'blank-starttime.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      { workerIndex: 0, status: 'failed', duration: 0, retry: 0, startTime: '' },
                      { workerIndex: 0, status: 'passed', duration: 500, retry: 1, startTime: '2026-07-01T10:00:00.000Z' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const parsed = parsePlaywrightReport(report);

      expect(parsed.startedAt?.toISOString()).toBe('2026-07-01T10:00:00.000Z');
      expect(parsed.finishedAt?.toISOString()).toBe('2026-07-01T10:00:00.500Z');
    });
  });
});
