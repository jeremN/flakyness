import { describe, it, expect } from 'vitest';
import {
  statusBadgeClass,
  flakyStatusBadgeClass,
  trendDirectionLabel,
  trendDirectionBadgeClass,
} from './status';

describe('statusBadgeClass (test-result domain)', () => {
  it('maps each known status', () => {
    expect(statusBadgeClass('passed')).toBe('badge-green');
    expect(statusBadgeClass('failed')).toBe('badge-red');
    expect(statusBadgeClass('flaky')).toBe('badge-orange');
    expect(statusBadgeClass('skipped')).toBe('badge-gray');
  });
  it('falls back to gray for the unknown', () =>
    expect(statusBadgeClass('nonsense')).toBe('badge-gray'));
});

describe('flakyStatusBadgeClass (lifecycle domain — distinct from the above)', () => {
  it('makes active ORANGE, not the gray default', () => {
    // The invariant status.ts documents: unifying with statusBadgeClass would
    // silently turn 'active' gray.
    expect(flakyStatusBadgeClass('active')).toBe('badge-orange');
    expect(statusBadgeClass('active')).toBe('badge-gray'); // proves they differ
  });
  it('maps resolved/ignored', () => {
    expect(flakyStatusBadgeClass('resolved')).toBe('badge-green');
    expect(flakyStatusBadgeClass('ignored')).toBe('badge-gray');
  });
});

describe('trend direction', () => {
  it('labels insufficient-data distinctly from stable', () => {
    expect(trendDirectionLabel('insufficient-data')).toBe('Insufficient data');
    expect(trendDirectionLabel('stable')).toBe('→ Stable');
    expect(trendDirectionLabel('insufficient-data')).not.toBe(
      trendDirectionLabel('stable')
    );
  });
  it('badges worsening red and improving green', () => {
    expect(trendDirectionBadgeClass('worsening')).toBe('badge-red');
    expect(trendDirectionBadgeClass('improving')).toBe('badge-green');
  });
});
