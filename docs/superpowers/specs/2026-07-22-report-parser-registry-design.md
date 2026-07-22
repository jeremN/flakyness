# `ReportParser` registry — dispatch report ingestion by shape (design)

**Status:** approved 2026-07-22. Implements **roadmap #1** in `docs/STRATEGY.md`.
Base `ea89f23` (main). Plan lands as `plans/050-*`.

## Purpose

Report ingestion currently dispatches by a **binary content sniff** in
`routes/reports.ts`: a body that (after leading whitespace) starts with `<` is
parsed as JUnit XML; **everything else is fed to `parsePlaywrightReport`
unconditionally**. That `else` is a trap — a second JSON format (Cypress, Jest,
…) has no discriminant, so adding one forces *replacing* the dispatch, and doing
it at the 4th parser also pays for regressions in the first three. Per the
STRATEGY doc this is the only roadmap item whose cost strictly grows with time.

This change replaces the binary sniff with a **`ReportParser` registry that
dispatches by detected shape**, and extracts the format-neutral output types into
their own module. It is the enabling refactor behind the product's "add a
framework in 2-3 days" line: after it, a new parser is one module implementing an
interface plus one line appending it to the registry — no dispatch edits.

It is **behavior-preserving** for the two shipped formats. It does **not** add any
new parser (Cypress/Jest are the separate "modules par framework" roadmap line).

## Decisions (locked)

1. **Strict detection + explicit 400 on no-match.** Each parser declares a real
   discriminant (JUnit: XML root; Playwright: a JSON object with a `suites` key).
   A body no parser detects returns **400 "Unrecognized report format"** — it is
   never silently routed to Playwright. This is the actual fix; a future
   Cypress/Jest parser gets its own discriminant instead of being swallowed.
   (This is a behavior change only on the *unknown-format* path: today an unknown
   JSON is fed to Playwright and 400s as "Failed to parse Playwright report"; it
   still 400s, now with a clearer message.)
2. **Detection is loose; parsing is strict.** `detect(body)` answers only "does
   this look like format X?" — cheap, permissive. `parse(body)` does the full
   zod validation and throws on malformed. So a body detected as Playwright but
   malformed still 400s as "Failed to parse Playwright report" (recognized
   format, bad content); only a body no parser recognizes is "Unrecognized".
   The Playwright discriminant is `'suites' in obj` — `PlaywrightReportSchema`
   already requires `suites` (and `config`), and `suites` is the Playwright-
   specific signature key that Cypress/Jest JSON does not use, so every real
   report passes while the parser is no longer the catch-all.
