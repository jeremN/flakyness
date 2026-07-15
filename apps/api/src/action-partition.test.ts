// Characterization tests for `.github/action-scripts/partition.jq`, the pure
// core of the GitHub Action's PR-comment renderer. This suite shells to the
// REAL `jq` binary and asserts on parsed output — it imports nothing from
// the app, needs no DATABASE_URL, and therefore never self-skips.
//
// See `.github/action-scripts/partition.jq`'s own header comments for the
// contract being pinned here (test-name construction, the dual attempt
// shapes, spec_failed semantics, the 3-way muted/auto-flaky/unknown
// partition, HTML escaping, and body rendering).
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const JQ_SCRIPT = path.resolve(
  import.meta.dirname,
  '../../../.github/action-scripts/partition.jq'
);

// A loud, explicit guard: if `jq` isn't on PATH, THROW so the whole suite
// reports as failed (red), never silently skipped (green-but-untested).
beforeAll(() => {
  try {
    execFileSync('jq', ['--version'], { encoding: 'utf8' });
  } catch (err) {
    throw new Error(
      `partition.jq characterization suite requires the real 'jq' binary on PATH, ` +
        `but it could not be executed: ${(err as Error).message}`
    );
  }
});

interface PartitionResult {
  total: number;
  mutedCount: number;
  autoFlakyCount: number;
  unknownCount: number;
  body: string;
}

function partition(
  report: unknown,
  quarantine: unknown,
  scriptPath: string = JQ_SCRIPT
): PartitionResult {
  const out = execFileSync(
    'jq',
    ['-c', '--argjson', 'quarantine', JSON.stringify(quarantine), '-f', scriptPath],
    { input: JSON.stringify(report), encoding: 'utf8' }
  );
  return JSON.parse(out);
}

const emptyQuarantine = { muted: [], flaky: [] };

function specSuite(title: string, specs: unknown[], nestedSuites: unknown[] = []) {
  return { title, specs, suites: nestedSuites };
}

function failingSpec(title: string, opts: { legacy?: boolean } = {}) {
  return opts.legacy
    ? { title, results: [{ status: 'failed' }] }
    : { title, tests: [{ results: [{ status: 'failed' }] }] };
}

function passingSpec(title: string) {
  return { title, tests: [{ results: [{ status: 'passed' }] }] };
}

