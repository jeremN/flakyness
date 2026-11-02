import { describe, it, expect } from 'vitest';
import {
  auditReportSchema,
  compareAuditResults,
  summarizeScores,
  MAX_AUDIT_PAGES,
  MAX_ISSUES_PER_CHECK,
  type ComparableResult,
} from './audits';

function result(overrides: Partial<ComparableResult> = {}): ComparableResult {
  return {
    url: 'https://example.com/',
    device: 'mobile',
    category: 'a11y',
    score: '0.9000',
    metrics: null,
    issues: [],
    ...overrides,
  };
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://example.com/',
    device: 'mobile',
    checks: [{ category: 'a11y', score: 0.9, issues: [] }],
    ...overrides,
  };
}

describe('auditReportSchema', () => {
  it('accepts a minimal v1 report', () => {
    expect(auditReportSchema.safeParse({ version: 1, pages: [page()] }).success).toBe(true);
  });

  it('rejects an unknown version', () => {
    expect(auditReportSchema.safeParse({ version: 2, pages: [page()] }).success).toBe(false);
  });

  it('rejects an empty pages array — an audit of nothing is a broken runner, not a run', () => {
    expect(auditReportSchema.safeParse({ version: 1, pages: [] }).success).toBe(false);
  });

  it(`rejects more than ${MAX_AUDIT_PAGES} pages instead of truncating`, () => {
    const pages = Array.from({ length: MAX_AUDIT_PAGES + 1 }, (_, i) => page({ url: `https://example.com/${i}` }));
    expect(auditReportSchema.safeParse({ version: 1, pages }).success).toBe(false);
    expect(
      auditReportSchema.safeParse({ version: 1, pages: pages.slice(0, MAX_AUDIT_PAGES) }).success
    ).toBe(true);
  });

  it(`rejects more than ${MAX_ISSUES_PER_CHECK} issues in one check`, () => {
    const issues = Array.from({ length: MAX_ISSUES_PER_CHECK + 1 }, (_, i) => ({
      id: `rule-${i}`,
      severity: 'minor',
      message: 'm',
    }));
    const report = { version: 1, pages: [page({ checks: [{ category: 'a11y', score: 0.5, issues }] })] };
    expect(auditReportSchema.safeParse(report).success).toBe(false);
  });

  it('rejects a score outside 0..1', () => {
    for (const score of [-0.01, 1.01]) {
      const report = { version: 1, pages: [page({ checks: [{ category: 'seo', score, issues: [] }] })] };
      expect(auditReportSchema.safeParse(report).success, `score ${score}`).toBe(false);
    }
  });

  it('accepts a null score (check ran, could not score)', () => {
    const report = { version: 1, pages: [page({ checks: [{ category: 'perf', score: null, issues: [] }] })] };
    expect(auditReportSchema.safeParse(report).success).toBe(true);
  });

  it('rejects the same category twice on one page', () => {
    const checks = [
      { category: 'a11y', score: 1, issues: [] },
      { category: 'a11y', score: 0.5, issues: [] },
    ];
    expect(auditReportSchema.safeParse({ version: 1, pages: [page({ checks })] }).success).toBe(false);
  });

  it('rejects an unknown category, device or severity', () => {
    const bad = [
      page({ checks: [{ category: 'security', score: 1, issues: [] }] }),
      page({ device: 'tablet' }),
      page({ checks: [{ category: 'a11y', score: 1, issues: [{ id: 'x', severity: 'blocker', message: '' }] }] }),
    ];
    for (const p of bad) {
      expect(auditReportSchema.safeParse({ version: 1, pages: [p] }).success).toBe(false);
    }
  });

  it('rejects a non-URL page url', () => {
    expect(auditReportSchema.safeParse({ version: 1, pages: [page({ url: 'not a url' })] }).success).toBe(false);
  });

  it('rejects non-finite metrics', () => {
    const checks = [{ category: 'perf', score: 0.5, metrics: { lcp: Infinity }, issues: [] }];
    expect(auditReportSchema.safeParse({ version: 1, pages: [page({ checks })] }).success).toBe(false);
  });

  it('rejects a failed page that also carries checks (review finding)', () => {
    const report = { version: 1, pages: [page({ error: 'boom' })] };
    expect(auditReportSchema.safeParse(report).success).toBe(false);
  });

  it('rejects the same (url, device) twice, but allows the same url on two devices (review finding)', () => {
    expect(auditReportSchema.safeParse({ version: 1, pages: [page(), page()] }).success).toBe(false);
    expect(
      auditReportSchema.safeParse({ version: 1, pages: [page(), page({ device: 'desktop' })] }).success
    ).toBe(true);
  });

  it('accepts a failed page with an error and no checks', () => {
    const report = { version: 1, pages: [page({ error: 'net::ERR_NAME_NOT_RESOLVED', checks: [] })] };
    expect(auditReportSchema.safeParse(report).success).toBe(true);
  });
});

