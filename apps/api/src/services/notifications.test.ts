import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  sendFlakyTransitionWebhook,
  type FlakyTransitionPayload,
  sendQuarantineWebhook,
  type QuarantineWebhookPayload,
} from './notifications';

const payload: FlakyTransitionPayload = {
  event: 'flaky_tests_changed',
  project: { id: 'p-1', name: 'demo' },
  newlyFlaky: ['test a'],
  newlyResolved: ['test c'],
  run: { branch: 'main', commitSha: 'a'.repeat(40) },
  dashboardUrl: null,
};

const quarantinePayload: QuarantineWebhookPayload = {
  event: 'quarantine_entered',
  project: { id: 'p-1', name: 'demo' },
  testName: 'flaky spec',
  flakeRate: 0.42,
  expiresAt: '2026-08-01T00:00:00.000Z',
};

describe('sendFlakyTransitionWebhook', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true on a 2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendFlakyTransitionWebhook('http://localhost:9999/hook', payload);

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns false on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    const result = await sendFlakyTransitionWebhook('http://localhost:9999/hook', payload);

    expect(result).toBe(false);
  });

  it('returns false when the network request throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const result = await sendFlakyTransitionWebhook('http://localhost:9999/hook', payload);

    expect(result).toBe(false);
  });

  it('posts JSON with the exact payload and a Content-Type header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendFlakyTransitionWebhook('http://localhost:9999/hook', payload);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9999/hook',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    );
  });

  it('passes an AbortSignal (timeout) with the request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendFlakyTransitionWebhook('http://localhost:9999/hook', payload);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('sendQuarantineWebhook', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true on a 2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendQuarantineWebhook('http://localhost:9999/hook', quarantinePayload);

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns false on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    const result = await sendQuarantineWebhook('http://localhost:9999/hook', quarantinePayload);

    expect(result).toBe(false);
  });

  it('returns false when the network request throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const result = await sendQuarantineWebhook('http://localhost:9999/hook', quarantinePayload);

    expect(result).toBe(false);
  });

  it('posts JSON with the exact payload and a Content-Type header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendQuarantineWebhook('http://localhost:9999/hook', quarantinePayload);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9999/hook',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(quarantinePayload),
      })
    );
  });

  it('passes an AbortSignal (timeout) with the request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendQuarantineWebhook('http://localhost:9999/hook', quarantinePayload);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