3. **Separate `detect` / `parse` methods** (not a fused `tryParse`). Keeps the
   discriminant explicit and independently testable (the roadmap's "dispatch par
   forme"). JSON parsers `JSON.parse` in both `detect` and `parse`; the double
   parse is negligible at ingest frequency (bodies are already size-capped) and
   buys a much clearer interface. (Considered and rejected: a fused
   `tryParse(body): ParsedReport | null` — single parse, but it mixes recognition
   and parsing and hides the discriminant.)
4. **Format-neutral types module.** `ParsedReport` / `ParsedTestResult` /
   `FailureDetail` move out of `playwright.ts` (where `junit.ts` currently reaches
   in to import them) into `apps/api/src/parsers/types.ts`. Both parsers and the
   registry import from there. No shape change to those types.
5. **The route stays thin; the registry is Hono-agnostic.** `dispatchReport`
   returns a plain discriminated result; `routes/reports.ts` maps it to responses
   (and increments `reportParseFailuresTotal` on both failure kinds). The registry
   has no dependency on Hono, so it is unit-testable without a request context.

## Approach

A single implementation plan, executed subagent-driven. Shape:
**extract neutral types → introduce registry (interface + parsers + dispatch) →
rewire the route → tests + docs**, behavior-preserving for JUnit/Playwright.

## Components

### `apps/api/src/parsers/types.ts` (new)
The format-neutral output contract, moved verbatim from `playwright.ts`:
`ParsedReport`, `ParsedTestResult`, `FailureDetail`. `playwright.ts` and
`junit.ts` re-import these from here (re-export from `playwright.ts` if needed to
avoid churning external importers — but prefer updating imports).

### `apps/api/src/parsers/registry.ts` (new)
```ts
import type { ParsedReport } from './types';

export interface ReportParser {
  /** Stable id used in error messages and metrics labels. */
  name: string;
  /** Cheap, loose shape check on the raw request body. */
  detect(body: string): boolean;
  /** Strict parse; throws on malformed input of this format. */
  parse(body: string): ParsedReport;
}

// `name` carries the DISPLAY casing used in the 400 message, so the malformed
// path stays byte-identical to today ("Failed to parse JUnit report: …").
const junitParser: ReportParser = {
  name: 'JUnit',
  detect: (body) => body.trimStart().startsWith('<'),
  parse: (body) => parseJUnitReport(body),
};

const playwrightParser: ReportParser = {
  name: 'Playwright',
  detect: (body) => {
    let json: unknown;
    try { json = JSON.parse(body); } catch { return false; }
    return typeof json === 'object' && json !== null && 'suites' in json;
  },
  parse: (body) => parsePlaywrightReport(JSON.parse(body)),
};

export const REPORT_PARSERS: ReportParser[] = [junitParser, playwrightParser];

export type DispatchResult =
  | { ok: true; parser: string; report: ParsedReport }
  | { ok: false; kind: 'malformed'; parser: string; message: string }
  | { ok: false; kind: 'unrecognized' };

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
(`parse` for Playwright `JSON.parse`s again; since `detect` already proved it
parses, the throw path there is unreachable for a detected body — the strict
zod error surfaces from `parsePlaywrightReport` instead.)

### `apps/api/src/routes/reports.ts` (modify)
Replace the `if (startsWith('<')) … else …` block (~104-131) with:
```ts
const bodyText = await c.req.text();
const result = dispatchReport(bodyText);
if (!result.ok) {
  reportParseFailuresTotal.inc();
  if (result.kind === 'unrecognized') {
    return c.json({ error: 'Unrecognized report format' }, 400);
  }
  return c.json({ error: `Failed to parse ${result.parser} report: ${result.message}` }, 400);
}
const parsed = result.report;
// …unchanged downstream (transaction insert, updateFlakyTests, etc.)
```
Preserves: read-body-once, `reportParseFailuresTotal.inc()` on every failure, and
a **byte-identical** format-named 400 for malformed input of a detected format
(`name` holds the display casing — "Failed to parse JUnit report: …" / "Failed to
parse Playwright report: …").

**The single intended message delta:** the prior standalone `'Invalid JSON body'`
400 (body that is not XML-ish and not valid JSON) folds into the unrecognized
path → **`'Unrecognized report format'`**. This is a deliberate consequence of the
approved strict-detection model (Decision 1), not an accident: without a
discriminant we cannot claim a broken `{…` body "should have been" Playwright.
Trade-off accepted: a client sending malformed JSON now gets "Unrecognized report
format" instead of the more specific "Invalid JSON body" — status stays 400,
metric still increments. `reports.test.ts:475` (`expect(body.error).toBe('Invalid
JSON body')`) is the one existing assertion this changes; the plan updates it to
the new message.

## Testing

- **`registry.test.ts` (new):** `detect` routing (XML → junit; `{"suites":…}`
  JSON → playwright; `{"foo":1}` JSON → no parser detects; non-JSON non-XML → no
  detect). `dispatchReport` outcomes: `ok` for a valid JUnit + a valid Playwright
  fixture; `unrecognized` for unknown JSON and for random text; `malformed` for a
  `<…` body that fails JUnit parse and for a `{"suites":…}` body that fails
  Playwright validation. **Extensibility proof:** a throwaway 3rd `ReportParser`
  passed into `dispatchReport(body, [...])` is dispatched with no change to
  `dispatchReport` — locks the "new parser = register only" guarantee.
- **`reports.test.ts` (modify):** the ingest route returns 400 "Unrecognized
  report format" for a `{}`-style unknown body; still 201 for valid JUnit and
  Playwright bodies; still 400 "Failed to parse JUnit report: …" / "Failed to
  parse Playwright report: …" (exact strings) for a malformed body of a detected
  format. `reportParseFailuresTotal` increments on the unrecognized path. Update
  the existing line 475 assertion (`toBe('Invalid JSON body')`) to the new
  `'Unrecognized report format'` message (the one intended delta).
- Existing `junit.test.ts` / `playwright.test.ts` (which test `parse`) are
  unchanged and stay green.

## Constraints (non-negotiables)

- **Behavior-preserving for JUnit + Playwright.** Every currently-accepted valid
  report still ingests to the identical `ParsedReport`. The only intended
  behavior change is the unknown-format 400 message/path (Decision 1).
- **No new format parsers.** Coverage/refactor only; Cypress/Jest are out of scope.
- **Registry stays Hono-agnostic** (unit-testable without a request context).
- Structured logger, never `console.log`; zod-validate inputs (unchanged — the
  parsers already do). Existing suites stay green (API 362+, dashboard 89,
  `check` 0-err, oxlint clean). `docs/API.md` ingest section updated for the
  recognized-formats + unrecognized-400 contract.
- Commits: single-line conventional subject, **no `Co-Authored-By`** trailer.
  `main` is branch-protected — PR needs green CI + explicit user approval.

## Success criteria

1. `ParsedReport`/`ParsedTestResult`/`FailureDetail` live in a neutral
   `parsers/types.ts`; `junit.ts`, `playwright.ts`, and the registry import them
   from there; no type shape changed.
2. A `ReportParser` registry dispatches ingestion by `detect`; JUnit and
   Playwright route exactly as before for valid input; an unrecognized body
   returns 400 "Unrecognized report format" (never a silent Playwright attempt).
3. Adding a parser is demonstrably "implement `ReportParser` + append to
   `REPORT_PARSERS`" — proven by the extensibility test, with zero `dispatchReport`
   edits.
4. `routes/reports.ts` delegates to `dispatchReport`; failure metrics and
   format-named 400s preserved; the route carries no format-detection logic.
5. Existing suites green; new `registry.test.ts` + updated `reports.test.ts`;
   `docs/API.md` updated.
