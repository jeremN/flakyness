import { describe, it, expect } from 'vitest';
import { formatGeneric } from './generic';
import type { FlakyTransitionEvent, QuarantineEvent } from '../events';

const flaky: FlakyTransitionEvent = {
  kind: 'flaky_transition',
  project: { id: 'p-1', name: 'demo' },
  newlyFlaky: ['test a'],
  newlyResolved: ['test c'],
  run: { branch: 'main', commitSha: 'a'.repeat(40) },
};

describe('formatGeneric — frozen backward-compat contract', () => {
  it('emits the legacy flaky_tests_changed payload with dashboardUrl null when no base URL', () => {
    expect(formatGeneric(flaky, { dashboard: null, test: null })).toEqual({
      event: 'flaky_tests_changed',
      project: { id: 'p-1', name: 'demo' },
      newlyFlaky: ['test a'],
      newlyResolved: ['test c'],
      run: { branch: 'main', commitSha: 'a'.repeat(40) },
      dashboardUrl: null,
    });
  });

  it('populates dashboardUrl from the resolved link when a base URL is set', () => {
    const body = formatGeneric(flaky, { dashboard: 'https://x.io/flaky', test: null }) as {
      dashboardUrl: string;
    };
    expect(body.dashboardUrl).toBe('https://x.io/flaky');
  });

  it('emits the legacy quarantine_entered payload (no dashboardUrl field)', () => {
    const entered: QuarantineEvent = {
      kind: 'quarantine',
      transition: 'entered',
      project: { id: 'p-1', name: 'demo' },
      testName: 'login test',
      flakeRate: 0.42,
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    expect(
      formatGeneric(entered, { dashboard: 'https://x.io/flaky', test: 'https://x.io/tests/login%20test' })
    ).toEqual({
      event: 'quarantine_entered',
      project: { id: 'p-1', name: 'demo' },
      testName: 'login test',
      flakeRate: 0.42,
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('maps a released transition to quarantine_released with null expiresAt', () => {
    const released: QuarantineEvent = {
      kind: 'quarantine',
      transition: 'released',
      project: { id: 'p-1', name: 'demo' },
      testName: 'login test',
      flakeRate: null,
      expiresAt: null,
    };
    const body = formatGeneric(released, { dashboard: null, test: null }) as {
      event: string;
      expiresAt: null;
    };
    expect(body.event).toBe('quarantine_released');
    expect(body.expiresAt).toBeNull();
  });
});