describe('compareAuditResults', () => {
  it('returns nothing when there is no baseline', () => {
    expect(compareAuditResults([], [result({ score: '0.1000' })])).toEqual([]);
  });

  it('returns nothing for identical runs', () => {
    const r = result({ issues: [{ id: 'color-contrast', severity: 'serious', message: 'x' }] });
    expect(compareAuditResults([r], [r])).toEqual([]);
  });

  it('only compares the same url + device + category', () => {
    const prev = [result({ score: '1.0000' })];
    const cur = [
      result({ score: '0.1000', url: 'https://example.com/other' }),
      result({ score: '0.1000', device: 'desktop' }),
      result({ score: '0.1000', category: 'seo' }),
    ];
    expect(compareAuditResults(prev, cur)).toEqual([]);
  });

  describe('score drops', () => {
    it('flags a drop exactly at the threshold (0.05)', () => {
      const out = compareAuditResults([result({ score: '0.9000' })], [result({ score: '0.8500' })]);
      expect(out).toEqual([
        {
          kind: 'score',
          url: 'https://example.com/',
          device: 'mobile',
          category: 'a11y',
          previous: 0.9,
          current: 0.85,
        },
      ]);
    });

    it('ignores a drop just under the threshold', () => {
      expect(compareAuditResults([result({ score: '0.9000' })], [result({ score: '0.8501' })])).toEqual([]);
    });

    it('ignores an improvement', () => {
      expect(compareAuditResults([result({ score: '0.5000' })], [result({ score: '0.9000' })])).toEqual([]);
    });

    it('skips the comparison when either side is unscored', () => {
      expect(compareAuditResults([result({ score: null })], [result({ score: '0.1000' })])).toEqual([]);
      expect(compareAuditResults([result({ score: '0.9000' })], [result({ score: null })])).toEqual([]);
    });
  });

  describe('new issues', () => {
    it('flags an issue id absent from the baseline', () => {
      const out = compareAuditResults(
        [result({ issues: [{ id: 'image-alt', severity: 'critical', message: 'old' }] })],
        [
          result({
            issues: [
              { id: 'image-alt', severity: 'critical', message: 'old' },
              { id: 'label', severity: 'serious', message: 'Form elements must have labels' },
            ],
          }),
        ]
      );
      expect(out).toEqual([
        {
          kind: 'new_issue',
          url: 'https://example.com/',
          device: 'mobile',
          category: 'a11y',
          issueId: 'label',
          severity: 'serious',
          message: 'Form elements must have labels',
        },
      ]);
    });

    it('does not flag an existing issue whose count grew — ids, not counts, define "new"', () => {
      const out = compareAuditResults(
        [result({ issues: [{ id: 'image-alt', severity: 'critical', message: 'm', count: 1 }] })],
        [result({ issues: [{ id: 'image-alt', severity: 'critical', message: 'm', count: 9 }] })]
      );
      expect(out).toEqual([]);
    });

    it('never flags an info-level observation', () => {
      const out = compareAuditResults(
        [result({ category: 'seo' })],
        [result({ category: 'seo', issues: [{ id: 'canonical-not-self', severity: 'info', message: 'm' }] })]
      );
      expect(out).toEqual([]);
    });
  });

  describe('metrics', () => {
    const perf = (metrics: Record<string, number>) => result({ category: 'perf', metrics });

    it('flags LCP when it grows by >=20% AND >=250ms', () => {
      const out = compareAuditResults([perf({ lcp: 2000 })], [perf({ lcp: 2400 })]);
      expect(out).toMatchObject([{ kind: 'metric', metric: 'lcp', previous: 2000, current: 2400 }]);
    });

    it('does not flag a large relative change below the absolute floor', () => {
      // +100% but only +100ms on LCP.
      expect(compareAuditResults([perf({ lcp: 100 })], [perf({ lcp: 200 })])).toEqual([]);
    });

    it('does not flag a large absolute change below the relative ratio', () => {
      // +300ms but only +3.3% of a slow LCP.
      expect(compareAuditResults([perf({ lcp: 9000 })], [perf({ lcp: 9300 })])).toEqual([]);
    });

    it('flags each metric at exactly its boundary', () => {
      const out = compareAuditResults(
        [perf({ lcp: 1250, fcp: 1250, ttfb: 500, tbt: 500, cls: 0.1 })],
        [perf({ lcp: 1500, fcp: 1500, ttfb: 600, tbt: 600, cls: 0.15 })]
      );
      expect(out.map((r) => (r.kind === 'metric' ? r.metric : r.kind))).toEqual([
        'cls',
        'fcp',
        'lcp',
        'tbt',
        'ttfb',
      ]);
    });

    it('does not flag just under each boundary', () => {
      const out = compareAuditResults(
        [perf({ lcp: 1250, fcp: 1250, ttfb: 500, tbt: 500, cls: 0.1 })],
        [perf({ lcp: 1499, fcp: 1499, ttfb: 599, tbt: 599, cls: 0.1499 })]
      );
      expect(out).toEqual([]);
    });

    it('ignores metrics it has no rule for, and metrics missing on one side', () => {
      const out = compareAuditResults(
        [perf({ lcp: 1000, custom: 1 })],
        [perf({ fcp: 9000, custom: 99999 })]
      );
      expect(out).toEqual([]);
    });
  });

  it('orders new issues (by severity) before score drops before metrics', () => {
    const prev = [
      result({ url: 'https://a.test/', category: 'perf', score: '0.9000', metrics: { lcp: 1000 } }),
      result({ url: 'https://b.test/', score: '1.0000' }),
    ];
    const cur = [
      result({ url: 'https://a.test/', category: 'perf', score: '0.9000', metrics: { lcp: 5000 } }),
      result({
        url: 'https://b.test/',
        score: '0.5000',
        issues: [
          { id: 'minor-rule', severity: 'minor', message: '' },
          { id: 'critical-rule', severity: 'critical', message: '' },
        ],
      }),
    ];
    const out = compareAuditResults(prev, cur);
    expect(out.map((r) => r.kind)).toEqual(['new_issue', 'new_issue', 'score', 'metric']);
    expect(out[0]).toMatchObject({ issueId: 'critical-rule' });
    expect(out[1]).toMatchObject({ issueId: 'minor-rule' });
  });

  it('is deterministic regardless of input order', () => {
    const prev = ['https://c.test/', 'https://a.test/', 'https://b.test/'].map((url) =>
      result({ url, score: '1.0000' })
    );
    const cur = prev.map((r) => ({ ...r, score: '0.1000' }));
    const forward = compareAuditResults(prev, cur);
    const reversed = compareAuditResults([...prev].reverse(), [...cur].reverse());
    expect(forward).toEqual(reversed);
    expect(forward.map((r) => r.url)).toEqual(['https://a.test/', 'https://b.test/', 'https://c.test/']);
  });
});

describe('summarizeScores', () => {
  it('averages per category and reports null (not 0) for an unmeasured category', () => {
    expect(
      summarizeScores([
        { category: 'a11y', score: '1.0000' },
        { category: 'a11y', score: '0.5000' },
        { category: 'seo', score: '0.3333' },
        { category: 'perf', score: null },
      ])
    ).toEqual({ a11y: 0.75, seo: 0.3333, perf: null });
  });

  it('keeps a genuine zero as 0', () => {
    expect(summarizeScores([{ category: 'perf', score: '0.0000' }]).perf).toBe(0);
  });
});
