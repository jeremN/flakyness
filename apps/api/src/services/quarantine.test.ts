import { describe, it, expect } from 'vitest';
import { resolveQuarantineConfig, DEFAULT_QUARANTINE } from './quarantine';

const base = {
  flakeThreshold: null, windowDays: null, minRuns: null,
  autoQuarantineEnabled: false, quarantineThreshold: null, quarantineMinRuns: null, quarantineTtlDays: null,
};

describe('resolveQuarantineConfig', () => {
  it('uses defaults when all overrides are null', () => {
    expect(resolveQuarantineConfig(base)).toEqual({ enabled: false, threshold: DEFAULT_QUARANTINE.threshold, minRuns: 3, ttlDays: DEFAULT_QUARANTINE.ttlDays });
  });
  it('reads stored overrides', () => {
    expect(resolveQuarantineConfig({ ...base, autoQuarantineEnabled: true, quarantineThreshold: '0.3500', quarantineMinRuns: 5, quarantineTtlDays: 14 }))
      .toEqual({ enabled: true, threshold: 0.35, minRuns: 5, ttlDays: 14 });
  });
  it('defaults minRuns to the resolved flakiness minRuns', () => {
    expect(resolveQuarantineConfig({ ...base, minRuns: 8 }).minRuns).toBe(8);
  });
});
