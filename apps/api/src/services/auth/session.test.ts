import { describe, it, expect } from 'vitest';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SESSION_SLIDE_AFTER_MS,
  generateSessionToken,
  hashSessionToken,
  sessionExpiry,
  isSessionExpired,
  shouldSlideSession,
} from './session';

describe('session tokens', () => {
  it('generates 256 bits of entropy, hex-encoded', () => {
    expect(generateSessionToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not repeat across calls', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateSessionToken()));
    expect(tokens.size).toBe(50);
  });

  it('hashes to a 64-char hex digest that fits the varchar(64) column', () => {
    expect(hashSessionToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes deterministically (the same token always finds the same row)', () => {
    expect(hashSessionToken('abc')).toBe(hashSessionToken('abc'));
  });

  it('hashes distinctly (two sessions cannot collide)', () => {
    expect(hashSessionToken('abc')).not.toBe(hashSessionToken('abd'));
  });

  it('never returns the raw token from the hash', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).not.toBe(token);
  });
});

describe('session expiry', () => {
  const now = new Date('2026-08-01T12:00:00.000Z');

  it('expires exactly SESSION_TTL_MS after issue', () => {
    expect(sessionExpiry(now).getTime()).toBe(now.getTime() + SESSION_TTL_MS);
  });

  it('is 7 days', () => {
    expect(SESSION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('treats a future expiry as live', () => {
    expect(isSessionExpired({ expiresAt: new Date(now.getTime() + 1) }, now)).toBe(false);
  });

  it('treats a past expiry as dead', () => {
    expect(isSessionExpired({ expiresAt: new Date(now.getTime() - 1) }, now)).toBe(true);
  });

  it('treats the exact expiry instant as dead (boundary is inclusive)', () => {
    expect(isSessionExpired({ expiresAt: new Date(now.getTime()) }, now)).toBe(true);
  });
});

describe('sliding TTL', () => {
  const now = new Date('2026-08-01T12:00:00.000Z');

  it('is 1 hour', () => {
    expect(SESSION_SLIDE_AFTER_MS).toBe(60 * 60 * 1000);
  });

  it('does not write on every request (that would be a write per page view)', () => {
    const lastSeenAt = new Date(now.getTime() - 1000);
    expect(shouldSlideSession({ lastSeenAt }, now)).toBe(false);
  });

  it('slides once the last-seen stamp is older than the threshold', () => {
    const lastSeenAt = new Date(now.getTime() - SESSION_SLIDE_AFTER_MS - 1);
    expect(shouldSlideSession({ lastSeenAt }, now)).toBe(true);
  });

  it('does not slide exactly at the threshold (strictly greater)', () => {
    const lastSeenAt = new Date(now.getTime() - SESSION_SLIDE_AFTER_MS);
    expect(shouldSlideSession({ lastSeenAt }, now)).toBe(false);
  });

  it('slides well inside the TTL, so an active session never expires under the user', () => {
    expect(SESSION_SLIDE_AFTER_MS).toBeLessThan(SESSION_TTL_MS);
  });
});

describe('cookie name', () => {
  it('is fk_session (the dashboard and docs both hardcode it)', () => {
    expect(SESSION_COOKIE).toBe('fk_session');
  });
});
