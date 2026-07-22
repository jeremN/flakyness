import { describe, it, expect } from 'vitest';
import { formatSlack } from './slack';
import type { FlakyTransitionEvent, QuarantineEvent } from '../events';

const flaky: FlakyTransitionEvent = {
  kind: 'flaky_transition',
  project: { id: 'p-1', name: 'demo' },
  newlyFlaky: ['login test'],
  newlyResolved: [],
  run: { branch: 'main', commitSha: 'abc' },
};

describe('formatSlack', () => {
  it('always includes a non-empty text fallback mirrored in a blocks section', () => {
    const body = formatSlack(flaky, { dashboard: null, test: null });
    expect(typeof body.text).toBe('string');
    expect(body.text.length).toBeGreaterThan(0);
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.blocks[0]).toMatchObject({
      type: 'section',
      text: { type: 'mrkdwn', text: body.text },
    });
  });

  it('renders the project as a mrkdwn link when a dashboard link is present', () => {
    const body = formatSlack(flaky, { dashboard: 'https://x.io/flaky', test: null });
    expect(body.text).toContain('<https://x.io/flaky|*demo*>');
    expect(body.text).toContain('login test');
  });

  it('renders the project as plain text (no link markup) when no link is present', () => {
    const body = formatSlack(flaky, { dashboard: null, test: null });
    expect(body.text).toContain('*demo*');
    expect(body.text).not.toContain('<');
  });

  it('summarizes a quarantine entered event with test link, rate and TTL date', () => {
    const entered: QuarantineEvent = {
      kind: 'quarantine',
      transition: 'entered',
      project: { id: 'p-1', name: 'demo' },
      testName: 'login test',
      flakeRate: 0.42,
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    const body = formatSlack(entered, { dashboard: null, test: 'https://x.io/tests/login%20test' });
    expect(body.text).toContain('🔒');
    expect(body.text).toContain('<https://x.io/tests/login%20test|login test>');
    expect(body.text).toContain('42%');
    expect(body.text).toContain('2026-08-01');
  });

  it('summarizes a quarantine released event', () => {
    const released: QuarantineEvent = {
      kind: 'quarantine',
      transition: 'released',
      project: { id: 'p-1', name: 'demo' },
      testName: 'login test',
      flakeRate: null,
      expiresAt: null,
    };
    const body = formatSlack(released, { dashboard: null, test: null });
    expect(body.text).toContain('🔓');
    expect(body.text).toContain('released');
  });
});
