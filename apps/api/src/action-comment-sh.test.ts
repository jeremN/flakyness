// Characterization tests for `.github/action-scripts/comment.sh`'s ONE
// contract (see the script's own header comment / plans/024): this action
// REPORTS, it never fails the build, except for one case — a missing
// required input (api-url / token / project-id) is a config bug the user
// must fix, and is the ONLY way this script exits non-zero. Every other
// failure mode (upload fails, quarantine lookup fails, report missing or
// unparsable, PR comment API fails) prints a `::warning::` and exits 0.
//
// This suite runs the REAL comment.sh under bash, with mock `curl` and `gh`
// executables on a temp PATH (the real `jq` and `bash` stay on PATH). No
// network, no Postgres — fully hermetic.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const COMMENT_SH = path.resolve(
  import.meta.dirname,
  '../../../.github/action-scripts/comment.sh'
);

// --- Mock `curl` --------------------------------------------------------
// Emulates just the behaviors comment.sh depends on: write the response
// body to the file given via `-o <file>`, print the HTTP status code to
// stdout (mirroring curl's `-w '%{http_code}'`), and exit 0 (a completed
// request — comment.sh distinguishes "request failed to even complete"
// from "server returned an error status" via curl's own exit code, but we
// only need to exercise the latter here). Driven by env vars so each test
// can pick its own response. When $MOCK_CURL_LOG is set, also logs every
// invocation's full argv to that file — same mechanism as the `gh` mock
// below — so a test can prove which headers/flags a specific curl call
// actually received (e.g. the quarantine request's Authorization header).
const MOCK_CURL_LINES = [
  '#!/usr/bin/env bash',
  'set -u',
  'args=("$@")',
  'outfile=""',
  'url=""',
  'for ((i = 0; i < ${#args[@]}; i++)); do',
  '  case "${args[$i]}" in',
  '    -o) outfile="${args[$((i + 1))]}" ;;',
  '    http*://*) url="${args[$i]}" ;;',
  '  esac',
  'done',
  '',
  'if [ -n "${MOCK_CURL_LOG:-}" ]; then',
  '  {',
  "    printf 'ARGS:'",
  '    for a in "$@"; do printf \' [%s]\' "$a"; done',
  "    printf '\\n'",
  '  } >> "$MOCK_CURL_LOG"',
  'fi',
  '',
  'if [[ "$url" == *"/api/v1/reports"* ]]; then',
  '  status="${MOCK_REPORTS_STATUS:-201}"',
  '  body="${MOCK_REPORTS_BODY:-}"',
  'elif [[ "$url" == *"/quarantine"* ]]; then',
  '  status="${MOCK_QUARANTINE_STATUS:-200}"',
  '  if [ -n "${MOCK_QUARANTINE_BODY:-}" ]; then',
  '    body="$MOCK_QUARANTINE_BODY"',
  '  else',
  "    body='{\"muted\":[],\"flaky\":[]}'",
  '  fi',
  'else',
  '  status="000"',
  '  body=""',
  'fi',
  '',
  'if [ -n "$outfile" ]; then',
  "  printf '%s' \"$body\" > \"$outfile\"",
  'fi',
  "printf '%s' \"$status\"",
  'exit 0',
  '',
].join('\n');

