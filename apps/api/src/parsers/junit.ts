import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import type { ParsedReport, ParsedTestResult } from './playwright';

// JUnit XML Report Parser
//
// Accepts both the common Ant/jest-junit style `<testsuites>` root (one or
// more nested `<testsuite>` elements) and a bare single `<testsuite>` root
// (pytest's default). Produces the exact same `ParsedReport` contract as
// `parsePlaywrightReport` so everything downstream of the route's dispatch
// point is untouched.
//
// JUnit has no retry semantics, so there is no 'flaky' status here and
// `retryCount` is always 0 — flakiness for JUnit-sourced tests emerges
// across runs via the product's existing (failed+flaky)/total rate, not
// within a single report.

const MAX_TESTCASES = 50_000;
const MAX_NAME_LENGTH = 500;
const MAX_ERROR_LENGTH = 10_000;

/** Truncate a string to at most `n` characters. */
const clamp = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** Normalize a fast-xml-parser child that may be a single object or an array of objects. */
function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// --- Raw shape guards -------------------------------------------------
//
// fast-xml-parser output is untyped (`any`); rather than trusting it blindly
// we zod-validate the attribute shape we actually rely on at each boundary
// (mirrors the Playwright parser's "zod at the boundary" philosophy), then
// widen to a plain record to read the handful of dynamic child keys
// (`failure` / `error` / `skipped` / nested `testsuite`) fast-xml-parser
// attaches alongside the validated attributes.

const RawTestCaseSchema = z
  .object({
    '@_classname': z.string().optional(),
    '@_name': z.string().min(1, 'testcase is missing a name attribute'),
    '@_time': z.string().optional(),
    '@_file': z.string().optional(),
  })
  .passthrough();

const RawTestSuiteSchema = z
  .object({
    '@_name': z.string().optional(),
    '@_time': z.string().optional(),
    '@_timestamp': z.string().optional(),
    '@_file': z.string().optional(),
  })
  .passthrough();

type RawTestCase = Record<string, unknown>;
type RawTestSuite = Record<string, unknown>;

/** Parse a JUnit `time` attribute (seconds, as a string) into whole milliseconds. Absent/unparsable -> undefined. */
function parseTimeMs(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return undefined;
  return Math.max(0, Math.round(seconds * 1000));
}

/** Parse a JUnit `timestamp` attribute into a Date. Absent/unparsable -> null. */
function parseTimestamp(raw: unknown): Date | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Extract a human-readable message from a `<failure>`/`<error>` node, which
 * fast-xml-parser represents as:
 *   - a plain string, when the element has only text content (no attrs)
 *   - `""`, when the element is empty/self-closing
 *   - `{ '@_message'?: string, '#text'?: string }` otherwise
 */
function extractIssueMessage(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return '';
  const obj = node as Record<string, unknown>;
  const message = typeof obj['@_message'] === 'string' ? obj['@_message'] : '';
  const text = typeof obj['#text'] === 'string' ? obj['#text'] : '';
  if (message && text) return `${message}: ${text}`;
  return message || text;
}

interface FlatTestCase {
  raw: RawTestCase;
  suiteFile?: string;
}

interface SuiteMeta {
  timestamp: Date | null;
  durationMs: number | undefined;
}

/**
 * Recursively flatten `<testsuite>` elements (which may themselves nest
 * `<testsuite>` children) into a flat list of testcases plus per-suite
 * metadata (timestamp/duration), used for the startedAt/finishedAt and
 * durationMs fallbacks below.
 */
function flattenSuites(node: unknown): { testcases: FlatTestCase[]; suiteMetas: SuiteMeta[] } {
  const suiteNodes = toArray(node as RawTestSuite | RawTestSuite[] | undefined);
  const testcases: FlatTestCase[] = [];
  const suiteMetas: SuiteMeta[] = [];

  for (const suiteRaw of suiteNodes) {
    const parsed = RawTestSuiteSchema.parse(suiteRaw);
    const suite = suiteRaw as RawTestSuite;
    const suiteFile = parsed['@_file'];

    for (const tcRaw of toArray(suite.testcase as RawTestCase | RawTestCase[] | undefined)) {
      RawTestCaseSchema.parse(tcRaw);
      testcases.push({ raw: tcRaw as RawTestCase, suiteFile });
    }

    suiteMetas.push({
      timestamp: parseTimestamp(parsed['@_timestamp']),
      durationMs: parseTimeMs(parsed['@_time']),
    });

    if (suite.testsuite !== undefined) {
      const nested = flattenSuites(suite.testsuite);
      testcases.push(...nested.testcases);
      suiteMetas.push(...nested.suiteMetas);
    }
  }

  return { testcases, suiteMetas };
}

