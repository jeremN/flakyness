import { describe, it, expect, afterEach, vi } from 'vitest';
import { postWebhook } from './transport';

afterEach(() => vi.restoreAllMocks());

describe('postWebhook', () => {
  it('POSTs JSON and returns true on a 2xx response', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const ok = await postWebhook('https://example.com/hook', { a: 1 });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ a: 1 }),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('returns false on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    expect(await postWebhook('https://example.com/hook', {})).toBe(false);
  });

  it('returns false when fetch rejects (network error / timeout)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('aborted'));
    expect(await postWebhook('https://example.com/hook', {})).toBe(false);
  });
});