// --- Mock `gh` -----------------------------------------------------------
// Logs every invocation's argv to $MOCK_GH_LOG. For the comment-listing
// call (`gh api ... --paginate --jq ...`, no --method) it prints
// $MOCK_GH_LIST_OUTPUT to stdout and exits per $MOCK_GH_LIST_EXIT. For
// --method POST/PATCH it records the body file referenced by `-F
// body=@<path>` (comment.sh always uses -F, never -f, since only -F
// supports the "@path" read-from-file form) to "$MOCK_GH_LOG.last-body",
// and exits per $MOCK_GH_POST_EXIT / $MOCK_GH_PATCH_EXIT.
const MOCK_GH_LINES = [
  '#!/usr/bin/env bash',
  'set -u',
  'log="${MOCK_GH_LOG:?MOCK_GH_LOG not set}"',
  '{',
  "  printf 'ARGS:'",
  '  for a in "$@"; do printf \' [%s]\' "$a"; done',
  "  printf '\\n'",
  '} >> "$log"',
  '',
  'args=("$@")',
  'method=""',
  'bodyfile=""',
  'for ((i = 0; i < ${#args[@]}; i++)); do',
  '  case "${args[$i]}" in',
  '    --method) method="${args[$((i + 1))]}" ;;',
  '    body=@*) bodyfile="${args[$i]#body=@}" ;;',
  '  esac',
  'done',
  '',
  'if [ -n "$bodyfile" ] && [ -f "$bodyfile" ]; then',
  '  cp "$bodyfile" "${log}.last-body"',
  'fi',
  '',
  'if [ "$method" = "POST" ]; then',
  '  exit "${MOCK_GH_POST_EXIT:-0}"',
  'elif [ "$method" = "PATCH" ]; then',
  '  exit "${MOCK_GH_PATCH_EXIT:-0}"',
  'else',
  "  printf '%s' \"${MOCK_GH_LIST_OUTPUT:-}\"",
  '  exit "${MOCK_GH_LIST_EXIT:-0}"',
  'fi',
  '',
].join('\n');

const SAMPLE_REPORT_JSON = JSON.stringify({
  suites: [
    {
      title: 'a.spec.ts',
      specs: [
        { title: 'sample fail', tests: [{ results: [{ status: 'failed' }] }] },
      ],
    },
  ],
});

let mockBinDir: string;
const tempDirs: string[] = [];

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeAll(() => {
  // Loud, explicit guards: if bash or jq aren't on PATH, THROW so this
  // suite reports red, never silently skipped green-but-untested.
  try {
    execFileSync('bash', ['--version'], { encoding: 'utf8' });
  } catch (err) {
    throw new Error(`action-comment-sh suite requires 'bash' on PATH: ${(err as Error).message}`);
  }
  try {
    execFileSync('jq', ['--version'], { encoding: 'utf8' });
  } catch (err) {
    throw new Error(
      `action-comment-sh suite requires 'jq' on PATH (comment.sh shells to it): ${(err as Error).message}`
    );
  }

  mockBinDir = mkdtempSync(path.join(tmpdir(), 'flackyness-comment-mockbin-'));
  const curlPath = path.join(mockBinDir, 'curl');
  const ghPath = path.join(mockBinDir, 'gh');
  writeFileSync(curlPath, MOCK_CURL_LINES);
  writeFileSync(ghPath, MOCK_GH_LINES);
  chmodSync(curlPath, 0o755);
  chmodSync(ghPath, 0o755);
});

afterAll(() => {
  rmSync(mockBinDir, { recursive: true, force: true });
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Build a child environment stripped of any ambient FLACKYNESS_/GH_/
// GITHUB_/MOCK_-prefixed vars (so a real CI environment running this suite
// can't leak state into it), with the mock bin dir prepended to PATH.
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (
      k.startsWith('FLACKYNESS_') ||
      k.startsWith('GH_') ||
      k.startsWith('GITHUB_') ||
      k.startsWith('MOCK_')
    ) {
      continue;
    }
    env[k] = v;
  }
  env.PATH = `${mockBinDir}:${env.PATH ?? ''}`;
  return env;
}

