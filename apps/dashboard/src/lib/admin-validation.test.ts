import { describe, it, expect } from 'vitest';
import {
  validateNumericField,
  validateWebhookUrl,
  validateWebhookKind,
  validateConfigForm,
  buildConfigPatch,
  CONFIG_FIELD_SPECS,
} from './admin-validation';

describe('validateNumericField', () => {
  const intSpec = { min: 1, max: 90, integer: true };
  const floatSpec = { min: 0, max: 1, integer: false };

  it('treats empty/whitespace as valid (reset-to-default)', () => {
    expect(validateNumericField('', intSpec)).toBeNull();
    expect(validateNumericField('   ', intSpec)).toBeNull();
  });
  it('rejects non-numbers', () => {
    expect(validateNumericField('abc', intSpec)).toBe('must be a number');
  });
  it('rejects a decimal for an integer field', () => {
    expect(validateNumericField('1.5', intSpec)).toBe('must be a whole number');
  });
  it('accepts a decimal for a float field', () => {
    expect(validateNumericField('0.25', floatSpec)).toBeNull();
  });
  it('rejects below min and above max (inclusive bounds pass)', () => {
    expect(validateNumericField('0', intSpec)).toBe('must be between 1 and 90');
    expect(validateNumericField('91', intSpec)).toBe('must be between 1 and 90');
    expect(validateNumericField('1', intSpec)).toBeNull();
    expect(validateNumericField('90', intSpec)).toBeNull();
  });
});

describe('validateWebhookUrl', () => {
  it('empty is valid', () => expect(validateWebhookUrl('')).toBeNull());
  it('accepts http and https', () => {
    expect(validateWebhookUrl('http://x.test/hook')).toBeNull();
    expect(validateWebhookUrl('https://hooks.slack.com/x')).toBeNull();
  });
  it('rejects a non-http(s) protocol', () => {
    expect(validateWebhookUrl('ftp://x.test')).toBe('must use http or https');
  });
  it('rejects an unparseable URL', () => {
    expect(validateWebhookUrl('not a url')).toBe('must be a valid URL');
  });
  it('accepts exactly 2048 chars', () => {
    const url = 'https://x.test/' + 'a'.repeat(2048 - 'https://x.test/'.length);
    expect(url.length).toBe(2048);
    expect(validateWebhookUrl(url)).toBeNull();
  });
  it('rejects over 2048 chars', () => {
    expect(validateWebhookUrl('https://x.test/' + 'a'.repeat(2048))).toBe(
      'must be at most 2048 characters'
    );
  });
});

describe('validateWebhookKind', () => {
  it('empty is valid', () => expect(validateWebhookKind('')).toBeNull());
  it('accepts slack and generic', () => {
    expect(validateWebhookKind('slack')).toBeNull();
    expect(validateWebhookKind('generic')).toBeNull();
  });
  it('rejects anything else', () => {
    expect(validateWebhookKind('teams')).toBe("must be 'slack' or 'generic'");
  });
});

describe('validateConfigForm', () => {
  it('is valid when everything is empty', () => {
    expect(validateConfigForm({})).toEqual({ valid: true, errors: {} });
  });
  it('collects a per-field error message', () => {
    const r = validateConfigForm({ windowDays: '0', webhookKind: 'teams' });
    expect(r.valid).toBe(false);
    expect(r.errors.windowDays).toBe('must be between 1 and 90');
    expect(r.errors.webhookKind).toBe("must be 'slack' or 'generic'");
  });
  it('flags retentionDays below windowDays as a cross-field error', () => {
    const r = validateConfigForm({ windowDays: '30', retentionDays: '10' });
    expect(r.valid).toBe(false);
    expect(r.errors.retentionDays).toBe('must be at least the flake window (windowDays)');
  });
  it('does not cross-check when only one of the two is set', () => {
    expect(validateConfigForm({ retentionDays: '10' }).valid).toBe(true);
  });
  it('does not cross-check when windowDays is set and retentionDays is blank', () => {
    expect(validateConfigForm({ windowDays: '30', retentionDays: '' }).valid).toBe(true);
  });
  it('accepts retentionDays equal to windowDays (boundary: < not <=)', () => {
    const r = validateConfigForm({ windowDays: '30', retentionDays: '30' });
    expect(r.valid).toBe(true);
    expect(r.errors.retentionDays).toBeUndefined();
  });
});

describe('buildConfigPatch', () => {
  it('maps empty numeric fields to null (reset) and parses set ones', () => {
    const patch = buildConfigPatch({ flakeThreshold: '', windowDays: '14' }, false);
    expect(patch.flakeThreshold).toBeNull();
    expect(patch.windowDays).toBe(14);
  });
  it('maps empty webhook fields to null and keeps set strings verbatim', () => {
    const patch = buildConfigPatch(
      { webhookUrl: '', webhookKind: 'slack' },
      false
    );
    expect(patch.webhookUrl).toBeNull();
    expect(patch.webhookKind).toBe('slack');
  });
  it('always includes autoQuarantineEnabled as a boolean, never null', () => {
    expect(buildConfigPatch({}, true).autoQuarantineEnabled).toBe(true);
    expect(buildConfigPatch({}, false).autoQuarantineEnabled).toBe(false);
  });
  it('emits every nullable numeric key even when the form omits it', () => {
    const patch = buildConfigPatch({}, false);
    for (const key of Object.keys(CONFIG_FIELD_SPECS)) {
      expect(patch[key]).toBeNull();
    }
  });
});