/** Build a single ParsedTestResult from a flattened testcase. */
function buildResult({ raw, suiteFile }: FlatTestCase): ParsedTestResult {
  const classname = typeof raw['@_classname'] === 'string' && raw['@_classname'] ? raw['@_classname'] : undefined;
  const name = raw['@_name'] as string;
  const testName = classname ? `${classname} › ${name}` : name;
  const testFile = (raw['@_file'] as string | undefined) || suiteFile || classname || '';

  const durationMs = parseTimeMs(raw['@_time']) ?? 0;

  const failureNode = raw['failure'];
  const errorNode = raw['error'];
  const skippedNode = raw['skipped'];

  let status: ParsedTestResult['status'];
  let errorMessage: string | null = null;

  if (failureNode !== undefined || errorNode !== undefined) {
    status = 'failed';
    errorMessage = extractIssueMessage(failureNode !== undefined ? failureNode : errorNode) || null;
  } else if (skippedNode !== undefined) {
    status = 'skipped';
  } else {
    status = 'passed';
  }

  return {
    testName: clamp(testName, MAX_NAME_LENGTH),
    testFile: clamp(testFile, MAX_NAME_LENGTH),
    status,
    durationMs,
    retryCount: 0,
    errorMessage: errorMessage ? clamp(errorMessage, MAX_ERROR_LENGTH) : null,
    tags: [],
    annotations: [],
  };
}

// --- Final shape validation --------------------------------------------
// A second zod pass over the fully-built report, independent of the raw XML
// shape guards above — defense in depth against a transform bug producing a
// malformed value (NaN duration, out-of-bounds string, wrong status, etc.)
// before it ever reaches the route/DB layer.

const ParsedTestResultSchema = z.object({
  testName: z.string().max(MAX_NAME_LENGTH),
  testFile: z.string().max(MAX_NAME_LENGTH),
  status: z.enum(['passed', 'failed', 'skipped', 'flaky']),
  durationMs: z.number().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  errorMessage: z.string().max(MAX_ERROR_LENGTH).nullable(),
  tags: z.array(z.string()),
  annotations: z.array(
    z.object({
      type: z.string(),
      description: z.string().optional(),
    })
  ),
});

const ParsedReportSchema = z.object({
  totalTests: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  flaky: z.number().int().nonnegative(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  durationMs: z.number().nonnegative(),
  results: z.array(ParsedTestResultSchema),
});

/** Parse a raw XML document (well-formedness already validated) into a ParsedReport. */
function parseValidatedXml(xml: string): ParsedReport {
  const parser = new XMLParser({ ignoreAttributes: false, processEntities: false });
  const doc = parser.parse(xml) as Record<string, unknown>;

  const isTestsuitesRoot = doc.testsuites !== undefined;
  const root = (isTestsuitesRoot ? doc.testsuites : doc.testsuite) as Record<string, unknown> | undefined;

  if (root === undefined) {
    throw new Error('Invalid JUnit XML: expected a root <testsuites> or <testsuite> element');
  }

  const { testcases, suiteMetas } = flattenSuites(isTestsuitesRoot ? root.testsuite : [root]);

  if (testcases.length > MAX_TESTCASES) {
    throw new Error(
      `JUnit report exceeds maximum of ${MAX_TESTCASES.toLocaleString()} test cases (found ${testcases.length})`
    );
  }

  const results = testcases.map(buildResult);

  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

  const rootDurationMs = parseTimeMs(root['@_time']);
  const durationMs = rootDurationMs ?? results.reduce((sum, r) => sum + r.durationMs, 0);

  const rootTimestamp = parseTimestamp(root['@_timestamp']);
  let startedAt: Date | null = rootTimestamp;
  let finishedAt: Date | null = rootTimestamp ? new Date(rootTimestamp.getTime() + durationMs) : null;

  if (!startedAt) {
    for (const meta of suiteMetas) {
      if (!meta.timestamp) continue;
      if (!startedAt || meta.timestamp < startedAt) {
        startedAt = meta.timestamp;
      }
      const end = new Date(meta.timestamp.getTime() + (meta.durationMs ?? 0));
      if (!finishedAt || end > finishedAt) {
        finishedAt = end;
      }
    }
  }

  return ParsedReportSchema.parse({
    totalTests: results.length,
    passed,
    failed,
    skipped,
    flaky: 0,
    startedAt,
    finishedAt,
    durationMs,
    results,
  });
}

/**
 * Parse a JUnit XML report (jest-junit, pytest, Go, Surefire, Cypress, …)
 * into our internal ParsedReport format.
 */
export function parseJUnitReport(xml: string): ParsedReport {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(`Invalid JUnit XML: ${validation.err.msg} (line ${validation.err.line})`);
  }

  try {
    return parseValidatedXml(xml);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const [issue] = error.issues;
      throw new Error(`Invalid JUnit XML structure: ${issue ? issue.message : 'validation failed'}`);
    }
    throw error;
  }
}
