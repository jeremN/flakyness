/**
 * The single best-effort webhook POST shared by every channel formatter.
 * Never throws: network error, timeout, and non-2xx all resolve to `false`,
 * so callers log-and-swallow. 5s timeout, no retries, no signing (v1 contract).
 */
export async function postWebhook(url: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
