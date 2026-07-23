import { describe, it, expect, afterEach, vi } from 'vitest';
import { deliverNotification } from './deliver';
import type { FlakyTransitionEvent, QuarantineEvent } from './events';

const flaky: FlakyTransitionEvent = {
  kind: 'flaky_transition',
  project: { id: 'p-1', name: 'demo' },
  newlyFlaky: ['t'],
  newlyResolved: [],
  run: { branch: 'main', commitSha: 'abc' },
};

afterEach(() => vi.restoreAllMocks());

function captureBody() {
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(null, { status: 200 }));
  return () => JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
}

describe('deliverNotification', () => {
  it('formats generic for a non-Slack URL (default) and returns transport success', async () => {
    const body = captureBody();
    const ok = await deliverNotification({
      url: 'https://x.io/hook',
      storedKind: null,
      baseUrl: null,
      event: flaky,
    });
    expect(ok).toBe(true);
    expect(body().event).toBe('flaky_tests_changed');
  });

  it('formats Slack when the resolved kind is slack (explicit override)', async () => {
    const body = captureBody();
    await deliverNotification({
      url: 'https://x.io/hook',
      storedKind: 'slack',
      baseUrl: null,
      event: flaky,
    });
    expect(body().text).toBeDefined();
    expect(body().blocks).toBeDefined();
  });

  it('injects deep-links into the body when a base URL is configured', async () => {
    const body = captureBody();
    await deliverNotification({
      url: 'https://x.io/hook',
      storedKind: null,
      baseUrl: 'https://d.io',
      event: flaky,
    });
    expect(body().dashboardUrl).toBe('https://d.io/flaky');
  });

  it('passes the testName to buildLinks for a quarantine event (test deep-link present in body)', async () => {
    const quarantine: QuarantineEvent = {
      kind: 'quarantine',
      transition: 'entered',
      project: { id: 'p-1', name: 'demo' },
      testName: 'login test',
      flakeRate: 0.42,
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    const body = captureBody();
    await deliverNotification({
      url: 'https://x.io/hook',
      storedKind: 'slack',
      baseUrl: 'https://d.io',
      event: quarantine,
    });
    // buildLinks got a defined testName → Slack text carries the /tests/<encoded> deep-link
    expect(body().text).toContain('https://d.io/tests/login%20test');
  });

  it('does NOT pass a testName for a flaky event (no /tests/ deep-link in body)', async () => {
    const body = captureBody();
    await deliverNotification({
      url: 'https://x.io/hook',
      storedKind: 'slack',
      baseUrl: 'https://d.io',
      event: flaky,
    });
    expect(body().text).not.toContain('/tests/');
  });
});
