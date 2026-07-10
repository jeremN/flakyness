import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseJUnitReport } from './junit';

const basicReport = readFileSync(join(__dirname, '../../fixtures/junit-basic.xml'), 'utf-8');
const singleSuiteReport = readFileSync(join(__dirname, '../../fixtures/junit-single-suite.xml'), 'utf-8');
const malformedReport = readFileSync(join(__dirname, '../../fixtures/junit-malformed.xml'), 'utf-8');

describe('JUnit Parser', () => {
  describe('junit-basic.xml (<testsuites> root, multiple suites)', () => {
    it('counts statuses correctly', () => {
      const parsed = parseJUnitReport(basicReport);

      expect(parsed.totalTests).toBe(4);
      expect(parsed.passed).toBe(2);
      expect(parsed.failed).toBe(1);
      expect(parsed.skipped).toBe(1);
      expect(parsed.flaky).toBe(0);
    });

    it('builds testName as classname › name', () => {
      const parsed = parseJUnitReport(basicReport);
      const testNames = parsed.results.map((r) => r.testName);

      expect(testNames).toContain('auth.spec.ts › should login with valid credentials');
      expect(testNames).toContain('auth.spec.ts › should reject invalid credentials');
      expect(testNames).toContain('checkout.spec.ts › should complete purchase');
    });

    it('falls back to classname for testFile when neither testcase nor suite has a file attr', () => {
      const parsed = parseJUnitReport(basicReport);
      const test = parsed.results.find((r) => r.testName.includes('should complete purchase'));

      expect(test?.testFile).toBe('checkout.spec.ts');
    });

    it('maps durations from seconds to milliseconds', () => {
      const parsed = parseJUnitReport(basicReport);
      const test = parsed.results.find((r) => r.testName.includes('login with valid'));

      expect(test?.durationMs).toBe(523);
    });

    it('defaults durationMs to 0 when the time attribute is absent', () => {
      const parsed = parseJUnitReport(basicReport);
      const test = parsed.results.find((r) => r.testName.includes('should complete purchase'));

      expect(test?.durationMs).toBe(0);
    });

    it('extracts the failure message and text content', () => {
      const parsed = parseJUnitReport(basicReport);
      const test = parsed.results.find((r) => r.testName.includes('reject invalid credentials'));

      expect(test?.status).toBe('failed');
      expect(test?.errorMessage).toContain('expect(received).toBe(expected)');
    });

    it('maps a <skipped> child to status skipped with no error message', () => {
      const parsed = parseJUnitReport(basicReport);
      const test = parsed.results.find((r) => r.testName.includes('redirect after logout'));

      expect(test?.status).toBe('skipped');
      expect(test?.errorMessage).toBeNull();
    });

    it('never sets status to flaky and always has retryCount 0', () => {
      const parsed = parseJUnitReport(basicReport);

      for (const result of parsed.results) {
        expect(result.status).not.toBe('flaky');
        expect(result.retryCount).toBe(0);
      }
    });

    it('defaults tags and annotations to empty arrays on every result', () => {
      const parsed = parseJUnitReport(basicReport);

      for (const result of parsed.results) {
        expect(result.tags).toEqual([]);
        expect(result.annotations).toEqual([]);
      }
    });

    it('uses the root time attribute for the report-level duration when present', () => {
      const parsed = parseJUnitReport(basicReport);

      expect(parsed.durationMs).toBe(2345);
    });

    it('derives startedAt/finishedAt from suite timestamps when the root has none', () => {
      const parsed = parseJUnitReport(basicReport);

      expect(parsed.startedAt?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
      expect(parsed.finishedAt?.toISOString()).toBe('2026-07-01T00:00:02.000Z');
    });
  });

  describe('junit-single-suite.xml (bare <testsuite> root)', () => {
    it('parses a bare <testsuite> root the same as a <testsuites>-wrapped one', () => {
      const parsed = parseJUnitReport(singleSuiteReport);

      expect(parsed.totalTests).toBe(2);
      expect(parsed.passed).toBe(1);
      expect(parsed.failed).toBe(1);
    });

    it('falls back to classname for testFile when no file attr is present anywhere', () => {
      const parsed = parseJUnitReport(singleSuiteReport);
      const test = parsed.results.find((r) => r.testName.includes('test_valid_login'));

      expect(test?.testFile).toBe('tests.test_login');
    });

    it('uses the root time/timestamp attrs directly', () => {
      const parsed = parseJUnitReport(singleSuiteReport);

      expect(parsed.durationMs).toBe(1234);
      expect(parsed.startedAt?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
      expect(parsed.finishedAt?.toISOString()).toBe('2026-07-01T00:00:01.234Z');
    });

    it('combines a failure message attr and text content', () => {
      const parsed = parseJUnitReport(singleSuiteReport);
      const test = parsed.results.find((r) => r.testName.includes('test_invalid_login'));

      expect(test?.status).toBe('failed');
      expect(test?.errorMessage).toContain('AssertionError');
      expect(test?.errorMessage).toContain('assert 200 == 401');
    });
  });

  describe('malformed XML', () => {
    it('throws a clear error instead of silently producing garbage', () => {
      expect(() => parseJUnitReport(malformedReport)).toThrow(/Invalid JUnit XML/);
    });
  });

  describe('structure tolerance and normalization', () => {
    it('normalizes a single testcase (not wrapped in an array) the same as multiple', () => {
      const xml =
        '<testsuites><testsuite name="s"><testcase classname="c" name="only test" time="0.05"/></testsuite></testsuites>';

      const parsed = parseJUnitReport(xml);

      expect(parsed.totalTests).toBe(1);
      expect(parsed.results[0].testName).toBe('c › only test');
      expect(parsed.results[0].durationMs).toBe(50);
    });

    it('normalizes a single testsuite (not wrapped in an array) under a <testsuites> root', () => {
      const xml =
        '<testsuites><testsuite name="s"><testcase classname="c" name="a" time="0.01"/><testcase classname="c" name="b" time="0.02"/></testsuite></testsuites>';

      const parsed = parseJUnitReport(xml);

      expect(parsed.totalTests).toBe(2);
    });

    it('throws when the root element is neither <testsuites> nor <testsuite>', () => {
      const xml = '<?xml version="1.0"?><foo><bar/></foo>';

      expect(() => parseJUnitReport(xml)).toThrow(/root/);
    });

    it('throws a clear error when a testcase is missing its name attribute', () => {
      const xml = '<testsuites><testsuite name="s"><testcase classname="c" time="0.1"/></testsuite></testsuites>';

      expect(() => parseJUnitReport(xml)).toThrow();
    });
  });

  describe('testFile precedence: testcase file > suite file > classname > empty string', () => {
    it('prefers the testcase-level file attr over the suite-level one', () => {
      const xml = `<testsuites>
        <testsuite name="s1" file="suite-level.spec.ts">
          <testcase classname="Foo" name="t1" file="case-level.spec.ts" time="0.01"/>
          <testcase classname="Foo" name="t2" time="0.01"/>
        </testsuite>
        <testsuite name="s2">
          <testcase name="t3" time="0.01"/>
        </testsuite>
      </testsuites>`;

      const parsed = parseJUnitReport(xml);
      const t1 = parsed.results.find((r) => r.testName.endsWith('t1'));
      const t2 = parsed.results.find((r) => r.testName.endsWith('t2'));
      const t3 = parsed.results.find((r) => r.testName === 't3');

      expect(t1?.testFile).toBe('case-level.spec.ts');
      expect(t2?.testFile).toBe('suite-level.spec.ts');
      expect(t3?.testFile).toBe('');
    });
  });

  describe('duration fallback', () => {
    it('sums individual test durations when the root has no time attribute', () => {
      const xml =
        '<testsuites><testsuite name="s1"><testcase classname="c" name="a" time="0.100"/><testcase classname="c" name="b" time="0.200"/></testsuite></testsuites>';

      const parsed = parseJUnitReport(xml);

      expect(parsed.durationMs).toBe(300);
    });
  });

  describe('startedAt/finishedAt fallback', () => {
    it('derives the window from suite timestamps across multiple suites when the root has none', () => {
      const xml = `<testsuites>
        <testsuite name="s1" time="1.000" timestamp="2026-07-01T00:00:00Z">
          <testcase classname="c" name="a" time="1.000"/>
        </testsuite>
        <testsuite name="s2" time="0.500" timestamp="2026-07-01T00:00:05Z">
          <testcase classname="c" name="b" time="0.500"/>
        </testsuite>
      </testsuites>`;

      const parsed = parseJUnitReport(xml);

      expect(parsed.startedAt?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
      expect(parsed.finishedAt?.toISOString()).toBe('2026-07-01T00:00:05.500Z');
    });

    it('leaves startedAt/finishedAt null when no timestamp is present anywhere', () => {
      const xml = '<testsuites><testsuite name="s"><testcase classname="c" name="a" time="0.1"/></testsuite></testsuites>';

      const parsed = parseJUnitReport(xml);

      expect(parsed.startedAt).toBeNull();
      expect(parsed.finishedAt).toBeNull();
    });
  });

  describe('<error> nodes', () => {
    it('treats an <error> child the same as a <failure> child', () => {
      const xml =
        '<testsuites><testsuite name="s"><testcase classname="c" name="t" time="0.01"><error message="boom">stack trace</error></testcase></testsuite></testsuites>';

      const parsed = parseJUnitReport(xml);

      expect(parsed.results[0].status).toBe('failed');
      expect(parsed.results[0].errorMessage).toContain('boom');
      expect(parsed.results[0].errorMessage).toContain('stack trace');
    });
  });

  describe('clamps', () => {
    it('truncates oversized names and error messages', () => {
      const longName = 'x'.repeat(600);
      const longMessage = 'e'.repeat(20_000);
      const xml = `<testsuites><testsuite name="s"><testcase classname="c" name="${longName}" time="0.01"><failure message="${longMessage}"/></testcase></testsuite></testsuites>`;

      const parsed = parseJUnitReport(xml);

      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].testName.length).toBeLessThanOrEqual(500);
      expect(parsed.results[0].errorMessage?.length).toBeLessThanOrEqual(10_000);
    });
  });

  describe('entity-expansion defense (XXE)', () => {
    it('does not expand DOCTYPE-declared entities', () => {
      const xml = `<?xml version="1.0"?>
<!DOCTYPE testsuites [
  <!ENTITY xxe "EXPANDED_PAYLOAD">
]>
<testsuites>
  <testsuite name="s">
    <testcase classname="c" name="&xxe;" time="0.1"/>
  </testsuite>
</testsuites>`;

      const parsed = parseJUnitReport(xml);

      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].testName).not.toContain('EXPANDED_PAYLOAD');
      expect(parsed.results[0].testName).toContain('&xxe;');
    });

    it('does not expand nested ("billion laughs" style) entity chains', () => {
      const xml = `<?xml version="1.0"?>
<!DOCTYPE testsuites [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
]>
<testsuites>
  <testsuite name="s">
    <testcase classname="c" name="&lol2;" time="0.1"/>
  </testsuite>
</testsuites>`;

      const parsed = parseJUnitReport(xml);

      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].testName).not.toContain('lollollol');
    });
  });

  describe('payload guard', () => {
    it('rejects reports with more than 50,000 testcases', () => {
      const testcases = Array.from(
        { length: 50_001 },
        (_, i) => `<testcase classname="c" name="t${i}" time="0.01"/>`
      ).join('');
      const xml = `<?xml version="1.0"?><testsuites><testsuite name="big">${testcases}</testsuite></testsuites>`;

      expect(() => parseJUnitReport(xml)).toThrow(/50,000/);
    }, 20_000);
  });
});
