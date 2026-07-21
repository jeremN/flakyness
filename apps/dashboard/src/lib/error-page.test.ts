import { describe, it, expect } from 'vitest';
import { errorTitle, errorIcon } from './error-page';

describe('errorTitle', () => {
  it('maps the known statuses', () => {
    expect(errorTitle(404)).toBe('Page Not Found');
    expect(errorTitle(403)).toBe('Access Denied');
    expect(errorTitle(500)).toBe('Server Error');
  });
  it('falls back for anything else', () =>
    expect(errorTitle(418)).toBe('Something Went Wrong'));
});

describe('errorIcon', () => {
  it('maps the known statuses', () => {
    expect(errorIcon(404)).toBe('🔍');
    expect(errorIcon(403)).toBe('🔒');
    expect(errorIcon(500)).toBe('⚠️');
  });
  it('falls back for anything else', () => expect(errorIcon(418)).toBe('❌'));
});
