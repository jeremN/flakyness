import { describe, it, expect } from 'vitest';
import {
  formatDate,
  formatDateTime,
  formatDuration,
  runDurationMs,
  getPassRate,
  getPassRateClass,
  trendTooltipLabel,
} from './format';

describe('formatDate', () => {
  it('returns the em dash for null', () => {
    expect(formatDate(null)).toBe('—');
  });
  it('includes the year and omits the time', () => {
    const out = formatDate('2026-03-15T13:45:00.000Z');
    expect(out).toContain('2026');
    expect(out).not.toMatch(/\d{1,2}:\d{2}/); // no HH:MM
  });
});

describe('formatDateTime', () => {
  it('returns the em dash for null', () => {
    expect(formatDateTime(null)).toBe('—');
  });
  it('includes a HH:MM time and omits the year', () => {
    const out = formatDateTime('2026-03-15T13:45:00.000Z');
    expect(out).toMatch(/\d{1,2}:\d{2}/);
    expect(out).not.toContain('2026');
  });
});

describe('formatDuration', () => {
  it('is the em dash for null', () => expect(formatDuration(null)).toBe('—'));
  it('is milliseconds under 1000', () => expect(formatDuration(999)).toBe('999ms'));
  it('is seconds with one decimal at/above 1000', () =>
    expect(formatDuration(1500)).toBe('1.5s'));
});

describe('runDurationMs', () => {
  it('is null when either side is missing', () => {
    expect(runDurationMs({ startedAt: null, finishedAt: '2026-01-01T00:00:01Z' })).toBeNull();
    expect(runDurationMs({ startedAt: '2026-01-01T00:00:00Z', finishedAt: null })).toBeNull();
  });
  it('is the elapsed milliseconds when both are present', () => {
    expect(
      runDurationMs({ startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:02Z' })
    ).toBe(2000);
  });
});

describe('getPassRate', () => {
  it('is 0 (not NaN) when there are no tests', () =>
    expect(getPassRate({ passed: 0, totalTests: 0 })).toBe(0));
  it('is the percentage passed', () =>
    expect(getPassRate({ passed: 3, totalTests: 4 })).toBe(75));
});

describe('getPassRateClass', () => {
  it('is green at/above 90', () => expect(getPassRateClass(90)).toBe('badge-green'));
  it('is orange in [70,90)', () => {
    expect(getPassRateClass(89.9)).toBe('badge-orange');
    expect(getPassRateClass(70)).toBe('badge-orange');
  });
  it('is red below 70', () => expect(getPassRateClass(69.9)).toBe('badge-red'));
});

describe('trendTooltipLabel', () => {
  it('says "no runs" for a null gap day, never "null%"', () => {
    expect(trendTooltipLabel(null)).toBe('no runs');
  });
  it('is a percent string for a value', () => {
    expect(trendTooltipLabel(12.5)).toBe('12.5%');
  });
});