describe('partition.jq', () => {
  describe('case 1: all-passing / empty report', () => {
    it('reports zero failures and the "no failing tests" message', () => {
      const result = partition({ suites: [] }, emptyQuarantine);

      expect(result.total).toBe(0);
      expect(result.mutedCount).toBe(0);
      expect(result.autoFlakyCount).toBe(0);
      expect(result.unknownCount).toBe(0);
      expect(result.body).toContain('No failing tests in this run.');
    });

    it('always starts the body with the hidden marker as its first line', () => {
      const result = partition({ suites: [] }, emptyQuarantine);

      expect(result.body.split('\n')[0]).toBe('<!-- flackyness-report -->');
    });

    it('reports zero failures for an all-passing report too', () => {
      const report = { suites: [specSuite('a.spec.ts', [passingSpec('passes')])] };
      const result = partition(report, emptyQuarantine);

      expect(result.total).toBe(0);
    });
  });

  describe('case 2: one muted failure', () => {
    it('counts it as muted, not flaky or unknown, and lists it under Muted', () => {
      const report = { suites: [specSuite('auth.spec.ts', [failingSpec('flaky login')])] };
      const quarantine = { muted: [{ testName: 'flaky login' }], flaky: [] };

      const result = partition(report, quarantine);

      expect(result.total).toBe(1);
      expect(result.mutedCount).toBe(1);
      expect(result.autoFlakyCount).toBe(0);
      expect(result.unknownCount).toBe(0);

      const mutedSection = result.body.split('Muted — known-flaky')[1];
      expect(mutedSection).toContain('<code>flaky login</code>');
    });
  });

  describe('case 3: one auto-flaky failure (in flaky, not muted)', () => {
    it('counts it as auto-flaky', () => {
      const report = { suites: [specSuite('auth.spec.ts', [failingSpec('sometimes fails')])] };
      const quarantine = { muted: [], flaky: [{ testName: 'sometimes fails' }] };

      const result = partition(report, quarantine);

      expect(result.total).toBe(1);
      expect(result.mutedCount).toBe(0);
      expect(result.autoFlakyCount).toBe(1);
      expect(result.unknownCount).toBe(0);

      const autoSection = result.body.split('Auto-detected flaky')[1];
      expect(autoSection).toContain('<code>sometimes fails</code>');
    });
  });

  describe('case 4: one unknown failure', () => {
    it('counts it as unknown, opens the "Need a look" details, and singularizes', () => {
      const report = { suites: [specSuite('auth.spec.ts', [failingSpec('brand new failure')])] };

      const result = partition(report, emptyQuarantine);

      expect(result.total).toBe(1);
      expect(result.mutedCount).toBe(0);
      expect(result.autoFlakyCount).toBe(0);
      expect(result.unknownCount).toBe(1);
      expect(result.body).toContain('<details open>\n<summary>Need a look (1)</summary>');
      expect(result.body).toContain('1 test failed.');
      expect(result.body).toContain('1 needs a look.');
    });
  });

  describe('case 5: muted beats flaky', () => {
    it('when a name is in both lists, it counts as muted only', () => {
      const report = { suites: [specSuite('m.spec.ts', [failingSpec('dual-listed')])] };
      const quarantine = {
        muted: [{ testName: 'dual-listed' }],
        flaky: [{ testName: 'dual-listed' }],
      };

      const result = partition(report, quarantine);

      expect(result.mutedCount).toBe(1);
      expect(result.autoFlakyCount).toBe(0);
      expect(result.total).toBe(1);
    });
  });

  describe('case 6: suite-title prefix (the $e-capture regression test)', () => {
    const nestedReport = {
      suites: [
        specSuite('auth.spec.ts', [], [specSuite('auth', [failingSpec('logs in')])]),
      ],
    };

    it('joins a non-file describe title with the spec title via " › "', () => {
      const result = partition(nestedReport, emptyQuarantine);

      expect(result.unknownCount).toBe(1);
      expect(result.body).toContain('<code>auth › logs in</code>');
      // The file-suite title itself must NOT appear in the name.
      expect(result.body).not.toContain('auth.spec.ts › auth › logs in');
    });

    it('mutation proof: removing the ". as $e |" capture silently drops the prefix', () => {
      const original = readFileSync(JQ_SCRIPT, 'utf8');
      const anchor =
        'map(. as $e | {name: ($e.spec | test_name($e.titlePath)), failed: ($e.spec | spec_failed)})';
      const broken =
        'map({name: (.spec | test_name(.titlePath)), failed: (.spec | spec_failed)})';
      expect(original).toContain(anchor); // guard: fail loudly if the source ever moves/changes shape

      const tmpDir = mkdtempSync(path.join(tmpdir(), 'flackyness-partition-mutant-'));
      const brokenScript = path.join(tmpDir, 'partition-broken.jq');
      try {
        writeFileSync(brokenScript, original.replace(anchor, broken));

        const brokenResult = partition(nestedReport, emptyQuarantine, brokenScript);

        // The bug is exactly as documented: no jq error (null + x == x is a
        // silent identity), but the "auth" describe-title prefix is lost.
        expect(brokenResult.total).toBe(1); // counts/partition are unaffected
        expect(brokenResult.body).not.toContain('auth › logs in');
        expect(brokenResult.body).toContain('<code>logs in</code>');

        // Sanity: a report with NO describe prefix to lose (case 7's shape)
        // is unaffected by the mutation — this is *why* the bug is invisible
        // in the common case and only bites nested describes.
        const flatReport = {
          suites: [specSuite('header.spec.ts', [failingSpec('renders header')])],
        };
        const brokenFlatResult = partition(flatReport, emptyQuarantine, brokenScript);
        const realFlatResult = partition(flatReport, emptyQuarantine, JQ_SCRIPT);
        expect(brokenFlatResult.body).toBe(realFlatResult.body);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('case 7: file-suite title is skipped (no prefix)', () => {
    it('a spec whose only ancestor is a file-path suite gets no prefix', () => {
      const report = { suites: [specSuite('header.spec.ts', [failingSpec('renders header')])] };

      const result = partition(report, emptyQuarantine);

      expect(result.body).toContain('<code>renders header</code>');
      expect(result.body).not.toContain('header.spec.ts');
    });
  });

  describe('case 8: HTML escaping, & first (no double-escape)', () => {
    it('escapes & before < and >, and does not double-escape', () => {
      const dangerousName = 'renders <b> & "q" </details>';
      const report = { suites: [specSuite('weird.spec.ts', [failingSpec(dangerousName)])] };

      const result = partition(report, emptyQuarantine);

      expect(result.body).toContain(
        '<code>renders &lt;b&gt; &amp; "q" &lt;/details&gt;</code>'
      );
      expect(result.body).not.toContain('&amp;lt;');
      expect(result.body).not.toContain('&amp;gt;');
    });
  });

  describe('case 9: spec_failed semantics', () => {
    it('passed-then-failed (recovered on retry) is NOT a failure', () => {
      const report = {
        suites: [
          {
            title: 'r.spec.ts',
            specs: [
              {
                title: 'flakes then passes',
                tests: [{ results: [{ status: 'failed' }, { status: 'passed' }] }],
              },
            ],
          },
        ],
      };

      const result = partition(report, emptyQuarantine);

      expect(result.total).toBe(0);
    });

    it('all-skipped is NOT a failure', () => {
      const report = {
        suites: [
          {
            title: 's.spec.ts',
            specs: [
              { title: 'skipped test', tests: [{ results: [{ status: 'skipped' }] }] },
            ],
          },
        ],
      };

      const result = partition(report, emptyQuarantine);

      expect(result.total).toBe(0);
    });

    it('spec.tests[].results[] (real reporter shape), all-failed, IS counted', () => {
      const report = { suites: [specSuite('t.spec.ts', [failingSpec('fails for real')])] };

      const result = partition(report, emptyQuarantine);

      expect(result.total).toBe(1);
    });

    it('spec.results[] (legacy shape), all-failed, IS counted', () => {
      const report = {
        suites: [specSuite('t.spec.ts', [failingSpec('legacy failing', { legacy: true })])],
      };

      const result = partition(report, emptyQuarantine);

      expect(result.total).toBe(1);
    });
  });

  describe('case 10: pluralization', () => {
    it('2 unknown failures use plural "tests failed" / "need a look"', () => {
      const report = {
        suites: [
          specSuite('p.spec.ts', [failingSpec('first fails'), failingSpec('second fails')]),
        ],
      };

      const result = partition(report, emptyQuarantine);

      expect(result.total).toBe(2);
      expect(result.body).toContain('2 tests failed.');
      expect(result.body).toContain('2 need a look.');
    });

    it('1 unknown failure uses singular "test failed" / "needs a look"', () => {
      const report = { suites: [specSuite('p.spec.ts', [failingSpec('only one fails')])] };

      const result = partition(report, emptyQuarantine);

      expect(result.body).toContain('1 test failed.');
      expect(result.body).toContain('1 needs a look.');
    });
  });
});
