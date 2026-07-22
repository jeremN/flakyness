# ReportParser Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the binary `<`-sniff in `routes/reports.ts` with a `ReportParser` registry that dispatches report ingestion by detected shape, so a future framework parser is one module plus one array entry — zero dispatch edits.

**Architecture:** Extract the format-neutral output types into their own module, introduce a `ReportParser { name; detect; parse }` interface with a `REPORT_PARSERS` array and a Hono-agnostic `dispatchReport(body)` that returns a discriminated result, then rewire the ingest route to delegate to it. Behavior-preserving for JUnit + Playwright; the only intended change is that an unrecognized body returns `"Unrecognized report format"` instead of `"Invalid JSON body"`.

**Tech Stack:** TypeScript 7 (`apps/api`), Hono, Zod, Vitest, fast-xml-parser. Spec: `docs/superpowers/specs/2026-07-22-report-parser-registry-design.md`.

## Global Constraints

- **Behavior-preserving for JUnit + Playwright.** Every currently-accepted valid report ingests to the identical `ParsedReport`. A malformed body of a *detected* format still returns a byte-identical 400: exactly `Failed to parse JUnit report: <msg>` or `Failed to parse Playwright report: <msg>` (the parser `name` values are `'JUnit'` and `'Playwright'` — display casing).
- **The one intended behavior delta:** a body that is neither XML-ish (`trimStart().startsWith('<')`) nor valid JSON-with-a-`suites`-key returns **400 `{ "error": "Unrecognized report format" }`** (previously `"Invalid JSON body"` or `"Failed to parse Playwright report: …"`). Status stays 400; `reportParseFailuresTotal` still increments.
- **No new format parsers.** Refactor + coverage only; Cypress/Jest are out of scope.
- **Registry stays Hono-agnostic** — `dispatchReport` takes a `string`, returns a plain object, imports nothing from `hono`. Unit-testable without a request context.
- Structured logger (`middleware/logger.ts`), never `console.log`. Parsers already zod-validate; do not weaken that.
- Existing suites stay green: `pnpm --filter api exec tsc --noEmit` (0 errors), API route suites (self-skip without `DATABASE_URL` + `ADMIN_TOKEN`), `pnpm lint` (oxlint) clean.
- `docs/API.md` ingest section updated for the recognized-formats + unrecognized-400 contract.
- Commits: single-line conventional-commit subject, **NO `Co-Authored-By` trailer**, never `--no-verify`. `main` is branch-protected — work stays on `feat/report-parser-registry`; PR needs green CI + explicit user approval.

---

### Task 1: Extract format-neutral types into `parsers/types.ts`

Pure type relocation. `ParsedReport`, `ParsedTestResult`, `FailureDetail` currently live in `playwright.ts`, which `junit.ts` and `db/schema.ts` reach into. Move them to a neutral module and repoint all importers. No runtime behavior changes — the existing parser and route suites are the regression guard (there is no new failing test to write for a pure move; the discipline here is "existing tests stay green after the move").

**Files:**
- Create: `apps/api/src/parsers/types.ts`
- Modify: `apps/api/src/parsers/playwright.ts` (remove the 3 interface defs at lines 162-198; add a type import)
- Modify: `apps/api/src/parsers/junit.ts:3` (repoint import)
- Modify: `apps/api/src/db/schema.ts:2` (repoint import)
- Modify: `apps/api/src/routes/reports.ts:4` (repoint the `ParsedReport` type import; keep the value import)

**Interfaces:**
- Produces: module `./types` exporting `interface ParsedReport`, `interface ParsedTestResult`, `interface FailureDetail` (shapes unchanged — see Step 1 code). All later tasks and existing importers consume these from `../parsers/types` / `./types`.

- [ ] **Step 1: Create `apps/api/src/parsers/types.ts`** with the three interfaces moved verbatim (including the `FailureDetail` doc comment):

```ts
// Format-neutral parsed-report contract. Every report parser (Playwright,
// JUnit, and any future framework) produces this shape; the DB layer and the
// ingest route consume it. Kept parser-agnostic so no parser imports another.

/** Parsed test result for our database. */
export interface ParsedTestResult {
  testName: string;
  testFile: string;
  status: 'passed' | 'failed' | 'skipped' | 'flaky';
  durationMs: number;
  retryCount: number;
  errorMessage: string | null;
  tags: string[];
  annotations: { type: string; description?: string }[];
  failureDetail: FailureDetail | null;
}

/**
 * Richer per-run failure detail, alongside (not replacing) `errorMessage`.
 *
 * Attachments are METADATA ONLY — `{ name, contentType, path }`. The base64
 * `body` field (screenshots/videos/traces) is never copied through; that is
 * a hard guarantee, not a size-tuning choice — see plan 037.
 */
export interface FailureDetail {
  errors: Array<{ message?: string; stack?: string; snippet?: string; value?: string }>;
  stdout?: string;
  stderr?: string;
  attachments?: Array<{ name: string; contentType: string; path?: string }>;
}

export interface ParsedReport {
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number;
  results: ParsedTestResult[];
}
```

