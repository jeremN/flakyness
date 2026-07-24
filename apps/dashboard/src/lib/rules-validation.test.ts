import { describe, it, expect } from 'vitest';
import { validateRuleForm, buildRulePayload } from './rules-validation';

function raw(o: Record<string, string> = {}): Record<string, string> {
  return { action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: '0.3', ...o };
}

describe('validateRuleForm', () => {
  it('accepts a valid flake_rate quarantine rule', () => {
    expect(validateRuleForm(raw()).valid).toBe(true);
  });

  it('accepts a valid consecutive quarantine rule', () => {
    expect(
      validateRuleForm({ action: 'quarantine', conditionType: 'consecutive', consecutiveFailures: '5' }).valid
    ).toBe(true);
  });

  it('accepts an exempt rule with no condition', () => {
    expect(validateRuleForm({ action: 'exempt' }).valid).toBe(true);
  });

  it('rejects an unknown action', () => {
    const r = validateRuleForm({ action: 'nope' });
    expect(r.valid).toBe(false);
    expect(r.errors.action).toBeTruthy();
  });

  it('rejects an exempt rule that carries a condition', () => {
    const r = validateRuleForm({ action: 'exempt', conditionType: 'flake_rate' });
    expect(r.valid).toBe(false);
    expect(r.errors.action).toBe('exempt rules take no condition');
  });

  it('rejects an exempt rule that carries a threshold value', () => {
    const r = validateRuleForm({ action: 'exempt', flakeThreshold: '0.5' });
    expect(r.valid).toBe(false);
    expect(r.errors.action).toBe('exempt rules take no condition');
  });

  it('rejects a quarantine rule with no condition type', () => {
    const r = validateRuleForm({ action: 'quarantine', conditionType: '' });
    expect(r.valid).toBe(false);
    expect(r.errors.conditionType).toBe('quarantine rules need a condition');
  });

  it('rejects an unknown condition type', () => {
    const r = validateRuleForm({ action: 'quarantine', conditionType: 'weird' });
    expect(r.valid).toBe(false);
    expect(r.errors.conditionType).toBe("must be 'flake_rate' or 'consecutive'");
  });

  it('rejects flake_rate with no threshold', () => {
    const r = validateRuleForm({ action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: '' });
    expect(r.valid).toBe(false);
    expect(r.errors.flakeThreshold).toBe('flake_rate needs a threshold');
  });

  it('rejects consecutive with no failure count', () => {
    const r = validateRuleForm({ action: 'quarantine', conditionType: 'consecutive', consecutiveFailures: '' });
    expect(r.valid).toBe(false);
    expect(r.errors.consecutiveFailures).toBe('consecutive needs a failure count');
  });

  it('rejects an out-of-bounds threshold', () => {
    const r = validateRuleForm(raw({ flakeThreshold: '2' }));
    expect(r.valid).toBe(false);
    expect(r.errors.flakeThreshold).toBeTruthy();
  });

  it('rejects a non-integer minRuns', () => {
    const r = validateRuleForm(raw({ minRuns: '2.5' }));
    expect(r.valid).toBe(false);
    expect(r.errors.minRuns).toBeTruthy();
  });

  it('rejects minRuns below the minimum', () => {
    const r = validateRuleForm(raw({ minRuns: '0' }));
    expect(r.valid).toBe(false);
    expect(r.errors.minRuns).toBeTruthy();
  });

  it('rejects windowDays below the minimum', () => {
    const r = validateRuleForm(raw({ windowDays: '0' }));
    expect(r.valid).toBe(false);
    expect(r.errors.windowDays).toBeTruthy();
  });

  it('rejects windowDays above the maximum', () => {
    const r = validateRuleForm(raw({ windowDays: '91' }));
    expect(r.valid).toBe(false);
    expect(r.errors.windowDays).toBeTruthy();
  });

  it('rejects consecutiveFailures below the minimum', () => {
    const r = validateRuleForm({ action: 'quarantine', conditionType: 'consecutive', consecutiveFailures: '0' });
    expect(r.valid).toBe(false);
    expect(r.errors.consecutiveFailures).toBeTruthy();
  });

  it('rejects ttlDays below the minimum', () => {
    const r = validateRuleForm(raw({ ttlDays: '0' }));
    expect(r.valid).toBe(false);
    expect(r.errors.ttlDays).toBeTruthy();
  });

  it('rejects ttlDays above the maximum', () => {
    const r = validateRuleForm(raw({ ttlDays: '366' }));
    expect(r.valid).toBe(false);
    expect(r.errors.ttlDays).toBeTruthy();
  });

  it('rejects flakeThreshold below the minimum', () => {
    const r = validateRuleForm(raw({ flakeThreshold: '-0.1' }));
    expect(r.valid).toBe(false);
    expect(r.errors.flakeThreshold).toBeTruthy();
  });

  it('rejects flakeThreshold at exactly the maximum', () => {
    const r = validateRuleForm(raw({ flakeThreshold: '1' }));
    expect(r.valid).toBe(true);
  });

  it('rejects minRuns at exactly the maximum', () => {
    const r = validateRuleForm(raw({ minRuns: '100' }));
    expect(r.valid).toBe(true);
  });

  it('accepts windowDays at the maximum', () => {
    const r = validateRuleForm(raw({ windowDays: '90' }));
    expect(r.valid).toBe(true);
  });

  it('accepts consecutiveFailures at the minimum', () => {
    const r = validateRuleForm({ action: 'quarantine', conditionType: 'consecutive', consecutiveFailures: '1' });
    expect(r.valid).toBe(true);
  });

  it('accepts ttlDays at the maximum', () => {
    const r = validateRuleForm(raw({ ttlDays: '365' }));
    expect(r.valid).toBe(true);
  });

  it('accepts flakeThreshold at the minimum', () => {
    const r = validateRuleForm(raw({ flakeThreshold: '0' }));
    expect(r.valid).toBe(true);
  });

  it('accepts minRuns at the minimum', () => {
    const r = validateRuleForm(raw({ minRuns: '1' }));
    expect(r.valid).toBe(true);
  });
});

describe('buildRulePayload', () => {
  it('parses present values and nulls blanks', () => {
    const body = buildRulePayload(raw({ selectorBranch: 'main', minRuns: '5', windowDays: '', name: '' }), true);
    expect(body).toMatchObject({
      action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: 0.3,
      selectorBranch: 'main', minRuns: 5, windowDays: null, name: null, enabled: true,
    });
  });

  it('forces every condition field to null for an exempt rule', () => {
    const body = buildRulePayload({ action: 'exempt', conditionType: 'flake_rate', flakeThreshold: '0.9', consecutiveFailures: '3' }, false);
    expect(body).toMatchObject({
      action: 'exempt', conditionType: null, flakeThreshold: null,
      minRuns: null, windowDays: null, consecutiveFailures: null, enabled: false,
    });
  });

  it('trims selector strings', () => {
    const body = buildRulePayload(raw({ selectorTag: '  smoke  ' }), true);
    expect(body.selectorTag).toBe('smoke');
  });
});
