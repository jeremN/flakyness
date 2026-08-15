import { describe, it, expect } from 'vitest';
import { validatePasswordChange, MIN_PASSWORD_LENGTH } from './password-form';

function raw(o: Partial<Record<'currentPassword' | 'newPassword' | 'confirmPassword', string>> = {}) {
  return {
    currentPassword: 'old-secret-1',
    newPassword: 'new-secret-123',
    confirmPassword: 'new-secret-123',
    ...o,
  };
}

describe('validatePasswordChange', () => {
  it('accepts a well-formed submission', () => {
    expect(validatePasswordChange(raw())).toBeNull();
  });

  it('rejects an empty current password', () => {
    expect(validatePasswordChange(raw({ currentPassword: '' }))).toBe('Enter your current password.');
  });

  it('rejects an empty new password', () => {
    expect(validatePasswordChange(raw({ newPassword: '', confirmPassword: '' }))).toBe(
      'Enter a new password.'
    );
  });

  // Boundary pair: proves the comparison is strictly `<`, not `<=` or `<`
  // pointed the wrong way. Mutating `<` to `<=` in the implementation would
  // flip the 12-character case below to a rejection and redden it; mutating
  // it to `>` or dropping the check would let the 11-character case through
  // and redden that one instead. Neither mutant survives both tests.
  it(`rejects a new password one character shorter than MIN_PASSWORD_LENGTH (${MIN_PASSWORD_LENGTH - 1} chars)`, () => {
    const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);
    expect(validatePasswordChange(raw({ newPassword: short, confirmPassword: short }))).toBe(
      `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`
    );
  });

  it(`accepts a new password exactly MIN_PASSWORD_LENGTH characters long (${MIN_PASSWORD_LENGTH})`, () => {
    const exact = 'a'.repeat(MIN_PASSWORD_LENGTH);
    expect(validatePasswordChange(raw({ newPassword: exact, confirmPassword: exact }))).toBeNull();
  });

  it('rejects a mismatched confirmation', () => {
    expect(validatePasswordChange(raw({ confirmPassword: 'something-else-123' }))).toBe(
      'New password and confirmation do not match.'
    );
  });

  it('checks length before match, so a short mismatched password reports the length error', () => {
    // Pins the check ORDER: a password that is both too short AND mismatched
    // must report the length error, not the mismatch error — otherwise
    // fixing the length in isolation (without re-checking the match) could
    // look like progress when it isn't. Mutating the order in the
    // implementation (match before length) would redden this while leaving
    // the two single-cause tests above green.
    expect(validatePasswordChange(raw({ newPassword: 'short', confirmPassword: 'different' }))).toBe(
      `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`
    );
  });
});
