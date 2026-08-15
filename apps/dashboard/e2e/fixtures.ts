import { test as base, expect } from '@playwright/test';

/**
 * Gives every Playwright WORKER its own client IP, so the API's per-IP rate
 * limiters (`apiRateLimit`, `authRateLimit` —
 * apps/api/src/middleware/rate-limit.ts) key each worker into a SEPARATE
 * bucket, exactly as they would for separate real users behind a trusted
 * reverse proxy in production. Requires two other pieces, wired up alongside
 * this file:
 *  - the API run with `TRUSTED_PROXY_IPS` covering the loopback address the
 *    dashboard (and this test runner) connect from — see
 *    `.github/workflows/ci.yml`'s `e2e` job env and AGENTS.md;
 *  - the dashboard run with `ADDRESS_HEADER=x-forwarded-for`
 *    (`playwright.config.ts`'s `webServer.env`), so `event.getClientAddress()`
 *    reads this header instead of the raw socket address. The dashboard
 *    already threads that value into every API call as `X-Forwarded-For`
 *    (`createApi`, `createAdminApi`, `fetchMe`) — this fixture is the only
 *    new piece; the whole chain otherwise already existed for delta §D1.
 *
 * Task 8 fix round 1 (BLOCKING #2): replaces an earlier attempt that tuned
 * `workers` down to reduce how often the suite's own traffic tripped the
 * ONE shared bucket every worker used to sit in — that never eliminated the
 * risk, only reduced it (see the Task 8 report's per-run reproduction data).
 * Splitting the bucket per worker is the real fix, and it happens to make
 * this suite genuinely exercise delta §D1's production path end to end,
 * which Definition-of-done bullet 1 was reaching for.
 *
 * Every spec in this suite must import `test`/`expect` from here, not
 * directly from `@playwright/test` — the override lives on the `context`
 * fixture, which the built-in `page` fixture (and `page.request`) are
 * derived from, so importing this file is the only change a spec needs.
 */
export const test = base.extend<Record<string, never>, { workerForwardedFor: string }>({
  workerForwardedFor: [
    // Playwright requires the first param to be an object-destructuring
    // pattern (even an empty one, since this fixture has no dependencies) —
    // it statically parses this signature to build the fixture dependency
    // graph, so `_noFixtureDeps` or similar does NOT work here, only `{}`.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      // Private, non-routable, and distinct from global-setup.ts's own
      // seeding identity (10.99.0.0) — worker indices are 0-based and stable
      // for the whole run (this repo runs with retries: 0, so an index is
      // never reassigned mid-run).
      await use(`10.99.1.${workerInfo.workerIndex + 1}`);
    },
    { scope: 'worker' },
  ],

  context: async ({ context, workerForwardedFor }, use) => {
    await context.setExtraHTTPHeaders({ 'x-forwarded-for': workerForwardedFor });
    await use(context);
  },
});

export { expect };
