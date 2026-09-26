# Flackyness auditor

Audits a list of URLs for **accessibility**, **SEO** and **performance** in a
real Chromium, and uploads the result to a Flackyness API
(`POST /api/v1/audits`). The API stores each run and reports **regressions**
against the previous run on the same branch. You can fail a CI job on them.

No LLM is involved. Every check is deterministic: axe-core for a11y, DOM rules
for SEO, and Web Vitals measured in the page for perf. The design is in
[plan 060](../../plans/060-quality-audits.md), and the API contract is in
[docs/API.md](../../docs/API.md#audits).

## Usage

```bash
pnpm --filter auditor build
FLACKYNESS_API=https://flackyness.example.com \
FLACKYNESS_TOKEN=<project ingest token> \
node apps/auditor/dist/cli.js --config audit.config.json --branch main --fail-on-regression
```

| Flag | |
|------|--|
| `--config <path>` | Audit config (required) |
| `--api-url`, `--token` | Or `FLACKYNESS_API` / `FLACKYNESS_TOKEN`, the same variables the report upload uses |
| `--branch`, `--commit`, `--pipeline` | Attribution. `--commit` is optional, since a scheduled prod audit has none |
| `--output <file>` | Also write the raw report JSON |
| `--dry-run` | Audit and print the table without uploading |
| `--fail-on-regression` | Exit `3` when the API reports regressions |
| `--chromium <path>` | Or `AUDIT_CHROMIUM_PATH`. Defaults to Playwright's own Chromium |

Exit codes: `0` ok, `1` usage/config error, `2` audit or upload failed, `3` regressions.

## Config

```json
{
  "urls": [
    "https://www.example.com/",
    "https://www.example.com/itineraire",
    "https://www.example.com/restaurants/paris"
  ],
  "devices": ["mobile", "desktop"],
  "beforeAudit": { "clickIfVisible": ["#didomi-notice-agree-button"] },
  "axe": { "exclude": ["#third-party-chat"] },
  "seo": { "canonicalOrigin": "https://www.example.com" }
}
```

| Key | Default | |
|-----|---------|--|
| `urls` | required | Deduplicated. `urls × devices` must be ≤ 500, the API's per-report cap |
| `devices` | `["mobile"]` | `mobile` is a Pixel 7 viewport with 4× CPU slowdown. `desktop` is 1350×940 with no throttling |
| `categories` | all three | Any of `a11y`, `seo`, `perf` |
| `timeoutMs` | `30000` | Navigation timeout per page |
| `settleMs` | `3000` | Wait after `load` before reading perf, because LCP and long tasks keep arriving |
| `beforeAudit.clickIfVisible` | `[]` | Consent banners and similar. Clicked **after** perf is measured (the banner is a real user cost) and **before** a11y/SEO (so it doesn't dominate every page's findings) |
| `axe.tags` | WCAG 2.1 A + AA | axe-core rule tags |
| `axe.exclude` | `[]` | Selectors to leave out of the a11y scan |
| `seo.canonicalOrigin` | unset | When set, every canonical must be on this origin. This catches staging canonicals leaking into prod |

## What is measured

- **a11y**: axe-core. The score is a weighted pass ratio over the rules that
  *applied*: critical 10, serious 7, moderate 3, minor 1, and each pass counts
  as moderate. Each rule counts once. The number of offending elements is the
  issue's `count`.
- **SEO**: HTTP status, noindex (meta *and* `X-Robots-Tag`), canonical
  (missing / conflicting / wrong origin, plus "points elsewhere" as `info`),
  title and description length, `<h1>`, `<html lang>`, viewport, hreflang
  (codes, absolute URLs, self-reference), and JSON-LD validity. Failures are
  weighted by severity.
- **perf**: LCP, FCP, CLS (session windows), TBT and TTFB, measured in the page.
  The score uses Lighthouse's log-normal curves and weights, minus Speed Index.
  **It is not a Lighthouse score.** There is no network throttling, and TBT is
  bounded by the settle window instead of TTI. A long task that straddles FCP
  is clipped, as in Lighthouse. A metric the browser cannot observe is
  reported as missing (so the score is `null`), never as `0`. The score is meant for tracking
  one page over time under stable conditions, which is what regression
  detection needs. Pages are audited **sequentially**, one fresh browser
  context each, so the numbers don't depend on audit order.

A page that fails to load is recorded as a page error, and the run continues.
A single check that crashes is reported with a `null` score and an `info`
issue. It is never counted as `0`.

## Scheduled audit in GitLab CI

```yaml
quality-audit:
  image: mcr.microsoft.com/playwright:v1.62.1-noble
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
  script:
    - corepack enable && pnpm install --frozen-lockfile
    - pnpm --filter auditor build
    - node apps/auditor/dist/cli.js --config audit.config.json
        --branch production --pipeline "$CI_PIPELINE_ID" --fail-on-regression
```

Using `--branch production` for scheduled runs keeps their baseline separate
from any audits run on feature branches.

## Development

```bash
pnpm --filter auditor test          # unit tests + a real-Chromium suite against fixtures/site
AUDIT_CHROMIUM_PATH=/path/to/chrome pnpm --filter auditor test
pnpm --filter auditor fixture:api   # regenerate apps/api/fixtures/audit-report.json
```

The browser suite self-skips when no Chromium is found (CI installs one).
Code that runs **inside** the page lives in `src/in-page.ts` as plain-JS
strings. See the comment there for why this can't be TypeScript functions.
