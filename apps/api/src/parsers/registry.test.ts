import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REPORT_PARSERS, dispatchReport, type ReportParser } from './registry';

const junitXml = readFileSync(join(__dirname, '../../fixtures/junit-basic.xml'), 'utf-8');

// Minimal valid Playwright report: PlaywrightReportSchema requires `config`
// (object) + `suites` (array); everything else is optional. Zero tests.
const validPlaywright = JSON.stringify({ config: {}, suites: [] });

// A throwaway parser used to prove extensibility + loop control without
// touching the real registry.
const FAKE_REPORT = {
  totalTests: 42, passed: 42, failed: 0, skipped: 0, flaky: 0,
  startedAt: null, finishedAt: null, durationMs: 0, results: [],
};
const stub = (name: string, detect: boolean, report = FAKE_REPORT): ReportParser => ({
  name,
  detect: () => detect,
  parse: () => report,
});

describe('ReportParser registry', () => {
  describe('the shipped registry', () => {
    it('registers JUnit then Playwright, in that order', () => {
      expect(REPORT_PARSERS.map((p) => p.name)).toEqual(['JUnit', 'Playwright']);
    });
  });

  describe('dispatchReport — recognized formats', () => {
    it('routes an XML body to the JUnit parser and returns its report', () => {
      const result = dispatchReport(junitXml);
      expect(result).toMatchObject({ ok: true, parser: 'JUnit' });
      if (result.ok) expect(result.report.totalTests).toBe(4);
    });

    it('routes a JSON body with a suites key to the Playwright parser', () => {
      const result = dispatchReport(validPlaywright);
      expect(result).toMatchObject({ ok: true, parser: 'Playwright' });
      if (result.ok) expect(result.report.totalTests).toBe(0);
    });
  });

  describe('dispatchReport — unrecognized', () => {
    it('returns unrecognized for valid JSON with no suites key', () => {
      expect(dispatchReport(JSON.stringify({ foo: 1 }))).toEqual({ ok: false, kind: 'unrecognized' });
    });

    it('returns unrecognized (not a crash) for JSON null', () => {
      // Kills the mutant that drops the `!== null` guard: `'suites' in null` throws.
      expect(dispatchReport('null')).toEqual({ ok: false, kind: 'unrecognized' });
    });

    it('returns unrecognized (not a crash) for a JSON number', () => {
      // Kills the mutant that drops the `typeof === 'object'` guard: `'suites' in 5` throws.
      expect(dispatchReport('5')).toEqual({ ok: false, kind: 'unrecognized' });
    });

    it('returns unrecognized (not a crash) for a JSON string', () => {
      expect(dispatchReport('"hello"')).toEqual({ ok: false, kind: 'unrecognized' });
    });

    it('returns unrecognized for a JSON array', () => {
      expect(dispatchReport('[1,2,3]')).toEqual({ ok: false, kind: 'unrecognized' });
    });

    it('returns unrecognized for a non-JSON, non-XML body', () => {
      expect(dispatchReport('just some text')).toEqual({ ok: false, kind: 'unrecognized' });
    });

    it('returns unrecognized for a whitespace-only body', () => {
      expect(dispatchReport('   ')).toEqual({ ok: false, kind: 'unrecognized' });
    });
  });

  describe('dispatchReport — malformed (detected format, bad content)', () => {
    it('reports malformed with the JUnit parser name for broken XML', () => {
      const result = dispatchReport('<not-a-real-junit-root/>');
      expect(result).toMatchObject({ ok: false, kind: 'malformed', parser: 'JUnit' });
      if (!result.ok && result.kind === 'malformed') expect(result.message.length).toBeGreaterThan(0);
    });

    it('reports malformed with the Playwright parser name for a suites body that fails validation', () => {
      // Detected (has `suites`) but no `config` → parsePlaywrightReport throws.
      const result = dispatchReport(JSON.stringify({ suites: [] }));
      expect(result).toMatchObject({ ok: false, kind: 'malformed', parser: 'Playwright' });
    });
  });

  describe('dispatchReport — loop control & extensibility (injected parser list)', () => {
    it('dispatches to a caller-supplied parser with no change to dispatchReport', () => {
      const result = dispatchReport('anything', [stub('Stub', true)]);
      expect(result).toEqual({ ok: true, parser: 'Stub', report: FAKE_REPORT });
    });

    it('picks the first parser whose detect returns true', () => {
      const result = dispatchReport('anything', [stub('First', true), stub('Second', true)]);
      expect(result).toMatchObject({ ok: true, parser: 'First' });
    });

    it('skips a non-matching parser and falls through to the next', () => {
      // Kills a mutant that returns/breaks after the first non-match.
      const result = dispatchReport('anything', [stub('No', false), stub('Yes', true)]);
      expect(result).toMatchObject({ ok: true, parser: 'Yes' });
    });

    it('returns unrecognized when no parser in the list detects', () => {
      expect(dispatchReport('anything', [stub('No', false)])).toEqual({ ok: false, kind: 'unrecognized' });
    });

    it('uses the thrown Error message on the malformed path', () => {
      const thrower: ReportParser = { name: 'Boom', detect: () => true, parse: () => { throw new Error('kaboom'); } };
      expect(dispatchReport('x', [thrower])).toEqual({ ok: false, kind: 'malformed', parser: 'Boom', message: 'kaboom' });
    });

    it('falls back to "Unknown error" when a parser throws a non-Error', () => {
      // Kills the `instanceof Error ? … : 'Unknown error'` ternary.
      const thrower: ReportParser = { name: 'Boom', detect: () => true, parse: () => { throw 'a string'; } };
      expect(dispatchReport('x', [thrower])).toEqual({ ok: false, kind: 'malformed', parser: 'Boom', message: 'Unknown error' });
    });
  });
});
