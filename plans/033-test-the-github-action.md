# Plan 033: Put a test harness around the shipped GitHub Action

> **Executor instructions**: Follow the plan, run every verification, honor the STOP
> conditions. Do not update `plans/README.md` — the reviewer maintains it.
>
> **Drift check (run first)**: `git rev-parse --short HEAD` at or after `12bda5b`. Confirm
> `.github/action-scripts/partition.jq` and `.github/action-scripts/comment.sh` both exist
> and that `comment.sh` uploads to `.../reports?...&wait=true` (line ~62). If either file is
> absent or `comment.sh` no longer shells out to `partition.jq`, STOP and report.

## Status

- **Priority**: P1 — this is the code we ship into *other people's* CI, and it has **zero
  automated tests**. Plan 032 modified `comment.sh` last wave with no regression net.
- **Effort**: M
- **Risk**: LOW — adds tests only. Touches **no** product code and **no** action script.
- **Depends on**: none. **Parallel-safe**: sole owner of the new test file(s) and (if you add
  them) fixtures under `apps/api`. Touches nothing any other plan owns.
- **Category**: test coverage
- **Planned at**: commit `12bda5b`, 2026-07-15

## Why this matters

The GitHub Action (`action.yml` + `.github/action-scripts/`) is Flackyness's primary
integration surface for anyone who isn't on GitLab. It is **395 lines of shipped-to-strangers
logic** — a 137-line `partition.jq` and a 196-line `comment.sh` — and **nothing tests any of
it**. A silent regression here doesn't break *our* CI; it corrupts *other people's* PR
comments, quietly, in a tool whose entire job is to be trustworthy about test health.

Two specific reasons the risk is live right now:

1. **`comment.sh` was modified last wave (plan 032)** — the upload URL gained `&wait=true` —
   with no test to catch a regression. Every future edit to this file is equally unguarded.
2. **`partition.jq` encodes subtle, already-bitten logic.** Its own comments flag a bug that
   was found and fixed during review (the `null + x == x` identity silently dropping the
   suite-title prefix — see lines 61–66 of the file). A bug that was invisible once will be
   invisible again on the next edit unless a test pins the behavior.

Both layers are **hermetic and fast to test** — no database, no network:
- `partition.jq` is a **pure function**: `(report JSON, --argjson quarantine) → result JSON`.
  Pipe fixtures through real `jq`, assert on the output.
- `comment.sh`'s contract is testable with **mock `curl`/`gh` on `PATH`** — no real HTTP.

## Current state — what the two scripts guarantee (read these before writing tests)

### `partition.jq` (the pure core) — behaviors a test must pin

From `.github/action-scripts/partition.jq` (read the whole file; the load-bearing defs):

- **`extract_specs` / `test_name`** (lines 24–57): walks `suites[]` recursively, building a
  ` › `-joined title path. A suite title that *is* a file path (ends `.ts`/`.js`, or contains
  `/`) is **skipped** in the path (`is_file_suite`, lines 24–26); a non-file suite title is
  **included**. So a spec `"logs in"` under describe `"auth"` under file-suite `"auth.spec.ts"`
  renders as `"auth › logs in"`, *not* `"auth.spec.ts › auth › logs in"`.
- **The `$e` capture** (lines 59–69): `map(. as $e | {name: ($e.spec | test_name($e.titlePath)), ...})`
  — capturing the wrapping `{spec, titlePath}` as `$e` is what keeps the suite-title prefix
  from being silently dropped. **This is the regression test that matters most** (see Step 1).
- **`spec_results` dual shape** (lines 41–45): counts attempts under `spec.tests[].results[]`
  (real reporter) **or** `spec.results[]` (legacy), never both-distinguished.
- **`spec_failed`** (lines 50–54): a spec is a "failure" for this comment iff it has ≥1 attempt,
  **no** attempt `passed`, and ≥1 attempt is `failed`/`timedOut`/`interrupted`. So: all-passed
  → not a failure; passed-then-failed (recovered) → **not** a failure; all-skipped → not a
  failure; all-failed → failure.
- **3-way partition** (lines 89–98): each failure name is **muted** if in `quarantine.muted`,
  else **auto-flaky** if in `quarantine.flaky`, else **unknown**. Muted takes precedence over
  flaky.
- **`html_escape`** (lines 81–82): `&` → `&amp;` **first**, then `<`/`>`. Names are wrapped in
  `<code>…</code>`. A test asserting `<`/`>`/`&` in a name renders escaped — and that `&` is
  **not double-escaped** (no `&amp;lt;` in the output) — pins the "ampersand first" ordering.