- [ ] **Step 2: Remove the moved defs from `playwright.ts` and import them instead.** Delete the three `export interface` blocks (`ParsedTestResult` 162-172, `FailureDetail` 174-186, `ParsedReport` 188-198, including their comments). Add, directly under the existing `import { z } from 'zod';` (line 1):

```ts
import type { FailureDetail, ParsedReport, ParsedTestResult } from './types';
```

`playwright.ts` still references all three internally (`extractFailureDetail` returns `FailureDetail | null`; `parsePlaywrightReport` returns `ParsedReport`; `parsedResults: ParsedTestResult[]`), so all three imports are used.

- [ ] **Step 3: Repoint the other three importers.**

`apps/api/src/parsers/junit.ts:3` — change:
```ts
import type { ParsedReport, ParsedTestResult } from './playwright';
```
to:
```ts
import type { ParsedReport, ParsedTestResult } from './types';
```

`apps/api/src/db/schema.ts:2` — change:
```ts
import type { FailureDetail } from '../parsers/playwright';
```
to:
```ts
import type { FailureDetail } from '../parsers/types';
```

`apps/api/src/routes/reports.ts:4` — split the mixed import so the value import stays on `playwright` and the type moves to `types`:
```ts
import { parsePlaywrightReport } from '../parsers/playwright';
import type { ParsedReport } from '../parsers/types';
```
(Task 3 removes the `ParsedReport` import entirely once the route no longer annotates `parsed`; here we only keep the tree compiling.)

- [ ] **Step 4: Typecheck — expect 0 errors.**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: no output, exit 0. A `Cannot find name 'FailureDetail'` here means a `playwright.ts` internal reference was left without the new import (Step 2).

- [ ] **Step 5: Run the parser + route suites to prove the move is behavior-preserving.**

Run: `rtk proxy pnpm --filter api exec vitest run src/parsers src/routes/reports.test.ts`
Expected: all parser tests pass; `reports.test.ts` DB-backed cases self-skip without `DATABASE_URL`/`ADMIN_TOKEN` (that is fine for this task — no behavior changed). No new failures vs. before the move.

- [ ] **Step 6: Lint.**

Run: `pnpm lint`
Expected: oxlint clean (0 warnings/errors on the touched files).

- [ ] **Step 7: Commit.**

```bash
git add apps/api/src/parsers/types.ts apps/api/src/parsers/playwright.ts apps/api/src/parsers/junit.ts apps/api/src/db/schema.ts apps/api/src/routes/reports.ts
git commit -m "refactor(parsers): extract neutral ParsedReport types into types.ts"
```

---

### Task 2: `ReportParser` interface + registry + tests

Introduce the registry that dispatches by shape. This is the core of the change and carries its own unit tests (no DB needed — pure functions, so the suite always runs). Tests are written to the mutation-quality standard: each asserts a behavior a mutant would break (the `typeof`/`!== null`/`in` guards, first-match-wins, the malformed-catch ternary, the array-injection extensibility path).

**Files:**
- Create: `apps/api/src/parsers/registry.ts`
- Test: `apps/api/src/parsers/registry.test.ts`

**Interfaces:**
- Consumes: `parseJUnitReport` (`./junit`), `parsePlaywrightReport` (`./playwright`), `ParsedReport` (`./types`).
- Produces:
  - `interface ReportParser { name: string; detect(body: string): boolean; parse(body: string): ParsedReport; }`
  - `const REPORT_PARSERS: ReportParser[]` (order: `[junitParser, playwrightParser]`)
  - `type DispatchResult = { ok: true; parser: string; report: ParsedReport } | { ok: false; kind: 'malformed'; parser: string; message: string } | { ok: false; kind: 'unrecognized' }`
  - `function dispatchReport(body: string, parsers?: ReportParser[]): DispatchResult` (defaults `parsers` to `REPORT_PARSERS`)

- [ ] **Step 1: Write the failing test `apps/api/src/parsers/registry.test.ts`:**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `rtk proxy pnpm --filter api exec vitest run src/parsers/registry.test.ts`
Expected: FAIL — `Cannot find module './registry'` (module not created yet).

- [ ] **Step 3: Create `apps/api/src/parsers/registry.ts`:**

