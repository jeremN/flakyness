// Pure, browser-safe pre-flight for the change-password form, mirroring the
// API's changePasswordSchema (apps/api/src/routes/auth.ts): length only, no
// character-class rules, matching MIN_PASSWORD_LENGTH
// (apps/api/src/services/auth/password.ts) — NIST SP 800-63B favors length
// over composition. The API stays authoritative; this only blocks an
// obviously-invalid submit before it burns a request against
// /api/v1/auth/change-password, the tightest-rate-limited endpoint in the API
// (authRateLimit, 10 req/60s per IP — see login/+page.server.ts). No I/O, no
// env: safe to import into a .svelte component.

// Must match apps/api/src/services/auth/password.ts's MIN_PASSWORD_LENGTH —
// the two are meant to agree, and this comment is how the next reader finds
// the other side.
export const MIN_PASSWORD_LENGTH = 12;

export interface PasswordChangeFormFields {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

/**
 * Validate a change-password submission locally.
 *
 * Returns the error message to show, or null when the submission is
 * well-formed enough to send to the API. The API still re-validates
 * everything (including whether currentPassword is actually correct) — this
 * only catches what can be decided without a round-trip.
 */
export function validatePasswordChange(raw: PasswordChangeFormFields): string | null {
  if (!raw.currentPassword) return 'Enter your current password.';
  if (!raw.newPassword) return 'Enter a new password.';
  if (raw.newPassword.length < MIN_PASSWORD_LENGTH) {
    return `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (raw.newPassword !== raw.confirmPassword) {
    return 'New password and confirmation do not match.';
  }
  return null;
}
