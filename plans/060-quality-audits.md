# Plan 060: Quality audits (a11y / SEO / perf) as a second ingest path

**Status:** first slice implemented on branch `feat/quality-audits` (API + runner). Dashboard view is the next plan.

## Goal

Flackyness answers "which of my tests are unstable?". This plan adds a second
question: "what is the current quality of these pages, and did it get worse?".
It covers accessibility, on-page SEO and lab performance over a list of URLs,
with regression detection against the previous run.

The first real target is a large public content site: many URL templates,
i18n, canonicals, a consent banner and heavy map pages. That shapes the
defaults (consent click, `canonicalOrigin`, per-branch baselines,
sequential perf).

## Design decisions

1. **A separate ingest path, not a test report.** Audits go to
   `audit_runs` / `audit_results`, never `test_runs` / `test_results`. An audit
   has no pass/fail/flaky status. Feeding it into `updateFlakyTests` would
   pollute flake rates and make quarantine act on things that aren't tests.
2. **The runner is a separate app (`apps/auditor`), not part of the API.** It
   runs where the browser runs (a CI job or a cron), and uploads like any other
   CI reporter, authenticated by the project token. The API never launches a
   browser, so the API image stays small and self-hosters don't need Chromium
   on the server.
3. **No LLM in this slice.** Every check is deterministic (axe-core, DOM
   rules, Web Vitals). Natural-language smoke tests and exploration are a later
   layer. They will produce Playwright specs whose *results* go through the
   existing `/reports` path, so flakiness tracking of generated tests comes
   for free.
4. **Regressions are computed at ingest and returned in the response**
   (`compareAuditResults`, pure, in `services/audits.ts`). A CI job can then
   fail on them without a second request (`--fail-on-regression` → exit 3).
   The read route recomputes with the same function and the same definition
   of "previous": the latest run on the branch with a strictly older
   `createdAt`, via `services/audit-store.ts`. Both returned the same 19
   regressions for the same pair of runs end-to-end. They **can** still
   disagree in one case: two uploads on one branch overlap, and the older one
   commits after the newer one's lookup. Serialize audit jobs per branch in CI
   if that matters. The plan does not claim otherwise.
5. **Baselines are per branch.** A feature-branch audit is never compared
   with production's.
6. **"Not measured" is `null`, never `0`.** This is the same rule as the trend
   endpoint's buckets. It applies to scores, to category means, and to a
   crashed check.
7. **Perf score ≠ Lighthouse.** It uses the same curves and weights, but lab
   conditions differ: CPU throttling only, and no Speed Index. It is documented
   as a trend indicator only.
8. **New issue = new id, not a higher count.** Counts fluctuate with content
   (e.g. number of images). Ids are what a developer can act on.
9. **`commit` is optional on audit ingest**, unlike `/reports`, because a
   scheduled prod audit has no commit.

## What landed

- Migration `0013`: `audit_runs` (timestamptz, `ON DELETE CASCADE` from
  `projects`) and `audit_results` (cascade from `audit_runs`).
- `POST /api/v1/audits`: `projectAuth` → `reportRateLimit` (shared bucket with
  `/reports`) → `passwordChangeGate`. The body is zod-validated. Oversized
  reports are rejected, not truncated.
- `GET /api/v1/projects/:id/audits` and `GET /api/v1/projects/:id/audits/:runId`:
  `readAuth` + `resolveAccess`, with the run lookup scoped by both ids.
- Guards updated deliberately: `EXPECTED_READ_ROUTE_COUNT` 11→13, gate mounts
  7→8, and `/apps/auditor` added to `dependabot.yml`. The Dependabot guard
  caught the missing entry, as designed.
- `apps/auditor`: CLI, config, runner, and the pure scoring modules.
- CI: auditor typecheck, tests (with a Chromium install, because the browser
  suite self-skips without one), and build.

## Tests

- `apps/api/src/services/audits.test.ts` (node, no DB): schema bounds,
  every regression rule at and just under its boundary, ordering and
  determinism.
- `apps/api/src/routes/audits.test.ts` (DB): ingest of the **real** auditor
  fixture, page errors, per-branch baselines, list/detail, cross-project 404,
  and cascade on project delete.
- `apps/auditor/src/*.test.ts`: perf math (erf, log-normal, CLS windows, TBT),
  SEO rules, the axe summary, config, upload and formatting. There is also a
  real-Chromium suite against `fixtures/site` (a clean page, a page with
  deliberate defects, a header-only noindex page, a 404, and an unreachable
  host).
- An independent review agent read the diff before commit and found six
  defects, all fixed with a test that pins each one:
  - `buildUploadUrl` dropped an API path prefix, so the Bearer token was
    sent to the host root.
  - `max-image-preview:none` was read as `noindex`.
  - An unsupported layout-shift/longtask observer reported CLS/TBT as `0`
    instead of missing.
  - A long task straddling FCP was dropped instead of clipped.
  - The "can't disagree" overclaim above.
  - A duplicate `(url, device)` pair, or an errored page that still had
    checks, was accepted.
- Bite-checked by hand: seven single-line mutations to boundaries and weights
  (the title bound, the CLS gap, the TBT budget, the pass weight, the
  score-drop `>=`, the `info` exclusion, and the metric `&&`→`||`). Each one
  failed at least one test.

## Follow-ups (not in this slice)

1. **Dashboard "Quality" view.** Score-over-time chart per category (ECharts,
   and remember to register the series type), run detail with regressions
   first, and a per-URL drill-down. The read routes are already shaped for it.
2. **Retention.** `POST /admin/projects/:id/prune` only prunes `test_runs`.
   Audit runs grow until the project is deleted. Extend prune to
   `audit_runs` using the same `retentionDays`.
3. **Notifications.** Emit a neutral `audit_regression` event through
   `services/notifications/events.ts` and add a Slack formatter. Don't add a
   bespoke sender.
4. **Mutation floor.** Add `services/audits.ts` and the auditor's pure
   modules to `scripts/mutation-gate.mjs` once a CI baseline exists.
5. **Crawl-based URL lists** (sitemap / inventory import) instead of a
   hand-kept `urls` array.
6. **Natural-language smoke tests** (design decision 3).

## Sharp edges found while building

- **In-page code must be strings.** Passing a TS function to
  `page.evaluate` / `addInitScript` under tsx fails with
  `ReferenceError: __name is not defined` (esbuild `keepNames`). The first
  run lost every SEO check and every LCP/CLS/TBT value this way. The runner
  degraded gracefully (null scores and an `info` issue) and did not crash,
  which is how the failure surfaced. All in-page code now lives in
  `apps/auditor/src/in-page.ts` as plain JS.
- **One unexplained red run.** One of eleven full `pnpm --filter api test`
  runs on this branch reported a failure whose output was not captured. The
  ten runs after it were all green (983/983). It is not attributed to this
  change, and it is not claimed to be unrelated either. Watch the first CI runs.