```ts
import { parseJUnitReport } from './junit';
import { parsePlaywrightReport } from './playwright';
import type { ParsedReport } from './types';

/**
 * A report parser recognizes one CI report format and parses it into the
 * neutral `ParsedReport` shape. Adding a framework = implement this interface
 * and append to `REPORT_PARSERS` — the ingest route never changes.
 */
export interface ReportParser {
  /** Display name; used verbatim in the "Failed to parse <name> report" 400. */
  name: string;
  /** Cheap, loose shape check on the raw request body. Must not throw. */
  detect(body: string): boolean;
  /** Strict parse; throws on malformed input of this format. */
  parse(body: string): ParsedReport;
}

// `name` carries the display casing used in the 400 message, so the malformed
// path stays byte-identical to the pre-registry route.
const junitParser: ReportParser = {
  name: 'JUnit',
  detect: (body) => body.trimStart().startsWith('<'),
  parse: (body) => parseJUnitReport(body),
};

const playwrightParser: ReportParser = {
  name: 'Playwright',
  detect: (body) => {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return false;
    }
    return typeof json === 'object' && json !== null && 'suites' in json;
  },
  parse: (body) => parsePlaywrightReport(JSON.parse(body)),
};

export const REPORT_PARSERS: ReportParser[] = [junitParser, playwrightParser];

export type DispatchResult =
  | { ok: true; parser: string; report: ParsedReport }
  | { ok: false; kind: 'malformed'; parser: string; message: string }
  | { ok: false; kind: 'unrecognized' };

/**
 * Find the first parser that recognizes `body` and parse it. A recognized but
 * malformed body yields `{ malformed }`; a body no parser recognizes yields
 * `{ unrecognized }`. Hono-agnostic — the route maps the result to a response.
 */
export function dispatchReport(
  body: string,
  parsers: ReportParser[] = REPORT_PARSERS
): DispatchResult {
  for (const parser of parsers) {
    if (!parser.detect(body)) continue;
    try {
      return { ok: true, parser: parser.name, report: parser.parse(body) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { ok: false, kind: 'malformed', parser: parser.name, message };
    }
  }
  return { ok: false, kind: 'unrecognized' };
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `rtk proxy pnpm --filter api exec vitest run src/parsers/registry.test.ts`
Expected: PASS — all registry tests green.

- [ ] **Step 5: Typecheck + lint.**

Run: `pnpm --filter api exec tsc --noEmit && pnpm lint`
Expected: 0 type errors, oxlint clean.

- [ ] **Step 6: Commit.**

```bash
git add apps/api/src/parsers/registry.ts apps/api/src/parsers/registry.test.ts
git commit -m "feat(parsers): add ReportParser registry with shape dispatch"
```

---

### Task 3: Rewire the ingest route + update the route test + docs

Delegate `routes/reports.ts` to `dispatchReport`, deleting the inline `<`-sniff. Update the one route test whose assertion the intended delta changes, add a test for the new unrecognized-JSON path, and update `docs/API.md`.

**Files:**
- Modify: `apps/api/src/routes/reports.ts` (replace lines ~104-131; drop the now-unused imports)
- Modify: `apps/api/src/routes/reports.test.ts` (update the `468-476` assertion; add an unrecognized-JSON test)
- Modify: `docs/API.md` (ingest section)

**Interfaces:**
- Consumes: `dispatchReport` from `../parsers/registry` (Task 2).

- [ ] **Step 1: Rewrite the dispatch block in `apps/api/src/routes/reports.ts`.** Replace the whole block from `const bodyText = await c.req.text();` through the closing `}` of the `else` branch (current lines 104-131) with:

```ts
    // Read the body once as text, then dispatch by content shape — not
    // Content-Type, since CI uploaders can send an inaccurate header. The
    // parser registry recognizes JUnit XML and Playwright JSON; a body no
    // parser recognizes is rejected as unrecognized.
    const bodyText = await c.req.text();
    const dispatched = dispatchReport(bodyText);
    if (!dispatched.ok) {
      reportParseFailuresTotal.inc();
      if (dispatched.kind === 'unrecognized') {
        return c.json({ error: 'Unrecognized report format' }, 400);
      }
      return c.json({ error: `Failed to parse ${dispatched.parser} report: ${dispatched.message}` }, 400);
    }
    const parsed = dispatched.report;