- **`body` shape** (lines 99–137): first line is always the marker `<!-- flackyness-report -->`;
  the "Need a look" `<details>` block is `<details open>` **iff** `unknownCount > 0`; the count
  line pluralizes (`1 test failed` vs `2 tests failed`, `needs`/`need`); `total == 0` renders
  "**No failing tests in this run.**".

### `comment.sh` (the orchestration) — the ONE contract that matters

From `.github/action-scripts/comment.sh` (read the header comment, lines 7–18, verbatim):

> this action **reports, it never fails the build**. The ONLY exception is a missing required
> input (api-url / token / project-id) … Every other failure mode (upload fails, quarantine
> lookup fails, report missing, report unparsable, PR comment API fails) prints a `::warning::`
> and exits 0.

That is the invariant to pin: **exit 1 iff a required input is missing; exit 0 in every other
failure mode.** A flaky-test reporter that breaks pipelines when its own backend is down is a
tool that gets ripped out — so this contract is the whole ballgame.

## Scope

**In scope** — create these (exact paths at the executor's discretion within `apps/api`, but
keep them discoverable; suggested names below):
- `apps/api/src/action-partition.test.ts` — the `partition.jq` matrix (Step 1).
- `apps/api/src/action-comment-sh.test.ts` — the `comment.sh` contract via mock `PATH` (Step 2).
- Small inline fixtures (prefer literals in the test file over separate fixture files — these
  reports are tiny; a self-contained test is easier to read than one that jumps to a fixture).

**Out of scope** (do NOT touch):
- `.github/action-scripts/partition.jq`, `.github/action-scripts/comment.sh`, `action.yml` —
  you are **testing** them, not changing them. If a test reveals a genuine bug, that is a
  **finding**: STOP and report it (see STOP conditions). Do not "fix" the script to make a
  test pass — that buries the bug in a test PR.
- Any product code under `apps/api/src/routes`, `parsers`, `services`, the dashboard, docs,
  CI workflows.
- `partition.jq`'s deliberate **omission** of per-project `[chromium]`/`[firefox]` name
  suffixing (documented at lines 18–22 of the file, and in `docs/GITHUB_ACTION.md`). This is a
  known, intentional limitation — do **not** write a test that expects the suffix, and do not
  report its absence as a bug.

## Step 1 — characterize `partition.jq` (the pure core)

Write a vitest suite that shells out to **real `jq`** and asserts on parsed output. There is no
`vitest.config.ts` in `apps/api`, so any `*.test.ts` under `apps/api` is picked up by the
existing `vitest run` (the `Tests` CI job). This suite imports **nothing** from the app and
needs **no `DATABASE_URL`** — so, unlike the route suites, it does **not** self-skip; it always
runs in CI. That is the point.

**Invocation pattern** (mirror how `comment.sh` calls it — `-f` script, `--argjson quarantine`,
report on stdin):

```ts
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Node 24 → import.meta.dirname is available. From apps/api/src/ up to repo root:
const JQ_SCRIPT = path.resolve(import.meta.dirname, '../../../.github/action-scripts/partition.jq');

function partition(report: unknown, quarantine: unknown) {
  const out = execFileSync(
    'jq',
    ['-c', '--argjson', 'quarantine', JSON.stringify(quarantine), '-f', JQ_SCRIPT],
    { input: JSON.stringify(report), encoding: 'utf8' }
  );
  return JSON.parse(out);
}
```

**Guard the jq dependency, loudly.** At suite start, verify `jq` is on `PATH` (e.g. a
`beforeAll` that runs `jq --version` and throws a clear message if it fails). Do **not**
`describe.skip` when jq is missing — a silently-skipped suite is exactly the "looks green,
tests nothing" failure this plan exists to prevent. `jq` is preinstalled on `ubuntu-latest`
(the `Tests` runner) and is a hard runtime dependency of the action, so a missing `jq` is a
real environment error worth failing on.

**Cases to cover** (assert on `total`, `mutedCount`, `autoFlakyCount`, `unknownCount`, and
targeted `body` substrings):

1. **All-passing / empty report** → `total: 0`; body contains `No failing tests`; body's first
   line is exactly `<!-- flackyness-report -->`.
2. **One muted failure** (name in `quarantine.muted`) → `mutedCount: 1`, others 0; the name
   appears under the "Muted" `<details>`.
3. **One auto-flaky failure** (name in `quarantine.flaky`, not muted) → `autoFlakyCount: 1`.
4. **One unknown failure** (in neither list) → `unknownCount: 1`; the "Need a look" block is
   `<details open>` (assert `open` present); count line says `1 test failed` and `needs a look`.
5. **Muted-beats-flaky precedence**: a name present in **both** `muted` and `flaky` → counts as
   muted (`mutedCount: 1`, `autoFlakyCount: 0`).
