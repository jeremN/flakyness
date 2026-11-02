import { describe, it, expect } from 'vitest';
import { CURVES, computeCls, computeTbt, erf, logNormalScore, scorePerf, WEIGHTS } from './perf';

describe('erf', () => {
  it('matches known values to the approximation’s precision (~1.5e-7)', () => {
    expect(erf(0)).toBeCloseTo(0, 6);
    expect(erf(0.5)).toBeCloseTo(0.5204999, 6);
    expect(erf(1)).toBeCloseTo(0.8427008, 6);
    expect(erf(-1)).toBeCloseTo(-0.8427008, 6);
    expect(erf(3)).toBeCloseTo(0.9999779, 6);
  });
});

describe('logNormalScore', () => {
  const curve = { p10: 2500, median: 4000 };

  it('is 0.5 at the median and 0.9 at p10 (the curve’s definition)', () => {
    expect(logNormalScore(curve, 4000)).toBeCloseTo(0.5, 4);
    expect(logNormalScore(curve, 2500)).toBeCloseTo(0.9, 4);
  });

  it('is 1 for a zero or negative value', () => {
    expect(logNormalScore(curve, 0)).toBe(1);
    expect(logNormalScore(curve, -5)).toBe(1);
  });

  it('decreases monotonically and stays within [0, 1]', () => {
    let last = 1;
    for (const v of [1, 500, 1000, 2500, 4000, 8000, 20_000, 1e9]) {
      const s = logNormalScore(curve, v);
      expect(s).toBeLessThanOrEqual(last);
      expect(s).toBeGreaterThanOrEqual(0);
      last = s;
    }
  });
});

describe('computeCls (session windows)', () => {
  it('is 0 with no shifts', () => {
    expect(computeCls([])).toBe(0);
  });

  it('sums shifts less than 1s apart into one window', () => {
    expect(computeCls([[100, 0.1], [900, 0.1], [1800, 0.1]])).toBeCloseTo(0.3);
  });

  it('starts a new window after a >=1s gap and keeps the LARGEST window, not the total', () => {
    // Window A = 0.1 + 0.1; gap of 1s; window B = 0.15.
    expect(computeCls([[0, 0.1], [500, 0.1], [1500, 0.15]])).toBeCloseTo(0.2);
    expect(computeCls([[0, 0.05], [1000, 0.3]])).toBeCloseTo(0.3);
  });

  it('caps a window at 5s even when shifts keep coming', () => {
    const shifts = Array.from({ length: 12 }, (_, i) => [i * 900, 0.01] as const); // 0..9900ms
    // First window covers 0..4500 (6 shifts); 5400 >= 0+5000 starts a new one.
    expect(computeCls(shifts)).toBeCloseTo(0.06);
  });

  it('is order-independent', () => {
    expect(computeCls([[1500, 0.15], [0, 0.1], [500, 0.1]])).toBeCloseTo(0.2);
  });
});

describe('computeTbt', () => {
  it('is undefined without FCP (cannot anchor the window)', () => {
    expect(computeTbt([[100, 300]], undefined)).toBeUndefined();
  });

  it('counts only the part of each task beyond 50ms, and only after FCP', () => {
    expect(
      computeTbt(
        [
          [0, 80], // ends before FCP: ignored
          [100, 120], // at FCP: 70
          [300, 50], // exactly 50ms: 0
          [400, 250], // 200
        ],
        100
      )
    ).toBe(270);
  });

  it('clips a task straddling FCP to start at FCP instead of dropping it (review finding)', () => {
    // 500ms task starting 10ms before FCP: 490ms after FCP -> 440ms blocking.
    expect(computeTbt([[90, 500]], 100)).toBe(440);
    // Straddling but under 50ms after FCP: 0.
    expect(computeTbt([[60, 80]], 100)).toBe(0);
  });
});

describe('scorePerf', () => {
  const perfect = { lcp: 1, fcp: 1, cls: 0, tbt: 0, ttfb: 1 };

  it('scores a perfect page 1 with no issues', () => {
    const check = scorePerf(perfect, 'mobile');
    expect(check.score).toBe(1);
    expect(check.issues).toEqual([]);
    expect(check.category).toBe('perf');
  });

  it('scores every metric exactly at its median as 0.5', () => {
    const m = CURVES.mobile;
    const check = scorePerf({ fcp: m.fcp.median, lcp: m.lcp.median, tbt: m.tbt.median, cls: m.cls.median }, 'mobile');
    expect(check.score).toBeCloseTo(0.5, 3);
  });

  it('weights TBT heaviest (30/90): a terrible TBT alone costs about a third', () => {
    const check = scorePerf({ ...perfect, tbt: 1e7 }, 'mobile');
    expect(check.score).toBeCloseTo(1 - WEIGHTS.tbt / 90, 3);
  });

  it('is stricter on desktop than mobile for the same numbers', () => {
    const numbers = { lcp: 2000, fcp: 1500, cls: 0.05, tbt: 250 };
    expect(scorePerf(numbers, 'desktop').score!).toBeLessThan(scorePerf(numbers, 'mobile').score!);
  });

  it('refuses a partial score (null) when a scored metric is missing, but still reports issues', () => {
    const check = scorePerf({ fcp: 5000, cls: 0 }, 'mobile');
    expect(check.score).toBeNull();
    expect(check.issues.map((i) => i.id)).toEqual(['fcp-poor']);
  });

  it('classifies good / needs-improvement / poor on the web.dev boundaries (inclusive good)', () => {
    const ids = (m: Record<string, number>) => scorePerf(m, 'mobile').issues.map((i) => `${i.id}:${i.severity}`);
    expect(ids({ lcp: 2500 })).toEqual([]);
    expect(ids({ lcp: 2501 })).toEqual(['lcp-needs-improvement:moderate']);
    expect(ids({ lcp: 4000 })).toEqual(['lcp-needs-improvement:moderate']);
    expect(ids({ lcp: 4001 })).toEqual(['lcp-poor:serious']);
    expect(ids({ cls: 0.26, ttfb: 900 })).toEqual(['cls-poor:serious', 'ttfb-needs-improvement:moderate']);
  });

  it('records rounded metrics (ms as integers, CLS to 4dp) and omits unmeasured ones', () => {
    const check = scorePerf({ lcp: 1234.56, cls: 0.123456 }, 'mobile');
    expect(check.metrics).toEqual({ lcp: 1235, cls: 0.1235 });
  });

  it('ignores non-finite measurements rather than recording them', () => {
    const check = scorePerf({ lcp: Number.NaN, fcp: Infinity }, 'mobile');
    expect(check.metrics).toBeUndefined();
    expect(check.score).toBeNull();
  });
});
