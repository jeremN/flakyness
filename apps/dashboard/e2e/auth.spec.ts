import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const API_URL = process.env.PUBLIC_API_URL ?? 'http://127.0.0.1:8080';

// Not a real secret: this only ever lives inside a throwaway E2E database,
// recreated fresh on every run. Only needs to satisfy the API's
// MIN_PASSWORD_LENGTH (12) and differ from whatever temporary password the
// admin-users endpoint issues for a given test's user.
const NEW_PASSWORD = 'e2e-auth-spec-new-password';

interface ProvisionedUser {
  email: string;
  temporaryPassword: string;
}

/**
 * Provision a fresh user via the real API. Every test in this file gets its
 * own account — none of them reuse the shared, already-onboarded seed admin
 * that global-setup.ts creates for every OTHER spec in this suite, because
 * these tests exist specifically to exercise the login/forced-reset flow
 * that account has already been walked through once.
 */
async function createUser(
  request: APIRequestContext,
  opts: { isGlobalAdmin?: boolean } = {}
): Promise<ProvisionedUser> {
  if (!ADMIN_TOKEN) {
    throw new Error('ADMIN_TOKEN must be set to run auth.spec.ts — it provisions users via the admin API.');
  }
  const email = `e2e-auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const res = await request.post(`${API_URL}/api/v1/admin/users`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    data: { email, isGlobalAdmin: opts.isGlobalAdmin ?? false },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { temporaryPassword: string };
  return { email, temporaryPassword: body.temporaryPassword };
}

/**
 * Sign in with a just-issued temporary password. A freshly provisioned user
 * is ALWAYS forced to /change-password here (see $lib/session.ts's
 * redirectTargetFor) — this helper stops there, deliberately, so the caller
 * can assert on the forced state before completing the reset itself.
 */
async function signInWithTemporaryPassword(page: Page, user: ProvisionedUser): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.temporaryPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.pathname === '/change-password');
}

test.describe('authentication', () => {
  // Every test in this block must start with NO session — overrides the
  // shared, already-signed-in storageState every OTHER spec in this suite
  // relies on (playwright.config.ts's use.storageState, populated by
  // global-setup.ts) to skip /login entirely.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('an anonymous visit to any route redirects to /login; no redirect loop on /login itself', async ({
    page,
  }) => {
    await page.goto('/flaky');
    await expect(page).toHaveURL(/\/login$/);
    // Reloading /login itself, still anonymous, must not bounce anywhere —
    // a redirect loop here would hang the navigation instead of resolving.
    await page.goto('/login');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('wrong credentials show the error and stay on /login', async ({ page }) => {
    const user = await createUser(page.request);

    await page.goto('/login');
    await page.getByLabel('Email', { exact: true }).fill(user.email);
    await page.getByLabel('Password', { exact: true }).fill('definitely-the-wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toHaveText('Invalid email or password.');
    await expect(page).toHaveURL(/\/login$/);
  });

  // One continuous account lifecycle rather than N independent tests each
  // re-provisioning a user and re-authenticating from scratch: authRateLimit
  // is a real 10-requests-per-60s-per-IP budget (apps/api/src/routes/auth.ts)
  // shared by EVERY /login and /change-password call this whole E2E run
  // makes — including global-setup.ts's own sign-in — and this suite runs
  // with no TRUSTED_PROXY_IPS to separate callers (there is only one real
  // machine originating all of this traffic, in CI and locally alike). Each
  // independent test in the original draft of this file cost 1-3 of those
  // requests; chaining the five properties below into one journey keeps the
  // whole file's auth-endpoint cost at 3 requests total, comfortably under
  // budget while still proving each property with its own assertion.
  test('a forced-reset user: cannot navigate away, reaches / after changing and stays signed in, signs in again directly, signs out, and the back button does not restore the session', async ({
    page,
    context,
  }) => {
    const user = await createUser(page.request);

    // 1) Forced onto /change-password, and cannot navigate away from it.
    await signInWithTemporaryPassword(page, user);
    await expect(page).toHaveURL(/\/change-password$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/change-password$/);
    await page.goto('/flaky');
    await expect(page).toHaveURL(/\/change-password$/);

    // 2) Completing the change reaches / and the new cookie actually
    // authenticates the very next request — the re-issued-cookie property
    // from Task 5, the one that fails silently in a unit test. A broken
    // re-issue would strand this on /change-password or bounce it to /login.
    await page.getByLabel('Current password', { exact: true }).fill(user.temporaryPassword);
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel('Confirm new password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.reload();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

    // 3) Signing in again with the now-permanent password lands directly on
    // / — mustChangePassword is cleared, so there's no second forced detour.
    await context.clearCookies();
    await page.goto('/login');
    await page.getByLabel('Email', { exact: true }).fill(user.email);
    await page.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/$/);

    // 4) Sign-out returns to /login. /logout carries no password, so it
    // isn't under authRateLimit (apiRateLimit's much looser 100/min
    // instead) and doesn't add to the budget this test is already careful
    // about above.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);

    // 5) The back button must NOT restore the pre-sign-out page. This used to
    // be a genuine gap (the dashboard set no Cache-Control on authenticated
    // pages, so Chromium's bfcache was free to restore the frozen page
    // without hooks.server.ts's gate running again — a bfcache restore
    // replays the frame rather than issuing a new request). A first attempt
    // at covering this was a `test.fail()` reproduction, but it proved
    // genuinely nondeterministic across runs (bfcache is a Chromium
    // heuristic, not a guarantee — one run reproduced the stale page every
    // time, a later run on identical code passed instead). Task 8 fix round
    // 1 added `Cache-Control: no-store` on every HTML document response
    // (hooks.server.ts), which makes this a real, deterministic contract
    // instead of a heuristic to race — the browser is TOLD not to cache the
    // page, not merely observed to sometimes not.
    await page.goBack();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('temp password reveal (admin console)', () => {
  // Uses the shared, already-authenticated global admin from
  // playwright.config.ts's default storageState (see global-setup.ts) — this
  // exercises the admin console's show-once reveal, not the login flow, so it
  // deliberately does NOT override storageState the way the block above does.
  // The create action goes through the ADMIN api (adminRateLimit, exempt for
  // a signed-in session — see hasAdminStanding), not authRateLimit, so it
  // adds nothing to that budget either.
  test("a freshly created user's temporary password is shown exactly once", async ({ page }) => {
    const email = `e2e-reveal-${Date.now()}@example.test`;

    await page.goto('/admin/users');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Create user' }).click();

    const tokenPanel = page.getByTestId('token-reveal');
    await expect(tokenPanel).toBeVisible();
    const passwordText = await tokenPanel.locator('code').textContent();
    expect(passwordText?.trim().length ?? 0).toBeGreaterThan(0);

    // Reload the same page — the temporary password is never re-fetchable
    // (GET /admin/users never returns it), so the reveal must be gone.
    await page.reload();
    await expect(page.getByTestId('token-reveal')).not.toBeVisible();
    await expect(page.getByRole('cell', { name: email })).toBeVisible();
  });
});
