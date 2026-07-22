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
