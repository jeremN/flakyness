import { describe, it, expect } from 'vitest';
import { SESSION_COOKIE, SESSION_COOKIE_PATH, parseSessionCookie, redirectTargetFor, ESCAPE_HATCHES } from './session';

// Minor #5 (task 6 review round 1): every call site imports this constant, so
// no other assertion in the suite pins its VALUE — mutating it to '/wrong'
// left all 366 node tests green. A wrong path would silently break every
// session cookie (set/delete mismatch) with green CI until the Task 8 E2E
// suite catches it.
it('pins the session cookie path', () => {
  expect(SESSION_COOKIE_PATH).toBe('/');
});

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

/**
 * The API calls each dashboard escape-hatch route makes. Hard-coded rather than
 * derived: this is a CONTRACT, and the test's value is that changing either
 * side forces a deliberate edit here.
 */
const ESCAPE_HATCH_API_CALLS = [
  { route: '/change-password', method: 'POST', path: '/api/v1/auth/change-password' },
  { route: '/logout', method: 'POST', path: '/api/v1/auth/logout' },
  // Not a route the user visits — the session gate calls it on EVERY request,
  // so a mid-reset user cannot render any page without it.
  { route: '<session gate>', method: 'GET', path: '/api/v1/auth/me' },
];

it('every dashboard escape hatch has a row describing its API calls', () => {
  // Closes the other half of the contract: ESCAPE_HATCHES (session.ts) says
  // which pages a mid-reset user may reach; ESCAPE_HATCH_API_CALLS says what
  // those pages call. If a route is added to one and not the other, this
  // fails — a new hatch page would otherwise be free to call an endpoint no
  // one has checked against the API's allowlist below.
  for (const route of ESCAPE_HATCHES) {
    expect(
      ESCAPE_HATCH_API_CALLS.some((c) => c.route === route),
      `ESCAPE_HATCHES lists ${route}, but ESCAPE_HATCH_API_CALLS does not say which ` +
        `API calls that route makes — so nothing checks them against the API allowlist.`
    ).toBe(true);
  }
});

it('every API call reachable while mid-reset is on the API allowlist', () => {
  // Hard-coded MIRROR of apps/api/src/services/auth/access.ts's
  // PASSWORD_CHANGE_ALLOWLIST, not a derivation from it — this file cannot
  // import server code. That means editing the real PASSWORD_CHANGE_ALLOWLIST
  // in access.ts does NOT redden this test; only editing this copy does. It
  // catches drift on the dashboard side (a hatch route calling something not
  // in this mirror) but not drift on the API side (the mirror going stale
  // against the real list) — keeping the two in sync is on whoever edits
  // either file to check the other by hand.
  //
  // The staleness is bidirectional, and this table is equally hand-maintained
  // against the DASHBOARD side too: ESCAPE_HATCH_API_CALLS is not derived from
  // the actual route files, so editing e.g. logout/+page.server.ts's endpoint
  // (say, to /api/v1/auth/signout) only reddens that route's own
  // page.server.test.ts — this file stays green regardless, because it only
  // checks the hard-coded table above against the hard-coded allowlist below,
  // never the real route source. Editing a route and its own test together
  // leaves this contract table silently stale (finding #7, task 6 review
  // round 1). Comment only — no deriving mechanism is being built for this.
  const apiAllowlist = [
    { method: 'POST', path: '/api/v1/auth/change-password' },
    { method: 'GET', path: '/api/v1/auth/me' },
    { method: 'HEAD', path: '/api/v1/auth/me' },
    { method: 'POST', path: '/api/v1/auth/logout' },
    { method: 'POST', path: '/api/v1/auth/login' },
  ];

  for (const call of ESCAPE_HATCH_API_CALLS) {
    expect(
      apiAllowlist.some((a) => a.method === call.method && a.path === call.path),
      `Dashboard route ${call.route} calls ${call.method} ${call.path} while the ` +
        `user is mid-reset, but that request is NOT on the API's ` +
        `PASSWORD_CHANGE_ALLOWLIST. The gate will answer 403 ` +
        `password_change_required, the page cannot load, and the user is locked ` +
        `out of password recovery with no way forward.`
    ).toBe(true);
  }
});
