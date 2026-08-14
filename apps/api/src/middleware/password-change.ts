import { Context, MiddlewareHandler } from 'hono';
import { getSessionUser } from './session';
import { isPasswordChangeExempt } from '../services/auth/access';

/**
 * Tagged for the same reason readAuth and resolveAccess are
 * (routes-auth-coverage.test.ts:62-77): every call returns a fresh closure, so
 * a static guard cannot identify mounted gates by reference. Removing
 * `isPasswordChangeGate` makes password-change-coverage.test.ts pass over an
 * empty set — the exact failure mode it exists to eliminate.
 */
export interface PasswordChangeGateMiddleware extends MiddlewareHandler {
  isPasswordChangeGate: true;
}

/**
 * Refuse every request from a session holding an unrotated temporary password,
 * except the handful of METHOD+PATH pairs that let the holder complete the
 * change (PASSWORD_CHANGE_ALLOWLIST). Matching on the pair rather than the
 * path alone is what stops a future method on an already-exempt path — a
 * `DELETE /api/v1/auth/me`, say — from inheriting the exemption silently.
 *
 * MOUNT POINT: `use('*')` inside each router, AFTER that router's rate limiter.
 * NOT `app.use('*')` on the root app. A denial returns without calling next(),
 * so a global mount ahead of the routers would run before every per-router
 * limiter and starve it: a mid-reset session could then send unlimited requests
 * to a non-allowlisted path — each still paying the session lookup in
 * sessionAuth (session.ts:45,49) — and never receive a 429. That is precisely
 * the unthrottled-cookie path plan 056's rate-limiter ruling and its regression
 * test (rate-limit.test.ts:341-361) exist to prevent. A short-circuit is never
 * neutral: everything downstream stops running, including the defences.
 *
 * Returns c.json rather than throwing HTTPException: the global error handler
 * renders exceptions as `c.json({ error: err.message }, err.status)`
 * (index.ts:44-52) and would DROP the `code` field, reproducing Keycloak's
 * opaque `invalid_grant` — the one failure mode this contract exists to avoid.
 */
export function passwordChangeGate(): PasswordChangeGateMiddleware {
  const mw: MiddlewareHandler = async (c: Context, next) => {
    const sessionUser = getSessionUser(c);
    if (!sessionUser?.mustChangePassword) return await next();
    if (isPasswordChangeExempt(c.req.method, c.req.path)) return await next();

    return c.json(
      { error: 'Password change required', code: 'password_change_required' },
      403
    );
  };

  return Object.assign(mw, { isPasswordChangeGate: true as const });
}
