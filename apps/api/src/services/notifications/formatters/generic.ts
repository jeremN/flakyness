import type { DeepLinks } from '../links';
import type { NotificationEvent } from '../events';

/**
 * The generic (default) webhook body — a FROZEN backward-compatibility contract.
 * These shapes match what services/notifications.ts emitted before the channel
 * refactor, so existing operator webhooks keep working byte-for-byte. The only
 * change is `dashboardUrl` on the flaky payload, which was always present as a
 * (documented, reserved) `null` and now carries `links.dashboard` when
 * DASHBOARD_BASE_URL is configured. The quarantine payload never had a
 * dashboardUrl field — do NOT add one here.
 */
export function formatGeneric(event: NotificationEvent, links: DeepLinks): unknown {
  if (event.kind === 'flaky_transition') {
    return {
      event: 'flaky_tests_changed',
      project: event.project,
      newlyFlaky: event.newlyFlaky,
      newlyResolved: event.newlyResolved,
      run: event.run,
      dashboardUrl: links.dashboard,
    };
  }
  return {
    event: event.transition === 'entered' ? 'quarantine_entered' : 'quarantine_released',
    project: event.project,
    testName: event.testName,
    flakeRate: event.flakeRate,
    expiresAt: event.expiresAt ? event.expiresAt.toISOString() : null,
  };
}
