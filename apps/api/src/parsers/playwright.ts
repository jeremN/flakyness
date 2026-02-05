import { z } from 'zod';

// Playwright JSON Reporter Schema
// Based on https://playwright.dev/docs/test-reporters#json-reporter

// Define types for recursive schemas
interface TestStep {
  title: string;
  category?: string;
  startTime?: string;
  duration?: number;
  error?: unknown;
  steps?: TestStep[];
}

interface TestCaseType {
  title: string;
  ok: boolean;
  tags?: string[];
  tests?: TestCaseType[];
  id?: string;
  file?: string;
  line?: number;
  column?: number;
  expectedStatus?: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  timeout?: number;
  annotations?: { type: string; description?: string }[];
  retries?: number;
  results?: z.infer<typeof TestResultSchema>[];
  location?: { file: string; line: number; column: number };
}

interface SuiteType {
  title: string;
  file?: string;
  column?: number;
  line?: number;
  specs?: TestCaseType[];
  suites?: SuiteType[];
}

const TestStepSchema: z.ZodType<TestStep> = z.object({
  title: z.string(),
  category: z.string().optional(),
  startTime: z.string().optional(),
  duration: z.number().optional(),
  error: z.any().optional(),
  steps: z.lazy(() => z.array(TestStepSchema)).optional(),
});

const TestErrorSchema = z.object({
  message: z.string().optional(),
  stack: z.string().optional(),
  value: z.string().optional(),
  snippet: z.string().optional(),
});

