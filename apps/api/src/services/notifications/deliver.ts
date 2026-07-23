import { resolveWebhookKind } from './channel';
import { buildLinks } from './links';
import { formatGeneric } from './formatters/generic';
import { formatSlack } from './formatters/slack';
import { postWebhook } from './transport';
import type { NotificationEvent } from './events';

export interface DeliverOptions {
  url: string;
  storedKind: string | null;
  baseUrl: string | null | undefined;
  event: NotificationEvent;
}

/**
 * Resolve the channel, build deep-links, format the event for that channel, and
 * POST it best-effort. Returns the transport's success boolean for the caller to
 * log. The single entry point routes/reports.ts calls — replaces the old
 * sendFlakyTransitionWebhook / sendQuarantineWebhook pair.
 */
export async function deliverNotification(opts: DeliverOptions): Promise<boolean> {
  const kind = resolveWebhookKind(opts.url, opts.storedKind);
  const testName = opts.event.kind === 'quarantine' ? opts.event.testName : undefined;
  const links = buildLinks(opts.baseUrl, testName);
  const body = kind === 'slack' ? formatSlack(opts.event, links) : formatGeneric(opts.event, links);
  return postWebhook(opts.url, body);
}
