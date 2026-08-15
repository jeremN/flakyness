import { describe, it, expect } from 'vitest';
import { SESSION_COOKIE, parseSessionCookie, redirectTargetFor } from './session';

describe('parseSessionCookie', () => {
  it('extracts the token from a realistic API Set-Cookie header', () => {
    const header = `${SESSION_COOKIE}=abc123; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax`;
    expect(parseSessionCookie(header)).toBe('abc123');
  });

  it('finds it when other cookies precede it', () => {
    const header = `other=1; Path=/, ${SESSION_COOKIE}=xyz; Path=/; HttpOnly`;
    expect(parseSessionCookie(header)).toBe('xyz');
  });

  it('returns null when the header is absent', () => {
    expect(parseSessionCookie(null)).toBeNull();
  });

  it('returns null when the header carries no session cookie', () => {
    expect(parseSessionCookie('other=1; Path=/')).toBeNull();
  });

  it('returns null for an empty value rather than an empty-string token', () => {
    expect(parseSessionCookie(`${SESSION_COOKIE}=; Path=/`)).toBeNull();
  });

  it('does not match a cookie whose name merely ends with ours', () => {
    expect(parseSessionCookie(`not_${SESSION_COOKIE}=nope; Path=/`)).toBeNull();
  });
});

describe('redirectTargetFor', () => {
  const user = { id: 'u1', email: 'a@b.c', displayName: null, isGlobalAdmin: false, mustChangePassword: false };

  it('sends an anonymous visitor to /login', () => {
    expect(redirectTargetFor(null, '/flaky')).toBe('/login');
  });

  it('leaves an anonymous visitor already on /login alone (no redirect loop)', () => {
    expect(redirectTargetFor(null, '/login')).toBeNull();
  });

  it('sends a signed-in user away from /login', () => {
    expect(redirectTargetFor(user, '/login')).toBe('/');
  });

  it('lets a signed-in user through anywhere else', () => {
    expect(redirectTargetFor(user, '/flaky')).toBeNull();
  });

  it('forces a must-change-password user to /change-password from any page', () => {
    const forced = { ...user, mustChangePassword: true };
    expect(redirectTargetFor(forced, '/flaky')).toBe('/change-password');
    expect(redirectTargetFor(forced, '/admin')).toBe('/change-password');
  });

  it('does not trap a must-change-password user on /change-password itself', () => {
    const forced = { ...user, mustChangePassword: true };
    expect(redirectTargetFor(forced, '/change-password')).toBeNull();
  });

  it('lets a must-change-password user reach /logout — they must be able to leave', () => {
    const forced = { ...user, mustChangePassword: true };
    expect(redirectTargetFor(forced, '/logout')).toBeNull();
  });
});
