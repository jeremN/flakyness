import { describe, it, expect } from 'vitest';
import { globToRegExp, evaluateRules, type EvalRule, type TestSliceResult } from './rules';

const at = (iso: string) => new Date(iso);
// helper: one result row
const r = (status: string, branch = 'main', file = 'e2e/a.spec.ts', tags: string[] = [], iso = '2026-07-24T00:00:00Z'): TestSliceResult =>
  ({ status, branch, testFile: file, tags, createdAt: at(iso) });

describe('globToRegExp', () => {
  it('* matches within a path segment but not across /', () => {
    expect(globToRegExp('release/*').test('release/1.0')).toBe(true);
    expect(globToRegExp('release/*').test('release/1.0/rc')).toBe(false);
  });
  it('** matches across segments', () => {
    expect(globToRegExp('e2e/**').test('e2e/sub/a.spec.ts')).toBe(true);
  });
  it('is anchored full-string (no partial match)', () => {
    expect(globToRegExp('main').test('maintenance')).toBe(false);
  });
  it('escapes regex metacharacters in the literal parts', () => {
    expect(globToRegExp('a.b').test('a.b')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
  it('? matches exactly one char within a segment', () => {
    expect(globToRegExp('a?c').test('abc')).toBe(true);
    expect(globToRegExp('a?c').test('a/c')).toBe(false);
    expect(globToRegExp('a?c').test('ac')).toBe(false);
  });
});

// A base rule; individual tests override fields.
const rule = (o: Partial<EvalRule>): EvalRule => ({
  id: 'r1', position: 0, action: 'quarantine', conditionType: 'flake_rate',
  selectorBranch: null, selectorFile: null, selectorTag: null,
  flakeThreshold: 0.5, minRuns: 2, windowDays: 14, consecutiveFailures: null, ttlDays: 7, ...o,
});

describe('evaluateRules — matching + first-match-wins', () => {
  it('returns no-match when no rule selector matches the slice', () => {
    const d = evaluateRules([rule({ selectorBranch: 'release/*' })], [r('failed', 'main')]);
    expect(d.kind).toBe('no-match');
  });
  it('a matching exempt rule owns the decision and stops evaluation', () => {
    const rules = [rule({ id: 'r1', position: 0, action: 'exempt', conditionType: null, selectorTag: 'critical' }),
                   rule({ id: 'r2', position: 1 })];
    const d = evaluateRules(rules, [r('failed', 'main', 'e2e/a.spec.ts', ['critical']), r('failed')]);
    expect(d).toMatchObject({ kind: 'exempt', ruleId: 'r1' });
  });
  it('a non-matching rule is skipped so a later rule can own the decision', () => {
    // ruleA's selector excludes every result in the slice; ruleB is a wildcard
    // quarantine rule whose condition fires. Proves the outer loop `continue`s
    // past ruleA rather than aborting evaluation.
    const ruleA = rule({ id: 'r1', position: 0, selectorBranch: 'release/*' });
    const ruleB = rule({ id: 'r2', position: 1, flakeThreshold: 0.5, minRuns: 1 });
    const d = evaluateRules([ruleA, ruleB], [r('failed', 'main')]);
    expect(d).toMatchObject({ kind: 'quarantine', ruleId: 'r2' });
  });
  it('a result missing the selector tag falls outside the rule slice', () => {
    const only = rule({ selectorTag: 'critical', flakeThreshold: 0.5, minRuns: 1 });
    const d = evaluateRules([only], [r('failed', 'main', 'e2e/a.spec.ts', [])]);
    expect(d).toMatchObject({ kind: 'no-match' });
  });
  it('AND-combines provided selectors; an omitted selector is a wildcard', () => {
    const only = rule({ selectorBranch: 'main', selectorFile: 'e2e/**' });
    expect(evaluateRules([only], [
      r('failed', 'main', 'e2e/x.spec.ts'),
      r('passed', 'main', 'e2e/x.spec.ts')
    ]).kind).toBe('quarantine');
    expect(evaluateRules([only], [r('failed', 'main', 'unit/x.spec.ts')]).kind).toBe('no-match');
  });
});

describe('evaluateRules — flake_rate condition (on the matching slice)', () => {
  it('fires when slice flake-rate >= threshold over >= minRuns', () => {
    const d = evaluateRules([rule({ flakeThreshold: 0.5, minRuns: 2 })],
      [r('failed'), r('passed'), r('failed')]); // 2/3 = 0.67
    expect(d).toMatchObject({ kind: 'quarantine', ruleId: 'r1', ttlDays: 7 });
  });
  it('does not fire below minRuns even if rate is high (rule still owns → leave)', () => {
    const d = evaluateRules([rule({ minRuns: 5 })], [r('failed')]);
    expect(d).toMatchObject({ kind: 'leave' }); // matched a quarantine rule, condition did not fire
  });
  it('flaky counts toward the numerator like failed', () => {
    const d = evaluateRules([rule({ flakeThreshold: 0.5, minRuns: 2 })], [r('flaky'), r('passed')]); // 1/2 = 0.5
    expect(d.kind).toBe('quarantine');
  });
});

describe('evaluateRules — consecutive condition', () => {
  const consec = (k: number) => rule({ conditionType: 'consecutive', consecutiveFailures: k, flakeThreshold: null, minRuns: null });
  it('fires on K failed in a row from the newest result', () => {
    const d = evaluateRules([consec(3)], [
      r('failed', 'main', 'e2e/a.spec.ts', [], '2026-07-24T03:00:00Z'),
      r('failed', 'main', 'e2e/a.spec.ts', [], '2026-07-24T02:00:00Z'),
      r('failed', 'main', 'e2e/a.spec.ts', [], '2026-07-24T01:00:00Z'),
      r('passed', 'main', 'e2e/a.spec.ts', [], '2026-07-24T00:00:00Z'),
    ]);
    expect(d.kind).toBe('quarantine');
  });
  it('a passed OR flaky result resets the streak', () => {
    // Four results (not three) so a break-vs-continue mutation is
    // distinguishable: correct code (`break`) stops accumulating at the
    // flaky result, so the two failures behind it never count toward the
    // streak; a `break` → `continue` mutation would let them accumulate
    // past the threshold instead.
    const d = evaluateRules([consec(3)], [
      r('failed', 'main', 'e2e/a.spec.ts', [], '2026-07-24T04:00:00Z'),
      r('flaky',  'main', 'e2e/a.spec.ts', [], '2026-07-24T03:00:00Z'),
      r('failed', 'main', 'e2e/a.spec.ts', [], '2026-07-24T02:00:00Z'),
      r('failed', 'main', 'e2e/a.spec.ts', [], '2026-07-24T01:00:00Z'),
    ]);
    expect(d.kind).toBe('leave'); // only 1 in a row from newest
  });
  it('skipped is ignored — it neither increments nor resets', () => {
    const d = evaluateRules([consec(2)], [
      r('failed',  'main', 'e2e/a.spec.ts', [], '2026-07-24T03:00:00Z'),
      r('skipped', 'main', 'e2e/a.spec.ts', [], '2026-07-24T02:00:00Z'),
      r('failed',  'main', 'e2e/a.spec.ts', [], '2026-07-24T01:00:00Z'),
    ]);
    expect(d.kind).toBe('quarantine'); // 2 failed with a skipped between
  });
});
