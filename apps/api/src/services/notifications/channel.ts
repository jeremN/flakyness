export type WebhookKind = 'slack' | 'generic';

/**
 * Decide which channel formatter to use for `url`.
 *
 * An explicit `storedKind` ('slack' | 'generic', set by the operator on the
 * project) always wins — this is how a self-hosted Mattermost URL, which
 * accepts Slack's payload but lives on a private host, opts into Slack
 * formatting. Any other value (null, or an unexpected string) falls through to
 * host sniffing: only Slack's own incoming-webhook host resolves to 'slack';
 * everything else (including Mattermost) defaults to 'generic'.
 */
export function resolveWebhookKind(url: string, storedKind: string | null): WebhookKind {
  if (storedKind === 'slack' || storedKind === 'generic') return storedKind;
  try {
    if (new URL(url).host.toLowerCase() === 'hooks.slack.com') return 'slack';
  } catch {
    // Unparseable URL — fall through to generic; delivery will best-effort fail.
  }
  return 'generic';
}
