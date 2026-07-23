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

  it('renders a resolved-only event with the ✅ branch and no ⚠️', () => {
    const resolvedOnly: FlakyTransitionEvent = {
      kind: 'flaky_transition',
      project: { id: 'p-1', name: 'demo' },
      newlyFlaky: [],
      newlyResolved: ['checkout test'],
      run: { branch: 'main', commitSha: 'abc' },
    };
    const body = formatSlack(resolvedOnly, { dashboard: null, test: null });
    expect(body.text).toContain('✅');
    expect(body.text).toContain('1 resolved');
    expect(body.text).toContain('checkout test');
    expect(body.text).not.toContain('⚠️');
  });

  it('renders both branches with the separator when flaky and resolved co-occur', () => {
    const both: FlakyTransitionEvent = {
      kind: 'flaky_transition',
      project: { id: 'p-1', name: 'demo' },
      newlyFlaky: ['a'],
      newlyResolved: ['b'],
      run: { branch: 'main', commitSha: 'abc' },
    };
    const body = formatSlack(both, { dashboard: null, test: null });
    expect(body.text).toContain('⚠️');
    expect(body.text).toContain('✅');
    expect(body.text).toContain('·');
  });

  it('escapes mrkdwn special chars in user-controlled strings (no live link injection)', () => {
    const evil: FlakyTransitionEvent = {
      kind: 'flaky_transition',
      project: { id: 'p-1', name: 'a<b>&c' },
      newlyFlaky: ['<https://evil.example|Click>'],
      newlyResolved: [],
      run: { branch: 'main', commitSha: 'abc' },
    };
    const body = formatSlack(evil, { dashboard: null, test: null });
    expect(body.text).toContain('a&lt;b&gt;&amp;c');
    expect(body.text).not.toContain('<https://evil.example|Click>');
  });

  it('neutralizes a backtick in the branch so it cannot break out of the code span', () => {
    const evilBranch: FlakyTransitionEvent = {
      kind: 'flaky_transition',
      project: { id: 'p-1', name: 'demo' },
      newlyFlaky: ['a'],
      newlyResolved: [],
      run: { branch: 'main`<https://evil.example|x>', commitSha: 'abc' },
    };
    const body = formatSlack(evilBranch, { dashboard: null, test: null });
    // the injected backtick must be gone (no code-span breakout freeing the <..|..> into a live link)
    expect(body.text).not.toContain('`<https://evil.example|x>');
    // only the two intended code-span delimiters remain — an odd count would mean a broken span
    expect((body.text.match(/`/g) || []).length).toBe(2);
  });

  it('escapes mrkdwn special chars in a quarantine event project name and test name', () => {
    const evil: QuarantineEvent = {
      kind: 'quarantine',
      transition: 'entered',
      project: { id: 'p-1', name: 'a<b>&c' },
      testName: '<https://evil.example|owned>',
      flakeRate: 0.42,
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    const body = formatSlack(evil, { dashboard: null, test: null });
    expect(body.text).toContain('a&lt;b&gt;&amp;c');
    expect(body.text).not.toContain('<https://evil.example|owned>');
  });
});
