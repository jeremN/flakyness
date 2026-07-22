/**
 * Outbound webhook delivery for flaky-test transition notifications.
 *
 * v1 scope: one best-effort POST per ingest, no retries, no signing. The
 * webhook URL is set only by the admin (admin-token route) — same trust
 * level as the operator's shell, so no SSRF deny-list here (see docs/API.md).
 */

export interface FlakyTransitionPayload {
  event: 'flaky_tests_changed';
  project: { id: string; name: string };
  newlyFlaky: string[];
  newlyResolved: string[];
  run: { branch: string; commitSha: string };
  dashboardUrl: null;
}

/**
 * POST the transition payload to `url`. Never throws — network errors,
 * timeouts, and non-2xx responses all resolve to `false` so the caller can
 * log-and-swallow without special-casing failure modes.
 */
export async function sendFlakyTransitionWebhook(
  url: string,
  payload: FlakyTransitionPayload
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface QuarantineWebhookPayload {
  event: 'quarantine_entered' | 'quarantine_released';
  project: { id: string; name: string };
  testName: string;
  flakeRate: number | null;
  expiresAt: string | null; // ISO, only for entered
}

/**
 * POST the quarantine transition payload to `url`. Never throws — same
 * best-effort contract as `sendFlakyTransitionWebhook`: network errors,
 * timeouts, and non-2xx responses all resolve to `false`.
 */
export async function sendQuarantineWebhook(
  url: string,
  payload: QuarantineWebhookPayload
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
