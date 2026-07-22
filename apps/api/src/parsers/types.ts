// Format-neutral parsed-report contract. Every report parser (Playwright,
// JUnit, and any future framework) produces this shape; the DB layer and the
// ingest route consume it. Kept parser-agnostic so no parser imports another.

/** Parsed test result for our database. */
export interface ParsedTestResult {
  testName: string;
  testFile: string;
  status: 'passed' | 'failed' | 'skipped' | 'flaky';
  durationMs: number;
  retryCount: number;
  errorMessage: string | null;
  tags: string[];
  annotations: { type: string; description?: string }[];
  failureDetail: FailureDetail | null;
}

/**
 * Richer per-run failure detail, alongside (not replacing) `errorMessage`.
 *
 * Attachments are METADATA ONLY — `{ name, contentType, path }`. The base64
 * `body` field (screenshots/videos/traces) is never copied through; that is
 * a hard guarantee, not a size-tuning choice — see plan 037.
 */
export interface FailureDetail {
  errors: Array<{ message?: string; stack?: string; snippet?: string; value?: string }>;
  stdout?: string;
  stderr?: string;
  attachments?: Array<{ name: string; contentType: string; path?: string }>;
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
