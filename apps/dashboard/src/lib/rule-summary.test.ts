import { describe, it, expect } from 'vitest';
import { describeRule } from './rule-summary';
import type { QuarantineRule } from '../app.d';

function rule(overrides: Partial<QuarantineRule> = {}): QuarantineRule {
  return {
    id: 'r1', projectId: 'p1', position: 0, name: null, enabled: true,
    selectorBranch: null, selectorFile: null, selectorTag: null,
    action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: 0.3,
    minRuns: 5, windowDays: 14, consecutiveFailures: null, ttlDays: null,
    createdAt: 'x', updatedAt: 'x', ...overrides,
  };
}

describe('describeRule', () => {
  it('formats a full flake_rate rule with a branch selector', () => {
    expect(describeRule(rule({ selectorBranch: 'main' }))).toBe(
      'main · flake ≥ 0.30 over ≥ 5 runs / 14d'
    );
  });

  it('formats a consecutive rule', () => {
    expect(
      describeRule(rule({ conditionType: 'consecutive', flakeThreshold: null, minRuns: null, consecutiveFailures: 5, selectorFile: '*e2e*' }))
    ).toBe('*e2e* · 5 consecutive fails / 14d');
  });

  it('formats an exempt rule with a selector', () => {
    expect(
      describeRule(rule({ action: 'exempt', conditionType: null, flakeThreshold: null, minRuns: null, windowDays: null, selectorFile: 'release/*' }))
    ).toBe('exempt · release/*');
  });

  it('formats an exempt rule with no selectors as "all tests"', () => {
    expect(
      describeRule(rule({ action: 'exempt', conditionType: null, flakeThreshold: null, minRuns: null, windowDays: null }))
    ).toBe('exempt · all tests');
  });

  it('omits the scope prefix when a quarantine rule has no selectors', () => {
    expect(describeRule(rule())).toBe('flake ≥ 0.30 over ≥ 5 runs / 14d');
  });

  it('joins multiple selectors and prefixes a tag with #', () => {
    expect(
      describeRule(rule({ selectorBranch: 'main', selectorFile: 'a.spec.ts', selectorTag: 'smoke' }))
    ).toBe('main a.spec.ts #smoke · flake ≥ 0.30 over ≥ 5 runs / 14d');
  });

  it('drops the runs/window clauses when those fields are null', () => {
    expect(describeRule(rule({ minRuns: null, windowDays: null }))).toBe('flake ≥ 0.30');
  });
});
