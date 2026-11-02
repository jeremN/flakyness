import { describe, it, expect, vi } from 'vitest';
import { buildUploadUrl, uploadReport } from './upload';
import { formatRegression, formatRegressions, formatReport } from './summary';
import type { AuditReport } from './types';

const report: AuditReport = {
  version: 1,
  tool: { name: 'flackyness-auditor', version: 'test' },
  startedAt: '2026-09-26T08:00:00.000Z',
  finishedAt: '2026-09-26T08:00:10.000Z',
  pages: [
    {
      url: 'https://a.test/',
      device: 'mobile',
      checks: [
        { category: 'a11y', score: 0.87, issues: [] },
        { category: 'perf', score: null, issues: [] },
      ],
    },
    { url: 'https://b.test/', device: 'desktop', error: 'net::ERR_NAME_NOT_RESOLVED', checks: [] },
  ],
};

describe('buildUploadUrl', () => {
  it('appends the ingest path and encodes query params', () => {
    expect(buildUploadUrl({ apiUrl: 'https://fk.test', branch: 'feat/a b', commit: 'abc', pipeline: '42' })).toBe(
      'https://fk.test/api/v1/audits?branch=feat%2Fa+b&commit=abc&pipeline=42'
    );
  });

  it('keeps a path prefix on the API URL, with or without a trailing slash (review finding)', () => {
    expect(buildUploadUrl({ apiUrl: 'https://host.test/flaky' })).toBe('https://host.test/flaky/api/v1/audits');
    expect(buildUploadUrl({ apiUrl: 'https://host.test/flaky/' })).toBe('https://host.test/flaky/api/v1/audits');
  });

  it('works with a trailing slash and omits unset params', () => {
    expect(buildUploadUrl({ apiUrl: 'https://fk.test/' })).toBe('https://fk.test/api/v1/audits');
  });
});

describe('uploadReport', () => {
  it('POSTs the report with the bearer token and returns the parsed response on 201', async () => {
    const body = { auditRun: { id: 'r1', project: 'p', branch: 'main' }, previousRunId: null, regressions: [] };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 201 }));
    const res = await uploadReport(report, { apiUrl: 'https://fk.test', token: 'tok', branch: 'main' }, fetchImpl);
    expect(res).toEqual(body);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://fk.test/api/v1/audits?branch=main');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual(report);
  });

  it('surfaces the API error message on a non-201', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid audit report: x' }), { status: 400 }));
    await expect(uploadReport(report, { apiUrl: 'https://fk.test', token: 't' }, fetchImpl)).rejects.toThrow(
      'Upload failed: HTTP 400: Invalid audit report: x'
    );
  });

  it('reports a non-JSON error body verbatim', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));
    await expect(uploadReport(report, { apiUrl: 'https://fk.test', token: 't' }, fetchImpl)).rejects.toThrow(
      /HTTP 502: <html>Bad Gateway/
    );
  });
});

describe('summary formatting', () => {
  it('renders one line per page with scores out of 100 and — for unmeasured', () => {
    const text = formatReport(report);
    expect(text).toContain('  87    —    —  mobile   https://a.test/');
    expect(text).toContain('✗ page failed      desktop  https://b.test/ — net::ERR_NAME_NOT_RESOLVED');
    expect(text).toContain('2 page(s) audited, 1 failed to load.');
  });

  it('formats each regression kind', () => {
    const where = { url: 'https://a.test/', device: 'mobile', category: 'perf' };
    expect(formatRegression({ kind: 'metric', ...where, metric: 'lcp', previous: 1200.4, current: 2500 })).toBe(
      '[perf] https://a.test/ (mobile): lcp 1200ms → 2500ms'
    );
    expect(formatRegression({ kind: 'metric', ...where, metric: 'cls', previous: 0.01, current: 0.2 })).toBe(
      '[perf] https://a.test/ (mobile): cls 0.010 → 0.200'
    );
    expect(formatRegression({ kind: 'score', ...where, previous: 0.91, current: 0.62 })).toBe(
      '[perf] https://a.test/ (mobile): score 91 → 62'
    );
    expect(
      formatRegression({ kind: 'new_issue', ...where, category: 'a11y', issueId: 'label', severity: 'critical', message: 'Form elements must have labels' })
    ).toBe('[a11y] https://a.test/ (mobile): new critical issue "label" — Form elements must have labels');
  });

  it('distinguishes "no baseline" from "no regressions"', () => {
    expect(formatRegressions([], null)).toMatch(/baseline/);
    expect(formatRegressions([], 'prev')).toBe('No regressions against the previous audit.');
  });
});
