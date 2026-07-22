import { describe, it, expect } from 'vitest';
import { resolveWebhookKind } from './channel';

describe('resolveWebhookKind', () => {
  it('auto-detects a hooks.slack.com URL as slack', () => {
    expect(resolveWebhookKind('https://hooks.slack.com/services/T/B/x', null)).toBe('slack');
  });

  it('auto-detects a self-hosted Mattermost URL as generic', () => {
    expect(resolveWebhookKind('https://mattermost.internal.example/hooks/abc', null)).toBe('generic');
  });

  it('lets an explicit stored kind override auto-detection (Mattermost → slack)', () => {
    expect(resolveWebhookKind('https://mattermost.internal.example/hooks/abc', 'slack')).toBe('slack');
  });

  it('lets an explicit generic override a Slack host', () => {
    expect(resolveWebhookKind('https://hooks.slack.com/services/x', 'generic')).toBe('generic');
  });

  it('auto-detects (ignores) an unrecognized stored value', () => {
    expect(resolveWebhookKind('https://hooks.slack.com/services/x', 'bogus')).toBe('slack');
  });

  it('falls back to generic on an unparseable URL', () => {
    expect(resolveWebhookKind('not a url', null)).toBe('generic');
  });

  it('does not treat a spoofed host containing hooks.slack.com as a substring as slack', () => {
    expect(resolveWebhookKind('https://hooks.slack.com.evil.example/x', null)).toBe('generic');
  });
});
