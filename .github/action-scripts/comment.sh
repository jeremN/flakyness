#!/usr/bin/env bash
#
# Flackyness GitHub Action — upload a report, fetch the quarantine list, and
# comment on the PR partitioning this run's failures into muted / auto-flaky
# / unknown.
#
# Design decision (plans/024-github-action-pr-comments.md): this action
# reports, it never fails the build. The ONLY exception is a missing
# required input (api-url / token / project-id), which is a config bug the
# user must fix, not a Flackyness outage. Every other failure mode (upload
# fails, quarantine lookup fails, report missing, report unparsable, PR
# comment API fails) prints a `::warning::` and exits 0.
#
# Deliberately NOT `set -e`: every external command (curl, jq, gh) is
# checked explicitly so a single failed step degrades quietly instead of
# aborting the whole script non-zero. Do not add `set -e` here — see the
# Maintenance notes in the plan.
set -u

MARKER='<!-- flackyness-report -->'

warn() { echo "::warning::flackyness: $*"; }
info() { echo "flackyness: $*"; }

API_URL="${FLACKYNESS_API_URL:-}"
TOKEN="${FLACKYNESS_TOKEN:-}"
PROJECT_ID="${FLACKYNESS_PROJECT_ID:-}"
REPORT_PATH="${FLACKYNESS_REPORT_PATH:-playwright-report/report.json}"
DO_COMMENT="${FLACKYNESS_COMMENT:-true}"
BRANCH="${FLACKYNESS_BRANCH:-main}"
COMMIT="${FLACKYNESS_COMMIT:-}"
PIPELINE="${FLACKYNESS_PIPELINE:-}"
PR_NUMBER="${FLACKYNESS_PR_NUMBER:-}"
REPO="${FLACKYNESS_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
JQ_SCRIPT="$(dirname "${BASH_SOURCE[0]}")/partition.jq"

# --- Config validation: the one case allowed to fail the build ------------
missing=()
[ -z "$API_URL" ] && missing+=("api-url")
[ -z "$TOKEN" ] && missing+=("token")
[ -z "$PROJECT_ID" ] && missing+=("project-id")
if [ "${#missing[@]}" -gt 0 ]; then
  echo "::error::flackyness: missing required input(s): ${missing[*]}" >&2
  exit 1
fi

if [ ! -f "$REPORT_PATH" ]; then
  warn "report file not found at '$REPORT_PATH' — skipping upload and comment."
  exit 0
fi

# --- 1. Upload the report --------------------------------------------------
enc() { jq -rn --arg v "$1" '$v | @uri'; }

upload_url="${API_URL%/}/api/v1/reports?branch=$(enc "$BRANCH")&commit=$(enc "$COMMIT")"
if [ -n "$PIPELINE" ]; then
  upload_url="${upload_url}&pipeline=$(enc "$PIPELINE")"
fi

upload_body_file="$(mktemp)"
# The token is passed via a header built from an env var, never interpolated
# into a logged string, and `set -x` is never used in this script.
upload_status=$(curl -sS -o "$upload_body_file" -w '%{http_code}' \
  -X POST "$upload_url" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  --data-binary "@${REPORT_PATH}" 2>/tmp/flackyness-upload-stderr.log)
upload_curl_exit=$?
rm -f "$upload_body_file"

if [ $upload_curl_exit -ne 0 ] || [ "${upload_status:0:1}" != "2" ]; then
  warn "report upload failed (HTTP ${upload_status:-unreachable}) — degrading quietly, not failing the build."
  exit 0
fi
info "report uploaded (HTTP $upload_status)."

# --- 2. Fetch the quarantine list ------------------------------------------
quarantine_body_file="$(mktemp)"
quarantine_status=$(curl -sS -o "$quarantine_body_file" -w '%{http_code}' \
  "${API_URL%/}/api/v1/projects/${PROJECT_ID}/quarantine" 2>/tmp/flackyness-quarantine-stderr.log)
quarantine_curl_exit=$?

if [ $quarantine_curl_exit -ne 0 ] || [ "$quarantine_status" != "200" ]; then
  warn "quarantine lookup failed (HTTP ${quarantine_status:-unreachable}) — degrading quietly, not failing the build."
  rm -f "$quarantine_body_file"
  exit 0
fi
quarantine_json="$(cat "$quarantine_body_file")"
rm -f "$quarantine_body_file"

