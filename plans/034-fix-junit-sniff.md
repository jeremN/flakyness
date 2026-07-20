# Plan 034: Fix comment.sh's dead JUnit-XML detection (and flip its test from pinning the bug to pinning the fix)

> **Executor instructions**: Follow the plan, run every verification, honor the STOP
> conditions. Do not update `plans/README.md` — the reviewer maintains it.
>
> **Drift check (run first)**: `git rev-parse --short HEAD` at or after `d1b30ae`. Confirm
> `.github/action-scripts/comment.sh` line ~105 still reads
> `first_nonspace_char="$(grep -m1 -o '[^[:space:]]' "$REPORT_PATH" 2>/dev/null || true)"`
> and that `apps/api/src/action-comment-sh.test.ts` still contains a test titled with `BUG:`
> asserting the fallthrough (it currently pins the buggy behavior). If either has changed
> shape, STOP and report — someone may have already touched this.

## Status

- **Priority**: P3 (low severity — the build-safety contract is already intact; this is a
  message-quality / dead-code fix)
- **Effort**: S
- **Risk**: LOW-MED — it edits a **shipped** action script, but the change is a one-liner and
  the `action-comment-sh.test.ts` suite (landed in plan 033) is the regression net.
- **Depends on**: 033 (DONE, PR #76) — this fixes the bug 033's review found and updates the
  test 033 wrote. **Do not start against a tree without 033's tests present.**
- **Category**: correctness (bug fix)
- **Planned at**: commit `d1b30ae`, 2026-07-15

## The bug (found during plan 033's review)

`.github/action-scripts/comment.sh` tries to detect a report that is JUnit XML rather than the
Playwright JSON this comment step expects, so it can print a friendly "skipping the PR comment"
warning instead of a raw parser error:

```bash
# --- 4. Extract this run's failures, partition, render ----------------------
first_nonspace_char="$(grep -m1 -o '[^[:space:]]' "$REPORT_PATH" 2>/dev/null || true)"
if [ "$first_nonspace_char" = "<" ]; then
  warn "'$REPORT_PATH' looks like JUnit XML, not Playwright JSON — skipping the PR comment (upload already completed)."
  exit 0
fi
```

`grep -m1` limits to the first **matching line**, and `-o` prints **every** match found on that
line (each on its own output line). For any realistic report whose first line has more than one
non-whitespace character — e.g. `<?xml version="1.0" encoding="UTF-8"?>` — `first_nonspace_char`
ends up holding **all ~36 characters** of that line, so `[ "$first_nonspace_char" = "<" ]` is
never true. The friendly branch is **dead code** for real input; execution falls through to the
generic `jq` parse-failure branch a few lines down.

**Confirmed identical on BSD grep and GNU grep 3.12** (the `ubuntu-latest` CI runner), so this
is not a platform quirk. Severity is low: the fallthrough *also* warns-and-exits-0, so the
"never fail the build" contract holds — the only user-visible effect is a raw `jq` parse error
in the Action log instead of the intended friendlier line. But it is dead code that lies about
what it does, and the friendlier message is exactly what a user who accidentally points this
step at a JUnit report should see.

## The fix

Take only the **first** character of grep's output. The minimal change that matches the
existing idiom is to pipe grep through `head -n1`:

```bash
first_nonspace_char="$(grep -m1 -o '[^[:space:]]' "$REPORT_PATH" 2>/dev/null | head -n1 || true)"
```

Why this is correct:
- `grep -m1 -o '[^[:space:]]'` emits the non-space characters of the first line that has any,
  one per output line; `head -n1` keeps the first of those — i.e. the first non-whitespace
  character of the file. That is exactly what the variable name already claims.
- Whitespace-leading reports work too: if the first line(s) are all whitespace, grep's first
  *matching* line is the first line with content, and `head -n1` takes that line's first char.
- Empty / all-whitespace file: grep matches nothing, output is empty, the var is empty,
  `[ "" = "<" ]` is false → falls through to `jq` (which fails → warn → exit 0), unchanged.
- `head` closing the pipe early can SIGPIPE `grep`; `set -o pipefail` is **not** set in this
  script, so the pipeline's exit status is `head`'s (0), and the trailing `|| true` still guards
  the no-match case. Do **not** add `pipefail` — it would change unrelated behavior in this
  script.

You may instead choose an equivalent one-liner if you can justify it's clearer and equally
correct (e.g. an `awk`/`sed` first-non-space-byte read) — but **keep it a single, obvious
line**, keep the `2>/dev/null` and the `|| true`, and do not restructure the surrounding block.
Match this file's existing bash style (it is deliberately not `set -e`; see its header comment).

## Update the test (it currently pins the BUG)

`apps/api/src/action-comment-sh.test.ts` (from plan 033) has, under `describe('case 6: ...')`,
**two** tests:

1. `detects it and skips the PR comment when the file's first line is a single "<"` — the narrow
   shape the old code accidentally handled. **This must still pass after the fix** (a lone `<`
   first line is still detected). Leave it, though you may reword the title now that it is no
   longer "the narrow case the code happens to handle".
2. `BUG: never fires for a realistic multi-character first line — falls through to a generic jq
   parse-failure warning instead` — this **pins the buggy behavior** and will now be **wrong**.
   **Replace it** with a test asserting the corrected behavior: a realistic multi-line JUnit
   report (the same `<?xml …?>\n<testsuites …>…` fixture already in that test) now **fires the
   friendly detection** — `stdout` contains `looks like JUnit XML`, exit 0, and the mock `gh`
   is never invoked. Remove the long `// GENUINE BUG …` comment block (or rewrite it to record
   that plan 034 fixed it).

Also **add** one case the old code never handled and the fix now does:
3. **Leading-whitespace XML** — a report whose content is `"\n\n  <?xml version=\"1.0\"?>\n<testsuites/>\n"`
   → detection still fires (`looks like JUnit XML`, exit 0, gh not invoked). This guards the
   "first *matching* line, first char" reasoning above.

Keep the mock-`curl`/`gh` harness and `runCommentSh` helper exactly as they are — you are only
changing the case-6 assertions.

## Scope

**In scope**:
- `.github/action-scripts/comment.sh` — the one-line detection fix (nothing else in the file).
- `apps/api/src/action-comment-sh.test.ts` — replace the `BUG:` test, add the leading-whitespace
  case, optionally reword the lone-`<` title.

**Out of scope** (do NOT touch):
- `.github/action-scripts/partition.jq`, `action.yml`, `apps/api/src/action-partition.test.ts`.
- The rest of `comment.sh` — the degradation contract, the upload/quarantine/gh logic, the
  `set -u`/no-`set -e` choice. Change **only** line ~105.
- Any product code, other tests, docs, workflows.

## Steps

### Step 1 — fix the one line
Edit `comment.sh` line ~105 as above. Read the file's header comment first so you keep its
style (explicit error checks, no `set -e`).

**Verify manually against a real fixture** (prove the fix, don't assume):
```bash
# realistic XML → must now be detected as '<'
printf '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites/>\n' \
  | grep -m1 -o '[^[:space:]]' | head -n1     # expect: <
# leading whitespace → still '<'
printf '\n\n  <?xml version="1.0"?>\n' \
  | grep -m1 -o '[^[:space:]]' | head -n1     # expect: <
# real Playwright JSON → must NOT be '<' (a '{')
printf '{"suites":[]}\n' | grep -m1 -o '[^[:space:]]' | head -n1   # expect: {
```
If your environment has GNU grep only via a container, also confirm there (the action runs on
`ubuntu-latest`); the reviewer checked BSD grep and GNU grep 3.12 agree, but verify your fix,
not just the bug.

### Step 2 — update the tests
Make the case-6 changes above. Then run **the whole** `action-comment-sh` suite (not just case
6) to confirm nothing else regressed, and the `action-partition` suite is untouched.

**Verify**:
```bash
rtk proxy pnpm --filter api exec vitest run src/action-comment-sh.test.ts src/action-partition.test.ts
```
→ all green; paste the counts. Run with `DATABASE_URL` unset to confirm the suites still execute
(they must not self-skip).

### Step 3 — prove the fixed test bites
Temporarily revert **only** your one-line fix in a scratch copy of `comment.sh` (or `git stash`
the script hunk), run the updated case-6 realistic-XML test against the un-fixed script, and
confirm it now **fails** (the friendly message doesn't fire on the old code). Restore the fix.
Paste what you observed. This proves the new test actually depends on the fix rather than
passing regardless.

## Done criteria

- [ ] `comment.sh` detection fires for a realistic multi-line `<?xml …?>` report (verified against a real fixture, output pasted)
- [ ] `comment.sh` detection still fires for a lone-`<` first line and for a leading-whitespace XML report
- [ ] Real Playwright JSON (`{…`) and an empty/whitespace file are **not** misdetected (still fall through unchanged)
- [ ] The `BUG:` test is replaced by a corrected-behavior test; a leading-whitespace case is added; the lone-`<` case still passes
- [ ] The updated realistic-XML test is shown to **fail** against the un-fixed script (Step 3 output pasted)
- [ ] `action-comment-sh.test.ts` + `action-partition.test.ts` both green with `DATABASE_URL` unset; counts pasted; neither self-skips
- [ ] `git diff --name-only main` shows only `.github/action-scripts/comment.sh` and `apps/api/src/action-comment-sh.test.ts`
- [ ] `pnpm --filter api exec tsc --noEmit` → 0 errors; `rtk proxy pnpm lint` → exit 0
- [ ] The one-line change is genuinely one line; the rest of `comment.sh` is byte-identical (`git diff` the file and confirm)

## Test/verification setup

- **No Postgres, no network** — same hermetic setup as plan 033. The suites shell to real
  `jq`/`bash` and mock `curl`/`gh`.
- `rtk proxy` prefix for `pnpm`/`git`/`grep`.
- The action runs on `ubuntu-latest` (GNU grep). The macOS dev box has BSD grep; the reviewer
  confirmed both agree on the fixed and buggy behavior, but verify your own change.

## STOP conditions

- **The one-line fix turns out not to be one line** — if you find you need to restructure the
  block, STOP and report why. This is meant to be a surgical change; a bigger diff means either
  the bug is deeper than diagnosed or you're gold-plating.
- **Any `action-partition` test changes** — you should not be touching it. If it breaks, you
  changed something out of scope; STOP.
- **The fix makes real Playwright JSON get misdetected as XML** (a `{`-leading report reading as
  `<`) — that would be a worse bug than the one you're fixing. STOP and rethink.

## Maintenance notes

- After this lands, `comment.sh`'s JUnit detection does what its comment claims, and follow-up
  #8 in `plans/README.md` is closed.
- The lesson worth keeping: `grep -m1 -o` limits **lines**, not matches — `-m1` + `-o` on a
  multi-match line prints the whole line's matches. Reach for `| head -n1` (or `-o` + a byte
  read) when you want the first *match*, not the first *line*.