```

- [ ] **Step 2: Fix the imports in `reports.ts`.** The route no longer calls the parser functions or annotates `ParsedReport` directly. Replace the two parser imports (current lines 4-5) and the `ParsedReport` type import added in Task 1:

```ts
import { parsePlaywrightReport } from '../parsers/playwright';
import type { ParsedReport } from '../parsers/types';
import { parseJUnitReport } from '../parsers/junit';
```
with a single:
```ts
import { dispatchReport } from '../parsers/registry';
```
Leave the `reportParseFailuresTotal` import untouched. (If tsc later flags any other now-unused import, remove it.)

- [ ] **Step 3: Typecheck — expect 0 errors, no unused-symbol complaints.**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: exit 0. An "is declared but never read" error means a stale parser import survived Step 2.

- [ ] **Step 4: Update the changed assertion in `apps/api/src/routes/reports.test.ts`.** The whitespace-only-body test (currently lines 468-476) asserts the old `"Invalid JSON body"`. Change its final assertion:

```ts
      expect(body.error).toBe('Invalid JSON body');
```
to:
```ts
      expect(body.error).toBe('Unrecognized report format');
```

- [ ] **Step 5: Add an unrecognized-JSON route test** next to the whitespace-only test in the same `describe` block (valid JSON, no `suites` key → 400 unrecognized — this body used to reach the Playwright parser and 400 as "Failed to parse Playwright report"):

```ts
    it('should reject valid JSON with no recognizable report shape as 400 unrecognized', async () => {
      const res = await app.request('/api/v1/reports?branch=main&commit=junk', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testProjectToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ hello: 'world' }),
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe('Unrecognized report format');
    });
```

- [ ] **Step 6: Run the route suite against a disposable Postgres** (these tests need `DATABASE_URL` + `ADMIN_TOKEN`; without them they self-skip and prove nothing). Start throwaway Postgres, migrate, run, tear down:

```bash
docker run -d --name pg-050 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=flackyness -p 55432:5432 postgres:17
# wait for readiness, then:
export DATABASE_URL="postgres://postgres:pw@localhost:55432/flackyness"
export ADMIN_TOKEN="test-admin-token"
touch .env
pnpm db:migrate
rtk proxy pnpm --filter api exec vitest run src/routes/reports.test.ts
docker rm -f pg-050
```
Expected: the reports route suite passes, including the updated whitespace-only test and the new unrecognized-JSON test. `docker rm -f pg-050` runs even if the suite fails (tear down before diagnosing).

- [ ] **Step 7: Run the full API + parser suite** to confirm nothing else regressed (registry + parser tests are DB-free and always run):

```bash
rtk proxy pnpm --filter api exec vitest run
```
Expected: green (route suites self-skip if you have already torn down Postgres — re-export `DATABASE_URL` for a full run, or rely on Step 6 for the DB-backed proof).

- [ ] **Step 8: Update `docs/API.md`.** In the `POST /api/v1/reports` ingest section, state that the body is dispatched by shape to a recognized report format — **JUnit XML** (body starts with `<`) or **Playwright JSON** (a JSON object with a `suites` key) — and that a body matching no recognized format returns `400 { "error": "Unrecognized report format" }`. Keep the existing malformed-format wording (`Failed to parse <format> report: …`). Match the surrounding doc style (heading level, table/prose format already used for that endpoint).

- [ ] **Step 9: Lint.**

Run: `pnpm lint`
Expected: oxlint clean.

- [ ] **Step 10: Commit.**

```bash
git add apps/api/src/routes/reports.ts apps/api/src/routes/reports.test.ts docs/API.md
git commit -m "refactor(reports): dispatch ingestion through the parser registry"
```

---

## Self-Review

- **Spec coverage:** types.ts (Task 1) ↔ success criterion 1; registry + dispatch + extensibility test (Task 2) ↔ criteria 2 & 3; route delegation + preserved metric/messages + docs (Task 3) ↔ criteria 4 & 5. All five covered.
- **Type consistency:** `dispatchReport(body, parsers?)`, `DispatchResult` union field names (`ok`/`parser`/`report`/`kind`/`message`), and `ReportParser { name; detect; parse }` are identical between the Task 2 interface block, the Task 2 implementation, and the Task 3 route usage (`dispatched.ok` / `dispatched.kind` / `dispatched.parser` / `dispatched.message` / `dispatched.report`). Parser `name` values `'JUnit'`/`'Playwright'` match the Global-Constraints message-casing requirement.
- **Placeholder scan:** every code step carries complete code; the only prose-described step is the `docs/API.md` copy edit (Step 8), which is documentation, not logic.
- **Behavior-preservation risk:** the sole intended delta (unrecognized → `"Unrecognized report format"`) is pinned by both the updated Task 3 Step 4 assertion and the new Step 5 test; malformed-format 400s stay byte-identical via the display-cased `name`.