const TestResultSchema = z.object({
  workerIndex: z.number(),
  status: z.enum(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']),
  duration: z.number(),
  error: TestErrorSchema.optional(),
  errors: z.array(TestErrorSchema).optional(),
  stdout: z.array(z.any()).optional(),
  stderr: z.array(z.any()).optional(),
  retry: z.number(),
  startTime: z.string(),
  attachments: z.array(z.any()).optional(),
  steps: z.array(TestStepSchema).optional(),
});

const TestCaseSchema: z.ZodType<TestCaseType> = z.object({
  title: z.string(),
  ok: z.boolean(),
  tags: z.array(z.string()).optional(),
  tests: z.lazy(() => z.array(TestCaseSchema)).optional(),
  id: z.string().optional(),
  file: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
  expectedStatus: z.enum(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']).optional(),
  timeout: z.number().optional(),
  annotations: z.array(z.object({
    type: z.string(),
    description: z.string().optional(),
  })).optional(),
  retries: z.number().optional(),
  results: z.array(TestResultSchema).optional(),
  location: z.object({
    file: z.string(),
    line: z.number(),
    column: z.number(),
  }).optional(),
});

const SuiteSchema: z.ZodType<SuiteType> = z.object({
  title: z.string(),
  file: z.string().optional(),
  column: z.number().optional(),
  line: z.number().optional(),
  specs: z.array(TestCaseSchema).optional(),
  suites: z.lazy(() => z.array(SuiteSchema)).optional(),
});

export const PlaywrightReportSchema = z.object({
  config: z.object({
    configFile: z.string().optional(),
    rootDir: z.string().optional(),
    forbidOnly: z.boolean().optional(),
    fullyParallel: z.boolean().optional(),
    globalSetup: z.string().nullable().optional(),
    globalTeardown: z.string().nullable().optional(),
    globalTimeout: z.number().optional(),
    grep: z.any().optional(),
    grepInvert: z.any().optional(),
    maxFailures: z.number().optional(),
    metadata: z.record(z.any()).optional(),
    preserveOutput: z.string().optional(),
    projects: z.array(z.any()).optional(),
    reporter: z.array(z.any()).optional(),
    reportSlowTests: z.any().optional(),
    quiet: z.boolean().optional(),
    shard: z.any().optional(),
    updateSnapshots: z.string().optional(),
    version: z.string().optional(),
    workers: z.number().optional(),
  }).passthrough(),
  suites: z.array(SuiteSchema),
  errors: z.array(z.any()).optional(),
  stats: z.object({
    startTime: z.string().optional(),
    duration: z.number().optional(),
    expected: z.number().optional(),
    unexpected: z.number().optional(),
    flaky: z.number().optional(),
    skipped: z.number().optional(),
  }).optional(),
});

export type PlaywrightReport = z.infer<typeof PlaywrightReportSchema>;
export type TestCase = z.infer<typeof TestCaseSchema>;
export type TestResult = z.infer<typeof TestResultSchema>;

// Parsed test result for our database
export interface ParsedTestResult {
  testName: string;
  testFile: string;
  status: 'passed' | 'failed' | 'skipped' | 'flaky';
  durationMs: number;
  retryCount: number;
  errorMessage: string | null;
}

export interface ParsedReport {
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number;
  results: ParsedTestResult[];
}

/**
 * Recursively extract all test specs from nested suites, tracking the title path
 */
function extractSpecs(
  suites: any[],
  parentFile: string = '',
  titlePath: string[] = []
): { spec: TestCase; file: string; titlePath: string[] }[] {
  const specs: { spec: TestCase; file: string; titlePath: string[] }[] = [];

  for (const suite of suites) {
    const currentFile = suite.file || parentFile;
    
    // Build title path - skip empty titles and file-based titles (which match the file path)
    const isFileSuite = suite.title && (
      suite.title.endsWith('.ts') || 
      suite.title.endsWith('.js') ||
      suite.title.includes('/')
    );
    const currentTitlePath = isFileSuite ? titlePath : 
      (suite.title ? [...titlePath, suite.title] : titlePath);

    // Extract specs from this suite
    if (suite.specs) {
      for (const spec of suite.specs) {
        specs.push({ spec, file: currentFile, titlePath: currentTitlePath });
      }
    }

    // Recursively extract from nested suites
    if (suite.suites) {
      specs.push(...extractSpecs(suite.suites, currentFile, currentTitlePath));
    }
  }

  return specs;
}

/**
 * Build full test name from title path and spec title
 */
function buildTestName(titlePath: string[], specTitle: string): string {
  return [...titlePath, specTitle].join(' › ');
}

/**
 * Determine the final status of a test based on all its results
 * A test is flaky if it failed on some attempts but passed on retry
 */
function determineStatus(results: TestResult[]): 'passed' | 'failed' | 'skipped' | 'flaky' {
  if (!results || results.length === 0) {
    return 'skipped';
  }

  const hasPass = results.some(r => r.status === 'passed');
  const hasFail = results.some(r => r.status === 'failed' || r.status === 'timedOut');
  const allSkipped = results.every(r => r.status === 'skipped');

  if (allSkipped) {
    return 'skipped';
  }

  // Flaky: failed on some attempts but eventually passed
  if (hasPass && hasFail) {
    return 'flaky';
  }

  // Final result is the last attempt
  const lastResult = results[results.length - 1];
  
  if (lastResult.status === 'passed') {
    return 'passed';
  }
  
  if (lastResult.status === 'skipped') {
    return 'skipped';
  }

  return 'failed';
}

/**
 * Extract error message from test results
 */
function extractErrorMessage(results: TestResult[]): string | null {
  for (const result of results) {
    if (result.error?.message) {
      return result.error.message;
    }
    if (result.errors && result.errors.length > 0) {
      return result.errors[0].message || null;
    }
  }
  return null;
}

/**
 * Calculate total duration across all retries
 */
function calculateDuration(results: TestResult[]): number {
  return results.reduce((sum, r) => sum + (r.duration || 0), 0);
}

/**
 * Parse a Playwright JSON report into our internal format
 */
export function parsePlaywrightReport(rawReport: unknown): ParsedReport {
  // Validate the report structure
  const report = PlaywrightReportSchema.parse(rawReport);

  const parsedResults: ParsedTestResult[] = [];
  let totalDuration = 0;
  let startedAt: Date | null = null;
  let finishedAt: Date | null = null;

  // Extract all specs with their title paths
  const allSpecs = extractSpecs(report.suites);

  for (const { spec, file, titlePath } of allSpecs) {
    if (!spec.results || spec.results.length === 0) {
      continue;
    }

    const status = determineStatus(spec.results);
    const durationMs = calculateDuration(spec.results);
    const retryCount = Math.max(0, spec.results.length - 1);
    const errorMessage = extractErrorMessage(spec.results);

    // Track earliest start time and latest end time (handles parallel tests correctly)
    for (const result of spec.results) {
      if (result.startTime) {
        const resultStart = new Date(result.startTime);
        if (!startedAt || resultStart < startedAt) {
          startedAt = resultStart;
        }
        const resultEnd = new Date(resultStart.getTime() + (result.duration || 0));
        if (!finishedAt || resultEnd > finishedAt) {
          finishedAt = resultEnd;
        }
      }
    }

    totalDuration += durationMs;

    parsedResults.push({
      testName: buildTestName(titlePath, spec.title),
      testFile: spec.location?.file || file || spec.file || '',
      status,
      durationMs,
      retryCount,
      errorMessage,
    });
  }

  // Count statuses
  const passed = parsedResults.filter(r => r.status === 'passed').length;
  const failed = parsedResults.filter(r => r.status === 'failed').length;
  const skipped = parsedResults.filter(r => r.status === 'skipped').length;
  const flaky = parsedResults.filter(r => r.status === 'flaky').length;

  return {
    totalTests: parsedResults.length,
    passed,
    failed,
    skipped,
    flaky,
    startedAt,
    finishedAt,
    durationMs: totalDuration,
    results: parsedResults,
  };
}
