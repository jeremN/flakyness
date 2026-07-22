import { describe, it, expect, afterEach, vi } from 'vitest';
import { deliverNotification } from './deliver';
import type { FlakyTransitionEvent } from './events';

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
});