function runCommentSh(
  overrides: Record<string, string>,
  scriptPath: string = COMMENT_SH
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [scriptPath], {
    env: { ...baseEnv(), ...overrides },
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function writeReportFile(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe('comment.sh', () => {
  describe('case 1: missing required input is the ONLY non-zero exit', () => {
    it('exits 1 and names api-url when it is missing', () => {
      const dir = newTempDir('flackyness-comment-work-');
      const reportPath = writeReportFile(dir, 'report.json', SAMPLE_REPORT_JSON);

      const result = runCommentSh({
        FLACKYNESS_TOKEN: 't',
        FLACKYNESS_PROJECT_ID: 'p',
        FLACKYNESS_REPORT_PATH: reportPath,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('::error::');
      expect(result.stderr).toContain('api-url');
    });

    it('exits 1 and names token when it is missing', () => {
      const dir = newTempDir('flackyness-comment-work-');
      const reportPath = writeReportFile(dir, 'report.json', SAMPLE_REPORT_JSON);

      const result = runCommentSh({
        FLACKYNESS_API_URL: 'https://mock.example',
        FLACKYNESS_PROJECT_ID: 'p',
        FLACKYNESS_REPORT_PATH: reportPath,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('::error::');
      expect(result.stderr).toContain('token');
    });

    it('exits 1 and names project-id when it is missing', () => {
      const dir = newTempDir('flackyness-comment-work-');
      const reportPath = writeReportFile(dir, 'report.json', SAMPLE_REPORT_JSON);

      const result = runCommentSh({
        FLACKYNESS_API_URL: 'https://mock.example',
        FLACKYNESS_TOKEN: 't',
        FLACKYNESS_REPORT_PATH: reportPath,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('::error::');
      expect(result.stderr).toContain('project-id');
    });
  });

  describe('case 2: report file absent', () => {
    it('warns and exits 0 without ever trying to upload', () => {
      const dir = newTempDir('flackyness-comment-work-');
      const missingPath = path.join(dir, 'does-not-exist.json');

      const result = runCommentSh({
        FLACKYNESS_API_URL: 'https://mock.example',
        FLACKYNESS_TOKEN: 't',
        FLACKYNESS_PROJECT_ID: 'p',
        FLACKYNESS_REPORT_PATH: missingPath,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('report file not found');
    });
  });

  describe('case 3: report upload fails (the core "never fail the build" contract)', () => {
    it('warns and exits 0 when the upload returns HTTP 500', () => {
      const dir = newTempDir('flackyness-comment-work-');
      const reportPath = writeReportFile(dir, 'report.json', SAMPLE_REPORT_JSON);

      const result = runCommentSh({
        FLACKYNESS_API_URL: 'https://mock.example',
        FLACKYNESS_TOKEN: 't',
        FLACKYNESS_PROJECT_ID: 'p',
        FLACKYNESS_REPORT_PATH: reportPath,
        MOCK_REPORTS_STATUS: '500',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('report upload failed');
    });

    it('mutation proof: turning that warn-path exit 0 into exit 1 flips this test to a failure', () => {
      const original = readFileSync(COMMENT_SH, 'utf8');
      const anchor =
        'warn "report upload failed (HTTP ${upload_status:-unreachable}) — degrading quietly, not failing the build."\n  exit 0\nfi';
      expect(original).toContain(anchor); // guard: fail loudly if the source ever moves/changes shape
      const broken = anchor.replace('exit 0\nfi', 'exit 1\nfi');

      const dir = newTempDir('flackyness-comment-mutant-');
      const brokenScript = path.join(dir, 'comment-broken.sh');
      writeFileSync(brokenScript, original.replace(anchor, broken));
      chmodSync(brokenScript, 0o755);

      const reportPath = writeReportFile(dir, 'report.json', SAMPLE_REPORT_JSON);

      const result = runCommentSh(
        {
          FLACKYNESS_API_URL: 'https://mock.example',
          FLACKYNESS_TOKEN: 't',
          FLACKYNESS_PROJECT_ID: 'p',
          FLACKYNESS_REPORT_PATH: reportPath,
          MOCK_REPORTS_STATUS: '500',
        },
        brokenScript
      );

      // Same input as the test above, but against the mutated copy: the
      // contract-asserting test above would fail here (status 1 !== 0),
      // proving it actually exercises this code path.
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('report upload failed');
    });
  });

  describe('case 4: quarantine lookup fails', () => {
    it('warns and exits 0 when the quarantine fetch returns HTTP 500 (upload already succeeded)', () => {
      const dir = newTempDir('flackyness-comment-work-');
      const reportPath = writeReportFile(dir, 'report.json', SAMPLE_REPORT_JSON);

      const result = runCommentSh({
        FLACKYNESS_API_URL: 'https://mock.example',
        FLACKYNESS_TOKEN: 't',
        FLACKYNESS_PROJECT_ID: 'p',
        FLACKYNESS_REPORT_PATH: reportPath,
        MOCK_QUARANTINE_STATUS: '500',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('report uploaded');
      expect(result.stdout).toContain('quarantine lookup failed');
    });
  });

  describe('quarantine request carries the project token as a Bearer credential', () => {
    it('the quarantine curl call includes Authorization: Bearer <token>', () => {
      const dir = newTempDir('flackyness-comment-work-');
      const reportPath = writeReportFile(dir, 'report.json', SAMPLE_REPORT_JSON);
      const curlLog = path.join(dir, 'curl.log');

      const result = runCommentSh({
        FLACKYNESS_API_URL: 'https://mock.example',
        FLACKYNESS_TOKEN: 'super-secret-project-token',
        FLACKYNESS_PROJECT_ID: 'p',
        FLACKYNESS_REPORT_PATH: reportPath,
        FLACKYNESS_COMMENT: 'false',
        MOCK_CURL_LOG: curlLog,
      });

      expect(result.status).toBe(0);

      const curlLogLines = readFileSync(curlLog, 'utf8').split('\n').filter(Boolean);
      const quarantineCall = curlLogLines.find((line) => line.includes('/quarantine'));
      // Guards against a vacuous pass: if this ever comes back undefined,
      // the mock stopped seeing the quarantine request at all.
      expect(quarantineCall).toBeDefined();
      expect(quarantineCall).toContain('[Authorization: Bearer super-secret-project-token]');
    });
  });

  describe('case 5: comment=false is upload-only, gh is never invoked', () => {
    it('exits 0, logs upload-only mode, and never calls gh', () => {
      const dir = newTempDir('flackyness-comment-work-');
      const reportPath = writeReportFile(dir, 'report.json', SAMPLE_REPORT_JSON);
      const ghLog = path.join(dir, 'gh.log');

      const result = runCommentSh({
        FLACKYNESS_API_URL: 'https://mock.example',
        FLACKYNESS_TOKEN: 't',
        FLACKYNESS_PROJECT_ID: 'p',
        FLACKYNESS_REPORT_PATH: reportPath,
        FLACKYNESS_COMMENT: 'false',
        MOCK_GH_LOG: ghLog,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('upload-only mode');
      expect(existsSync(ghLog)).toBe(false);
    });
  });

  describe('case 6: JUnit XML report is not the Playwright JSON this action expects', () => {
    it('detects it and skips the PR comment when the file’s first line is a single "<"', () => {
      const dir = newTempDir('flackyness-comment-work-');
      const reportPath = writeReportFile(dir, 'report.xml', '<\n<testsuites/>\n');
      const ghLog = path.join(dir, 'gh.log');

      const result = runCommentSh({
        FLACKYNESS_API_URL: 'https://mock.example',
        FLACKYNESS_TOKEN: 't',
        FLACKYNESS_PROJECT_ID: 'p',
        FLACKYNESS_REPORT_PATH: reportPath,
        MOCK_GH_LOG: ghLog,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('looks like JUnit XML');
      expect(existsSync(ghLog)).toBe(false);
    });

    // Plan 034 fixed a bug where this never fired for realistic XML: `grep
    // -m1` stops after the first MATCHING LINE, not the first match, and
    // `-o` prints every match found within that line before stopping. For a
    // realistic XML declaration (`<?xml version="1.0" encoding="UTF-8"?>`),
    // that meant `first_nonspace_char` held ALL of those characters, one
    // per output line, which could never equal the literal string "<" — so
    // the friendly warning was dead code and execution fell through to a
    // generic jq parse-failure warning instead. The fix pipes through `head
    // -n1` to take only the first character of grep's output. This test
    // pins the corrected behavior: the friendly message now fires.
    it('detects a realistic multi-line XML declaration and skips the PR comment', () => {
      const dir = newTempDir('flackyness-comment-work-');
      const realisticJunit =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<testsuites name="jest tests" tests="1" failures="1" errors="0" skipped="0" time="1.0">\n' +
        '  <testsuite name="a.spec.ts" tests="1" failures="1"></testsuite>\n' +
        '</testsuites>\n';
      const reportPath = writeReportFile(dir, 'report.xml', realisticJunit);
      const ghLog = path.join(dir, 'gh.log');

      const result = runCommentSh({
        FLACKYNESS_API_URL: 'https://mock.example',
        FLACKYNESS_TOKEN: 't',
        FLACKYNESS_PROJECT_ID: 'p',
        FLACKYNESS_REPORT_PATH: reportPath,
        MOCK_GH_LOG: ghLog,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('looks like JUnit XML');
      expect(existsSync(ghLog)).toBe(false);
    });

    it('detects XML preceded by leading blank lines and whitespace', () => {
      const dir = newTempDir('flackyness-comment-work-');
      const leadingWhitespaceJunit = '\n\n  <?xml version="1.0"?>\n<testsuites/>\n';
      const reportPath = writeReportFile(dir, 'report.xml', leadingWhitespaceJunit);
      const ghLog = path.join(dir, 'gh.log');

      const result = runCommentSh({
        FLACKYNESS_API_URL: 'https://mock.example',
        FLACKYNESS_TOKEN: 't',
        FLACKYNESS_PROJECT_ID: 'p',
        FLACKYNESS_REPORT_PATH: reportPath,
        MOCK_GH_LOG: ghLog,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('looks like JUnit XML');
      expect(existsSync(ghLog)).toBe(false);
    });
  });

  describe('case 7: happy path — upload, quarantine, and a new PR comment', () => {
    it('creates a PR comment whose body starts with the hidden marker', () => {
      const dir = newTempDir('flackyness-comment-work-');
      const reportPath = writeReportFile(dir, 'report.json', SAMPLE_REPORT_JSON);
      const ghLog = path.join(dir, 'gh.log');

      const result = runCommentSh({
        FLACKYNESS_API_URL: 'https://mock.example',
        FLACKYNESS_TOKEN: 't',
        FLACKYNESS_PROJECT_ID: 'p',
        FLACKYNESS_REPORT_PATH: reportPath,
        FLACKYNESS_PR_NUMBER: '123',
        FLACKYNESS_REPOSITORY: 'o/r',
        GH_TOKEN: 'x',
        MOCK_GH_LOG: ghLog,
        MOCK_GH_LIST_OUTPUT: '', // no existing Flackyness comment on this PR
        MOCK_QUARANTINE_BODY: JSON.stringify({
          muted: [{ testName: 'sample fail' }],
          flaky: [],
        }),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('created PR comment');

      const ghLogContent = readFileSync(ghLog, 'utf8');
      expect(ghLogContent).toContain('--method] [POST]');

      const postedBodyFirstLine = readFileSync(`${ghLog}.last-body`, 'utf8').split('\n')[0];
      expect(postedBodyFirstLine).toBe('<!-- flackyness-report -->');
    });
  });

  describe('contract: the only non-zero exit is a missing required input', () => {
    it('exit 1 for missing config vs. exit 0 for upload-fail and quarantine-fail', () => {
      const dir = newTempDir('flackyness-comment-work-');
      const reportPath = writeReportFile(dir, 'report.json', SAMPLE_REPORT_JSON);

      const missingConfig = runCommentSh({
        FLACKYNESS_TOKEN: 't',
        FLACKYNESS_PROJECT_ID: 'p',
        FLACKYNESS_REPORT_PATH: reportPath,
      });
      const uploadFail = runCommentSh({
        FLACKYNESS_API_URL: 'https://mock.example',
        FLACKYNESS_TOKEN: 't',
        FLACKYNESS_PROJECT_ID: 'p',
        FLACKYNESS_REPORT_PATH: reportPath,
        MOCK_REPORTS_STATUS: '500',
      });
      const quarantineFail = runCommentSh({
        FLACKYNESS_API_URL: 'https://mock.example',
        FLACKYNESS_TOKEN: 't',
        FLACKYNESS_PROJECT_ID: 'p',
        FLACKYNESS_REPORT_PATH: reportPath,
        MOCK_QUARANTINE_STATUS: '500',
      });

      expect(missingConfig.status).toBe(1);
      expect(uploadFail.status).toBe(0);
      expect(quarantineFail.status).toBe(0);
    });
  });
});
