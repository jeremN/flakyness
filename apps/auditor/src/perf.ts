import type { Check, Device, Issue } from './types';

/**
 * Performance scoring from lab Web Vitals.
 *
 * The score uses Lighthouse's method — each metric mapped through a log-normal
 * curve defined by its p10 and median control points, then a weighted mean —
 * with Lighthouse 10+'s curves and weights. Speed Index is not measured, so
 * its weight (10) is dropped and the rest renormalised over 90.
 *
 * It is NOT a Lighthouse score and must not be presented as one: the lab
 * conditions differ (CPU throttling only, no simulated network throttling).
 * What it is good for is the trend of one page under stable conditions, which
 * is exactly what regression detection compares.
 */

export interface PerfMetrics {
  /** Largest Contentful Paint, ms. */
  lcp?: number;
  /** First Contentful Paint, ms. */
  fcp?: number;
  /** Cumulative Layout Shift, unitless. */
  cls?: number;
  /** Total Blocking Time, ms (sum of long-task time over 50ms after FCP). */
  tbt?: number;
  /** Time To First Byte, ms. */
  ttfb?: number;
}

interface Curve {
  p10: number;
  median: number;
}

// Lighthouse 10+ scoring control points.
export const CURVES: Record<Device, Record<'fcp' | 'lcp' | 'tbt' | 'cls', Curve>> = {
  mobile: {
    fcp: { p10: 1800, median: 3000 },
    lcp: { p10: 2500, median: 4000 },
    tbt: { p10: 200, median: 600 },
    cls: { p10: 0.1, median: 0.25 },
  },
  desktop: {
    fcp: { p10: 934, median: 1600 },
    lcp: { p10: 1200, median: 2400 },
    tbt: { p10: 150, median: 350 },
    cls: { p10: 0.1, median: 0.25 },
  },
};

export const WEIGHTS = { fcp: 10, lcp: 25, tbt: 30, cls: 25 } as const;

// web.dev "good / needs improvement / poor" boundaries, used for issues (the
// score answers "how good", issues answer "what to fix").
export const THRESHOLDS: Record<keyof PerfMetrics, { good: number; poor: number; unit: string; label: string }> = {
  lcp: { good: 2500, poor: 4000, unit: 'ms', label: 'Largest Contentful Paint' },
  fcp: { good: 1800, poor: 3000, unit: 'ms', label: 'First Contentful Paint' },
  cls: { good: 0.1, poor: 0.25, unit: '', label: 'Cumulative Layout Shift' },
  tbt: { good: 200, poor: 600, unit: 'ms', label: 'Total Blocking Time' },
  ttfb: { good: 800, poor: 1800, unit: 'ms', label: 'Time To First Byte' },
};

/**
 * CLS the way Core Web Vitals defines it: shifts are grouped into session
 * windows (a gap of >= 1s, or a window longer than 5s, starts a new one) and
 * CLS is the LARGEST window's sum — not the total over the page's life.
 * Shifts caused by recent user input are expected to be filtered out by the
 * collector already. Input: [startTime ms, value] in any order.
 */
export function computeCls(shifts: ReadonlyArray<readonly [number, number]>): number {
  const sorted = [...shifts].sort((a, b) => a[0] - b[0]);
  let max = 0;
  let windowSum = 0;
  let windowStart = -Infinity;
  let previous = -Infinity;
  for (const [start, value] of sorted) {
    if (start - previous >= 1000 || start - windowStart >= 5000) {
      windowSum = 0;
      windowStart = start;
    }
    windowSum += value;
    previous = start;
    max = Math.max(max, windowSum);
  }
  return max;
}

/**
 * Total Blocking Time: for every long task that ENDS after FCP, the part of it
 * after FCP that exceeds 50ms. A task straddling FCP is clipped to start at FCP
 * (as Lighthouse does) rather than dropped. Lighthouse bounds the window by
 * TTI; we bound it by the end of the settle window instead (the collector
 * simply stops listening), which is the documented lab difference.
 * Input: [startTime ms, duration ms].
 */
export function computeTbt(
  longTasks: ReadonlyArray<readonly [number, number]>,
  fcp: number | undefined
): number | undefined {
  if (fcp === undefined) return undefined;
  return longTasks.reduce((sum, [start, duration]) => {
    const end = start + duration;
    if (end <= fcp) return sum;
    const clipped = end - Math.max(start, fcp);
    return sum + Math.max(0, clipped - 50);
  }, 0);
}

/** Abramowitz & Stegun 7.1.26 — the same approximation Lighthouse uses. */
export function erf(x: number): number {
  const sign = Math.sign(x);
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
  return sign * (1 - y * Math.exp(-ax * ax));
}

/**
 * Lighthouse's log-normal score: 0.9 at `p10`, 0.5 at `median`, →1 as the
 * value →0 and →0 as it grows. Clamped to [0, 1].
 */
export function logNormalScore({ p10, median }: Curve, value: number): number {
  if (value <= 0) return 1;
  const INVERSE_ERFC_ONE_FIFTH = 0.9061938024368232;
  const xLogRatio = Math.log(Math.max(Number.MIN_VALUE, value / median));
  const p10LogRatio = -Math.log(Math.max(Number.MIN_VALUE, p10 / median));
  const standardizedX = (xLogRatio * INVERSE_ERFC_ONE_FIFTH) / p10LogRatio;
  const score = (1 - erf(standardizedX)) / 2;
  return Math.min(1, Math.max(0, score));
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

function formatValue(metric: keyof PerfMetrics, value: number): string {
  return metric === 'cls' ? value.toFixed(3) : `${Math.round(value)} ms`;
}

/**
 * Turn measured metrics into a perf check.
 *
 * The score is `null` when any scored metric (fcp/lcp/tbt/cls) is missing —
 * a partial weighted mean would silently change meaning between runs, and a
 * changing meaning is a fake regression. Issues are still reported for the
 * metrics that were measured.
 */
export function scorePerf(metrics: PerfMetrics, device: Device): Check {
  const curves = CURVES[device];
  const scored = (Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>).map((m) => ({
    metric: m,
    value: metrics[m],
  }));

  let score: number | null = null;
  if (scored.every((s) => typeof s.value === 'number' && Number.isFinite(s.value))) {
    const totalWeight = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    const weighted = scored.reduce(
      (sum, s) => sum + WEIGHTS[s.metric] * logNormalScore(curves[s.metric], s.value as number),
      0
    );
    score = round(weighted / totalWeight, 4);
  }

  const issues: Issue[] = [];
  const recorded: Record<string, number> = {};
  for (const metric of Object.keys(THRESHOLDS) as Array<keyof PerfMetrics>) {
    const value = metrics[metric];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    recorded[metric] = metric === 'cls' ? round(value, 4) : Math.round(value);

    const t = THRESHOLDS[metric];
    if (value > t.poor) {
      issues.push({
        id: `${metric}-poor`,
        severity: 'serious',
        message: `${t.label} is ${formatValue(metric, value)} (poor: > ${formatValue(metric, t.poor)})`,
      });
    } else if (value > t.good) {
      issues.push({
        id: `${metric}-needs-improvement`,
        severity: 'moderate',
        message: `${t.label} is ${formatValue(metric, value)} (good: <= ${formatValue(metric, t.good)})`,
      });
    }
  }

  return {
    category: 'perf',
    score,
    ...(Object.keys(recorded).length > 0 ? { metrics: recorded } : {}),
    issues,
  };
}
