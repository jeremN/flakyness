# Flackyness: extract this run's failing specs from a Playwright JSON
# report, partition them against the quarantine list, and render the PR
# comment body.
#
# Input (.)   : the Playwright JSON report (top-level object with `suites`).
# --argjson quarantine : the /api/v1/projects/:id/quarantine response,
#                        i.e. { muted: [{testName,...}], flaky: [{testName,...}], ... }
#
# Output: a JSON object `{total, mutedCount, autoFlakyCount, unknownCount,
# body}`. `body` is the markdown comment; its FIRST LINE is always the
# hidden marker `<!-- flackyness-report -->` used to find/update this
# comment on re-runs. `total` lets the caller decide whether a zero-failure
# run is even worth creating a NEW comment for (see design decision 6 in the
# plan: skip entirely when there are zero failures and no existing comment
# to update — an all-green PR shouldn't get a fresh "nothing failed" comment
# on every push).
#
# Test-name construction mirrors apps/api/src/parsers/playwright.ts's
# buildTestName (titlePath joined with " › ", skipping suite titles that
# are just the file path). It deliberately does NOT reproduce that parser's
# per-Playwright-project ([chromium]/[firefox]) name suffixing — see
# docs/GITHUB_ACTION.md for why that's a known limitation, not an oversight.

def is_file_suite:
  (. // "") as $t
  | ($t | endswith(".ts")) or ($t | endswith(".js")) or ($t | contains("/"));

# Recursively collect {spec, titlePath} for every spec under a suite node.
def extract_specs(pathArr):
  (.title // "") as $title
  | (if ($title | is_file_suite) then pathArr
     elif $title != "" then pathArr + [$title]
     else pathArr end) as $newPath
  | (((.specs // []) | map({spec: ., titlePath: $newPath}))
     + (((.suites // []) | map(extract_specs($newPath))) | add // []));

# The real reporter nests attempts under spec.tests[].results[] (one
# tests[] entry per Playwright project running the spec). A legacy/simplified
# shape puts them directly on spec.results[]. Support both, but do not
# distinguish by project — all attempts across all tests[] entries count.
def spec_results:
  if ((.tests // []) | length) > 0
  then (.tests | map(.results // []) | add // [])
  else (.results // [])
  end;

# A spec counts as a failure for this comment when none of its attempts
# passed AND at least one attempt actually failed/timed out/was interrupted
# (a purely-skipped spec is not a failure).
def spec_failed:
  spec_results as $r
  | ($r | length) > 0
    and (($r | any(.status == "passed")) | not)
    and ($r | any(.status == "failed" or .status == "timedOut" or .status == "interrupted"));

def test_name(titlePath):
  (titlePath + [(.title // "")]) | join(" › ");

def all_failures:
  ((.suites // []) | map(extract_specs([])) | add // [])
  # NOTE: capture the {spec, titlePath} entry as $e before piping into
  # .spec — a function argument like `test_name(.titlePath)` is evaluated
  # against the pipeline's current input at the callsite (here, `.spec`,
  # which has no titlePath field), NOT against the wrapping object, so
  # without this the suite-title prefix is silently dropped (jq's `null +
  # x == x` identity makes the bug invisible rather than an error).
  | map(. as $e | {name: ($e.spec | test_name($e.titlePath)), failed: ($e.spec | spec_failed)})
  | map(select(.failed) | .name)
  | unique;

# Test names are arbitrary strings written by the test author, so they must
# never be trusted to be inert markup. Two real failure modes:
#   - a backtick (`it('renders `<Button />` correctly')` is ordinary JS/TS)
#     breaks out of a markdown code span, and
#   - a literal "</details>" closes the disclosure block early.
# HTML-escaping the name and wrapping it in <code>…</code> instead of a
# markdown backtick span fixes both at once. `&` must be substituted FIRST,
# or it would re-escape the ampersands introduced by the later rules.
# (Not a security boundary — GitHub sanitises comment HTML and this body
# never reaches a shell — purely so the comment renders intact.)
def html_escape:
  gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;");

def render_list(items):
  if (items | length) == 0 then "_none_"
  else (items | map("- <code>" + (. | html_escape) + "</code>") | join("\n"))
  end;

all_failures as $failures
| ($quarantine.muted // [] | map(.testName)) as $mutedNames
| ($quarantine.flaky // [] | map(.testName)) as $flakyNames
| ($failures | map(select(. as $t | $mutedNames | any(. == $t)))) as $muted
| ($failures | map(select(. as $t | ($mutedNames | any(. == $t) | not) and ($flakyNames | any(. == $t))))) as $autoFlaky
| ($failures | map(select(. as $t | ($mutedNames | any(. == $t) | not) and ($flakyNames | any(. == $t) | not)))) as $unknown
| ($failures | length) as $total
| ($muted | length) as $mutedCount
| ($autoFlaky | length) as $autoFlakyCount
| ($unknown | length) as $unknownCount
| {
    total: $total,
    mutedCount: $mutedCount,
    autoFlakyCount: $autoFlakyCount,
    unknownCount: $unknownCount,
    body: ([
    "<!-- flackyness-report -->",
    "## Flackyness report",
    "",
    (if $total == 0 then
       "**No failing tests in this run.** :white_check_mark:"
     else
       "**\($total) test\(if $total == 1 then "" else "s" end) failed.** \($mutedCount) known-flaky (muted), \($autoFlakyCount) auto-detected flaky. **\($unknownCount) need\(if $unknownCount == 1 then "s" else "" end) a look.**"
     end),
    "",
    ("<details" + (if $unknownCount > 0 then " open" else "" end) + ">"),
    "<summary>Need a look (\($unknownCount))</summary>",
    "",
    render_list($unknown),
    "",
    "</details>",
    "",
    "<details>",
    "<summary>Muted — known-flaky, operator-approved (\($mutedCount))</summary>",
    "",
    render_list($muted),
    "",
    "</details>",
    "",
    "<details>",
    "<summary>Auto-detected flaky (\($autoFlakyCount))</summary>",
    "",
    render_list($autoFlaky),
    "",
    "</details>",
    "",
    "_Flackyness never skips or retries tests based on this list — that decision stays with a human. This comment is informational only._"
    ] | join("\n"))
  }
