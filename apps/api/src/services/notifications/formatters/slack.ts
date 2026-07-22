import type { DeepLinks } from '../links';
import type { NotificationEvent, FlakyTransitionEvent, QuarantineEvent } from '../events';

/**
 * Slack incoming-webhook body. `text` is a plain mrkdwn summary — Slack's
 * required notification fallback and the part Mattermost (partial Block Kit
 * support) renders reliably; `blocks` is the richer rendering that degrades to
 * `text`. Deep-links render as mrkdwn `<url|label>` when present, plain `label`
 * otherwise. Slack- and Mattermost-compatible.
 */
export function formatSlack(
  event: NotificationEvent,
  links: DeepLinks
): { text: string; blocks: unknown[] } {
  const text =
    event.kind === 'flaky_transition' ? flakyText(event, links) : quarantineText(event, links);
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

function link(label: string, url: string | null): string {
  return url ? `<${url}|${label}>` : label;
}

function flakyText(event: FlakyTransitionEvent, links: DeepLinks): string {
  const project = link(`*${event.project.name}*`, links.dashboard);
  const parts: string[] = [];
  if (event.newlyFlaky.length > 0) {
    parts.push(`⚠️ ${event.newlyFlaky.length} newly flaky: ${event.newlyFlaky.join(', ')}`);
  }
  if (event.newlyResolved.length > 0) {
    parts.push(`✅ ${event.newlyResolved.length} resolved: ${event.newlyResolved.join(', ')}`);
  }
  return `${project} on \`${event.run.branch}\` — ${parts.join('  ·  ')}`;
}

function quarantineText(event: QuarantineEvent, links: DeepLinks): string {
  const project = link(`*${event.project.name}*`, links.dashboard);
  const test = link(event.testName, links.test);
  if (event.transition === 'entered') {
    const rate = event.flakeRate != null ? ` (flake rate ${(event.flakeRate * 100).toFixed(0)}%)` : '';
    const until = event.expiresAt ? `, muted until ${event.expiresAt.toISOString().slice(0, 10)}` : '';
    return `🔒 ${project}: quarantined ${test}${rate}${until}`;
  }
  return `🔓 ${project}: released ${test} from quarantine`;
}