# --- 3. Should we even try to comment? --------------------------------------
if [ "$DO_COMMENT" != "true" ]; then
  info "comment input is not 'true' — upload-only mode, done."
  exit 0
fi

# --- 4. Extract this run's failures, partition, render ----------------------
first_nonspace_char="$(grep -m1 -o '[^[:space:]]' "$REPORT_PATH" 2>/dev/null || true)"
if [ "$first_nonspace_char" = "<" ]; then
  warn "'$REPORT_PATH' looks like JUnit XML, not Playwright JSON — skipping the PR comment (upload already completed)."
  exit 0
fi

partition_json="$(jq -c --argjson quarantine "$quarantine_json" -f "$JQ_SCRIPT" "$REPORT_PATH" 2>/tmp/flackyness-jq-stderr.log)"
if [ $? -ne 0 ]; then
  warn "could not parse '$REPORT_PATH' as a Playwright JSON report — skipping the PR comment (upload already completed)."
  cat /tmp/flackyness-jq-stderr.log >&2 || true
  exit 0
fi

total_failures="$(jq -r '.total' <<<"$partition_json")"
comment_body_file="$(mktemp)"
jq -r '.body' <<<"$partition_json" > "$comment_body_file"

info "rendered comment body:"
echo "-----8<----- flackyness comment body -----8<-----"
cat "$comment_body_file"
echo "----->8----- end flackyness comment body ----->8-----"

has_marker_line="$(head -n1 "$comment_body_file")"
if [ "$has_marker_line" != "$MARKER" ]; then
  warn "rendered comment is missing the expected marker — not posting."
  rm -f "$comment_body_file"
  exit 0
fi

if [ -z "$PR_NUMBER" ] || [ "$PR_NUMBER" = "null" ]; then
  info "no pull-request context (not a pull_request event) — skipping PR comment."
  rm -f "$comment_body_file"
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  warn "gh CLI not found — skipping PR comment."
  rm -f "$comment_body_file"
  exit 0
fi

if [ -z "${GH_TOKEN:-}" ]; then
  warn "no github-token available — skipping PR comment."
  rm -f "$comment_body_file"
  exit 0
fi

if [ -z "$REPO" ]; then
  warn "could not determine the repository (GITHUB_REPOSITORY unset) — skipping PR comment."
  rm -f "$comment_body_file"
  exit 0
fi

# --- 5. Find any existing Flackyness comment on this PR, then upsert -------
existing_id="$(gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" --paginate \
  --jq "[.[] | select(.body | startswith(\"${MARKER}\"))] | last | .id // empty" \
  2>/tmp/flackyness-gh-list-stderr.log)"
list_exit=$?

if [ $list_exit -ne 0 ]; then
  warn "could not list PR comments — degrading quietly, not failing the build."
  cat /tmp/flackyness-gh-list-stderr.log >&2 || true
  rm -f "$comment_body_file"
  exit 0
fi

if [ -n "$existing_id" ]; then
  # Always update an existing comment, even at zero failures — a stale
  # "look at these" left over from a previous failing push would be worse
  # than a quiet update to "no failing tests".
  # -F (not -f): only -F/--field supports the "@<path>" read-from-file form.
  if gh api --method PATCH "repos/${REPO}/issues/comments/${existing_id}" -F body="@${comment_body_file}" >/dev/null 2>/tmp/flackyness-gh-upsert-stderr.log; then
    info "updated existing PR comment (id $existing_id)."
  else
    warn "failed to update the existing PR comment — degrading quietly, not failing the build."
    cat /tmp/flackyness-gh-upsert-stderr.log >&2 || true
  fi
elif [ "$total_failures" = "0" ]; then
  # Design decision 6: zero failures and nothing to update — don't create a
  # brand-new "all green" comment on every passing push.
  info "no failures and no existing comment — nothing to post."
else
  if gh api --method POST "repos/${REPO}/issues/${PR_NUMBER}/comments" -F body="@${comment_body_file}" >/dev/null 2>/tmp/flackyness-gh-upsert-stderr.log; then
    info "created PR comment."
  else
    warn "failed to create the PR comment — degrading quietly, not failing the build."
    cat /tmp/flackyness-gh-upsert-stderr.log >&2 || true
  fi
fi

rm -f "$comment_body_file"
exit 0
