import { describe, it, expect } from 'vitest';
import { MIN_PASSWORD_LENGTH } from './password';
import {
  TEAM_ROLES,
  generateTempPassword,
  canRemoveGlobalAdmin,
  normaliseEmail,
} from './membership';

describe('team roles', () => {
  it('is exactly team_admin and member (global admin lives on users, not memberships)', () => {
    expect([...TEAM_ROLES]).toEqual(['team_admin', 'member']);
  });
});

describe('generateTempPassword', () => {
  it('satisfies the policy it will immediately be checked against', () => {
    expect(generateTempPassword().length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  });

  it('clears the minimum with real margin, so trimming the byte count cannot silently creep back toward the floor', () => {
    // Documented design intent is double the minimum (18 random bytes ==
    // 24 base64url chars for a 12-char MIN_PASSWORD_LENGTH). Asserting the
    // margin — not just the floor above — means shrinking the byte count
    // while still technically clearing MIN_PASSWORD_LENGTH still reds this.
    expect(generateTempPassword().length).toBeGreaterThanOrEqual(2 * MIN_PASSWORD_LENGTH);
  });

  it('is URL-safe so it survives being copied out of a terminal or a form field', () => {
    expect(generateTempPassword()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('draws from a wide alphabet rather than a narrow or degenerate one', () => {
    // Guards against a "predictable source" masquerading as random — e.g. a
    // constant byte, or an encoding (hex) that still passes the URL-safe
    // regex above but halves the usable alphabet. Over many samples, base64url
    // output should exercise digits, upper- and lower-case letters.
    const samples = Array.from({ length: 50 }, generateTempPassword).join('');
    expect(samples).toMatch(/[0-9]/);
    expect(samples).toMatch(/[a-z]/);
    expect(samples).toMatch(/[A-Z]/);
  });

  it('does not repeat', () => {
    const generated = new Set(Array.from({ length: 100 }, generateTempPassword));
    expect(generated.size).toBe(100);
  });
});

describe('canRemoveGlobalAdmin', () => {
  it('refuses when this is the last one — a zero-admin install is unrecoverable', () => {
    expect(canRemoveGlobalAdmin(1)).toBe(false);
  });

  it('refuses on a nonsensical count rather than opening the door', () => {
    expect(canRemoveGlobalAdmin(0)).toBe(false);
  });

  it('allows when another global admin remains', () => {
    expect(canRemoveGlobalAdmin(2)).toBe(true);
  });
});

describe('normaliseEmail', () => {
  it('lower-cases', () => {
    expect(normaliseEmail('Ada@Example.IO')).toBe('ada@example.io');
  });

  it('trims surrounding whitespace (pasted addresses carry it)', () => {
    expect(normaliseEmail('  ada@example.io \n')).toBe('ada@example.io');
  });

  it('leaves an already-normal address alone', () => {
    expect(normaliseEmail('ada@example.io')).toBe('ada@example.io');
  });
});