6. **Suite-title prefix (the `$e`-capture regression test)**: a spec nested under a non-file
   describe title → the failure name is `"<describe> › <spec>"`. Then, to prove the test
   *bites*: temporarily break the jq (see "Prove it bites" below) and confirm this case fails.
7. **File-suite title skipped**: a spec whose only ancestor suite title is a file path
   (`"foo.spec.ts"` or contains `/`) → name is just the spec title, **no** file prefix.
8. **HTML escaping + no double-escape**: a failing test named `renders <b> & "q" </details>` (in
   the unknown list) → body contains `&lt;b&gt; &amp; ... &lt;/details&gt;` inside `<code>…</code>`
   and does **NOT** contain `&amp;lt;` (proves `&`-first ordering).
9. **`spec_failed` semantics** (one case each, or a small table):
   - passed-then-failed (recovered) attempts → **not** counted as a failure (`total: 0`).
   - all-skipped spec → **not** a failure.
   - `spec.tests[].results[]` (real shape) with all-failed → counted (proves dual-shape path).
   - `spec.results[]` (legacy shape) with all-failed → counted.
10. **Pluralization**: 2 unknown failures → `2 tests failed`; and with exactly 1 unknown →
    `needs a look`, with 2 → `need a look`.

**Prove it bites (case 6)**: make a throwaway copy of `partition.jq`, delete the `. as $e |`
capture on line ~67 (so `test_name(.titlePath)` evaluates against `.spec`, which has no
`titlePath`), point the test at the copy, and confirm case 6 fails while the others still pass.
Restore. Paste the observed failure. (Do **not** edit the real `partition.jq` in place — use a
temp copy so a crash can't leave the shipped script mutated.)

**Verify**: `rtk proxy pnpm --filter api exec vitest run <your partition test file>` → all green;
paste the assertion count (prove it's not 0 tests / not skipped).

## Step 2 — pin `comment.sh`'s "never fail the build" contract

Run the real `comment.sh` under `bash`, with **mock `curl` and `gh` on a temp `PATH`** (real
`jq` stays available — `comment.sh` needs it for `enc()` and the partition call). Assert on the
**exit code** and stderr `::warning::`/`::error::` markers.

**Harness recipe** (spell this out for yourself; a weak reader must be able to follow it):
- Create a temp dir `MOCKBIN`. Write an executable `MOCKBIN/curl` (a bash script) that inspects
  its arguments for the URL: if it contains `/api/v1/reports` it emulates the upload, if
  `/quarantine` the quarantine fetch. Drive each response's HTTP status from env vars
  (e.g. `MOCK_REPORTS_STATUS`, `MOCK_QUARANTINE_STATUS`, `MOCK_QUARANTINE_BODY`). Reproduce the
  real `curl` contract `comment.sh` relies on: it writes the body to the `-o <file>` path and
  prints the status to stdout (because of `-w '%{http_code}'`), and exits 0 on a completed
  request. Match that exactly or the script under test won't behave.
- Write an executable `MOCKBIN/gh` that records its invocation (append argv to a log file) and
  exits per an env var, so you can assert whether a PR comment was attempted and what body it
  received (`-F body=@<file>` → read the file).
- Invoke via `execFileSync('bash', [COMMENT_SH], { env: { ...process.env, PATH: `${MOCKBIN}:${process.env.PATH}`, FLACKYNESS_API_URL: ..., FLACKYNESS_TOKEN: ..., FLACKYNESS_PROJECT_ID: ..., FLACKYNESS_REPORT_PATH: <temp report>, ... }, encoding: 'utf8' })`. Capture exit code via a try/catch (execFileSync throws on non-zero; read `err.status`).

**Cases (the contract)**:
1. **Missing `api-url`** (unset `FLACKYNESS_API_URL`) → **exit 1**, stderr has `::error::` and
   names `api-url`. Same for missing `token` and missing `project-id` (three cases, or a table).
   This is the *only* non-zero exit — assert it explicitly.
2. **All inputs present, report file absent** → **exit 0**, `::warning::` "report file not found".
3. **Upload fails** (`MOCK_REPORTS_STATUS=500`) → **exit 0**, `::warning::` "report upload failed".
   *This is the core contract: a Flackyness outage must not fail the build.*
4. **Quarantine fails** (`MOCK_REPORTS_STATUS=201`, `MOCK_QUARANTINE_STATUS=500`) → **exit 0**,
   `::warning::` "quarantine lookup failed".
5. **`comment=false`** (`FLACKYNESS_COMMENT=false`, both curls 2xx) → **exit 0**, "upload-only
   mode", and the mock `gh` was **never** invoked (assert the gh log is empty).
6. **JUnit XML report** (report body starts with `<`, both curls 2xx) → **exit 0**,
   `::warning::` "looks like JUnit XML", mock `gh` never invoked.
7. **Happy path** (upload 201, quarantine 200 with one muted failure that matches a failing spec
   in the report, `FLACKYNESS_PR_NUMBER=123`, `GH_TOKEN=x`, mock `gh` list returns `empty`) →
   **exit 0**, "created PR comment", and the mock `gh` POST received a body whose first line is
   the marker. (This is the richest case — if the `gh`-list/`gh`-POST mock proves too fiddly to
   make deterministic, keep cases 1–6 and report case 7 as dropped rather than shipping a flaky
   or fake version of it. See STOP conditions.)

**Prove the contract test bites**: for case 3, temporarily change the mock `curl` to return
`201` for the upload (so the "upload failed" branch isn't taken) and confirm the case's exit-0
assertion no longer distinguishes anything — i.e. show that the assertion is actually keyed on
the degradation path, not passing vacuously. Simpler alternative that proves the same thing:
temporarily inject `exit 1` after the upload-failure `warn` in a **copy** of `comment.sh` and
confirm case 3 flips to a failure. Restore. Report what you did.

**Verify**: `rtk proxy pnpm --filter api exec vitest run <your comment-sh test file>` → green,
assertion count pasted.

## Done criteria

- [ ] `partition.jq` suite covers cases 1–10 above; all green; assertion count pasted (not 0, not skipped)
- [ ] The suite-title-prefix case (Step 1 case 6) is demonstrated to **fail** when the `$e` capture is removed from a temp copy (failure output pasted)
- [ ] `comment.sh` suite covers cases 1–6 (case 7 covered, or explicitly reported as dropped with the reason); all green; assertion count pasted
- [ ] The "only missing-config exits non-zero" invariant is asserted directly (exit 1 for missing input; exit 0 for upload-fail and quarantine-fail)
- [ ] Both suites run in the existing `pnpm --filter api test` with **no `DATABASE_URL`** set (prove it: run them with `DATABASE_URL` unset and show they still execute, not skip)
- [ ] `jq` presence is asserted (loud failure), never silently skipped
- [ ] `.github/action-scripts/partition.jq`, `.github/action-scripts/comment.sh`, and `action.yml` are **unchanged**: `git diff --name-only main` shows only new test file(s) under `apps/api/`
- [ ] `pnpm --filter api exec tsc --noEmit` → 0 errors; `rtk proxy pnpm lint` → exit 0
- [ ] No product code, workflow, or doc modified

## Test/verification setup

- **No Postgres, no network.** These suites are hermetic. Do not spin up a database.
- **Confirm they run in CI's job, not just locally.** The `Tests` job is `ubuntu-latest`, which
  has `jq` preinstalled. Do a local run with `DATABASE_URL` unset to mirror the "no DB" property
  and confirm the suites still execute (the route suites will skip; yours must not).
- **`rtk proxy` prefix** for `pnpm`/`git`/`grep` (the shell hook garbles their output otherwise).
- If you shell out to `bash` for Step 2, the tests assume a POSIX `bash` — fine on the CI runner
  and on the macOS dev box. Note it in a comment.

## STOP conditions

- **A test reveals a genuine bug in `partition.jq` or `comment.sh`.** STOP and report it as a
  finding with the failing input and the wrong output. Do **not** edit the script to make the
  test pass — that is a separate fix plan, and burying a product bug in a test PR is how it gets
  lost. (This plan asserts *current* behavior; if current behavior is wrong, that's news.)
- **The `comment.sh` mock harness can't be made deterministic** for case 7 (the full `gh`
  round-trip). Ship cases 1–6 solid and report case 7 as dropped with the reason — a flaky test
  in the flaky-test tracker's own suite is precisely the thing plans 027/029 fought.
- **You find yourself wanting a `describe.skip`/`it.skip`** to get to green. Don't. A skipped
  test that reads as coverage is the failure mode this whole plan is a reaction to. Report the
  blocker instead.

## Maintenance notes

- This is the regression net for the Action. The next person who edits `comment.sh` or
  `partition.jq` (e.g. to add the `[chromium]` project-suffixing that's currently a documented
  limitation, or a new quarantine category) now has a suite that will tell them what they broke.
- If the Action later grows more scripts (`partition.jq` has a sibling only, today), extend the
  same harness rather than reinventing per-file test scaffolding.
- **Follow-up worth raising, not doing here**: there is no test that `action.yml`'s
  input→env wiring is correct (e.g. that `FLACKYNESS_COMMIT` maps to the head-SHA fallback).
  That's a YAML-contract test, a different shape from these behavioral tests; note it if you
  think it's worth a future plan.
