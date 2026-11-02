import { describe, it, expect } from 'vitest';
import { summarizeAxe, IMPACT_WEIGHT, type AxeRuleResult } from './a11y';
import { MAX_ISSUES_PER_CHECK } from './types';

const rule = (id: string, impact: string | null, nodes = 1, help = `${id} help`): AxeRuleResult => ({
  id,
  impact,
  help,
  nodes: Array.from({ length: nodes }, () => ({})),
});

describe('summarizeAxe', () => {
  it('scores null when no rule applied (nothing was measured)', () => {
    expect(summarizeAxe({ violations: [], passes: [] })).toEqual({ category: 'a11y', score: null, issues: [] });
  });

  it('scores 1 when every applicable rule passes', () => {
    expect(summarizeAxe({ violations: [], passes: [rule('a', null), rule('b', null)] }).score).toBe(1);
  });

  it('weights violations by impact against passes (moderate weight each)', () => {
    const passes = [rule('p1', null), rule('p2', null)]; // 2 x 3 = 6
    const critical = summarizeAxe({ violations: [rule('v', 'critical')], passes }).score; // 6 / (6 + 10)
    const minor = summarizeAxe({ violations: [rule('v', 'minor')], passes }).score; // 6 / (6 + 1)
    expect(critical).toBeCloseTo(6 / (6 + IMPACT_WEIGHT.critical), 4);
    expect(minor).toBeCloseTo(6 / (6 + IMPACT_WEIGHT.minor), 4);
  });

  it('counts a rule once however many elements violate it; element count goes in `count`', () => {
    const one = summarizeAxe({ violations: [rule('image-alt', 'critical', 1)], passes: [rule('p', null)] });
    const many = summarizeAxe({ violations: [rule('image-alt', 'critical', 40)], passes: [rule('p', null)] });
    expect(many.score).toBe(one.score);
    expect(many.issues[0]).toEqual({ id: 'image-alt', severity: 'critical', message: 'image-alt help', count: 40 });
  });

  it('treats an unknown or missing impact as moderate', () => {
    const check = summarizeAxe({ violations: [rule('x', null), rule('y', 'weird')], passes: [] });
    expect(check.issues.map((i) => i.severity)).toEqual(['moderate', 'moderate']);
  });

  it('orders issues by severity, then id', () => {
    const check = summarizeAxe({
      violations: [rule('b', 'minor'), rule('z', 'critical'), rule('a', 'critical'), rule('m', 'serious')],
      passes: [],
    });
    expect(check.issues.map((i) => i.id)).toEqual(['a', 'z', 'm', 'b']);
  });

  it(`caps issues at ${MAX_ISSUES_PER_CHECK} (the API limit) while still scoring every violation`, () => {
    const violations = Array.from({ length: MAX_ISSUES_PER_CHECK + 5 }, (_, i) => rule(`r${i}`, 'minor'));
    const check = summarizeAxe({ violations, passes: [] });
    expect(check.issues).toHaveLength(MAX_ISSUES_PER_CHECK);
    expect(check.score).toBe(0);
  });
});
