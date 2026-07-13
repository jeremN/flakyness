# GitHub Action: Flackyness Report

`jeremN/flackyness@v1` (once tagged — see [Tagging a release](#tagging-a-release))
is a composite action that:

1. Uploads a Playwright JSON or JUnit XML report to your self-hosted Flackyness
   instance (same call `.gitlab-ci.yml.example` makes, just from GitHub Actions).
2. Fetches the project's [quarantine list](API.md#get-apiv1projectsidquarantine)
   (`GET /api/v1/projects/:id/quarantine`).
3. Extracts this run's failing specs from the report, partitions them against
   the quarantine list, and comments on the pull request with the result —
   updating its own previous comment rather than adding a new one on every push.

It never fails your build and it never skips or retries a test. See
[Guarantees](#guarantees) for why that is non-negotiable.

## Quick start

```yaml
# .github/workflows/e2e.yml
name: E2E
on: pull_request

permissions:
  pull-requests: write   # required — see "Permissions" below

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - name: Run Playwright tests
        run: npx playwright test --reporter=json --output-file=playwright-report/report.json
        continue-on-error: true   # let the Flackyness step run even on failure
      - name: Report to Flackyness
        uses: jeremN/flackyness@v1
        with:
          api-url: https://flackyness.example.com
          token: ${{ secrets.FLACKYNESS_TOKEN }}
          project-id: ${{ vars.FLACKYNESS_PROJECT_ID }}
```

A complete, copy-pasteable workflow (including a step that fails the job if
the *test* step failed, since `continue-on-error` above suppresses that) lives
at [`.github/workflows/example-consumer.yml.example`](../.github/workflows/example-consumer.yml.example)
in this repo.

## Inputs

| Input | Required | Default | Notes |
|---|---|---|---|
| `api-url` | yes | — | Base URL of your Flackyness instance, e.g. `https://flackyness.example.com`. No trailing slash needed. |
| `token` | yes | — | The project's token (see [Create Project](API.md#create-project) / [Rotate Token](API.md#rotate-token)). **Store it as a repository or environment secret** — never hardcode it in the workflow file. |
| `project-id` | yes | — | The project's UUID, used only for the quarantine lookup (that endpoint is unauthenticated by design — see [`docs/API.md`](API.md#get-apiv1projectsidquarantine)). |
| `report-path` | no | `playwright-report/report.json` | Path to the Playwright JSON or JUnit XML report. Both formats upload fine; only Playwright JSON supports the PR comment (see [Guarantees](#guarantees)). |
| `github-token` | no | `${{ github.token }}` | Used to read/list and write the PR comment. Needs `pull-requests: write` — see [Permissions](#permissions). Override only if the default `GITHUB_TOKEN` can't comment on PRs in your setup (e.g. a fork-triggered `pull_request` event with the default read-only token). |
| `comment` | no | `true` | Set to `"false"` to upload only, without touching the PR at all. |

## Permissions

The **#1 thing people get wrong**: the job (or workflow) needs

```yaml
permissions:
  pull-requests: write
```

Without it, `github.token` is read-only and the action's PR-comment step fails
(quietly — see [Guarantees](#guarantees) — you'll see a `::warning::` in the
job log, not a red X). If you can't grant this at the job level (e.g. a
`pull_request` workflow triggered from a fork, where the default token is
always read-only regardless of `permissions:`), either run this action from a
`pull_request_target`-triggered workflow with the necessary caution around
untrusted checkouts, or pass a `github-token` with a PAT that has PR-write
access.

## Guarantees

- **Never fails the build.** If Flackyness is unreachable, the token is
  wrong, the report file is missing, or the report can't be parsed as
  Playwright JSON: the action prints a `::warning::` and exits `0`. The one
  exception is a missing *required input* (`api-url` / `token` /
  `project-id`) — that's a config bug in your workflow, not a Flackyness
  outage, and fails fast with `::error::` so it doesn't go unnoticed.
- **Never skips or retries a test, and never touches the test step's exit
  code.** The action does not consume `grepInvert`. Deciding to skip a test
  is a human call — that's the entire reason the quarantine endpoint splits
  `muted` (operator-approved) from `flaky` (auto-detected, advisory only). An
  action that could silently turn a red build green would be the single
  worst thing this project could ship. If you want tests to auto-retry
  against the muted list, that's the `?format=playwright` variant of the
  quarantine endpoint documented in `docs/API.md`, wired up yourself, with
  your own opt-in — this action does not do it for you.
- **Updates one comment, never spams.** The action looks for an existing PR
  comment starting with a hidden `<!-- flackyness-report -->` marker and
  edits it in place; only if none exists does it create a new one. A new
  comment per push would turn a busy PR into a wall of noise.
- **The token is never logged.** It's read from an `env:` var into a
  `curl -H "Authorization: Bearer ${TOKEN}"` call; it is never interpolated
  into a `run:` string directly and the script never uses `set -x`.

## Known limitations

- **JUnit XML uploads don't get a PR comment.** The upload still happens (the
  API accepts both formats), but partitioning failures requires parsing the
  report, and parsing XML reliably in shell isn't worth the risk of a wrong
  "known-flaky" label. You'll see a `::warning::` explaining why the comment
  was skipped.
- **Test names are matched *exactly*** between the report and the quarantine
  list, same as the `grepInvert` caveat in `docs/API.md` — a renamed test
  silently drops out of both lists until it re-accumulates history under its
  new name.
- **Playwright "project" (browser) suffixes are not reproduced.** When a
  report mixes multiple Playwright projects for the same spec (e.g. the same
  test run under both `chromium` and `firefox`), the API's ingest parser
  (`apps/api/src/parsers/playwright.ts`) disambiguates the stored test name
  with a `[projectName]` suffix — but only when the *whole report* mixes
  projects. This action's shell-based extraction does not replicate that
  per-project disambiguation; it matches at the spec level (suite path +
  spec title). In the common single-project case this is a non-issue. If
  your suite mixes projects for the same spec, the name Flackyness stored in
  its quarantine list (with a `[projectName]` suffix) may not match the name
  this action extracts from a later report — the comment will then bucket
  that failure as "unknown" instead of muted/flaky. Track this from
  `apps/api/src/parsers/playwright.ts` if it's ever revisited.

## Tagging a release

`uses: jeremN/flackyness@v1` requires a `v1` tag (or branch) to exist on this
repository; until then, consumers should pin `uses: jeremN/flackyness@<commit-sha>`
instead. Publishing to the GitHub Marketplace additionally requires an
`action.yml` `branding:` block, deliberately not added yet — that's a
separate follow-up, not a prerequisite for using the action directly via a
commit SHA or branch reference.
