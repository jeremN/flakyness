import type { Check, Issue, Severity } from './types';

/**
 * On-page SEO checks over a snapshot extracted from the rendered DOM.
 *
 * Deliberately a pure function of the snapshot: the browser part
 * (browser.ts) only collects facts, every judgement lives here and is unit-
 * tested without a browser. Check ids are stable — they are what regression
 * detection keys on — so renaming one is a breaking change for stored history.
 */

export interface SeoSnapshot {
  /** Final URL after redirects. */
  url: string;
  /** HTTP status of the main document, null if unknown. */
  status: number | null;
  /** `X-Robots-Tag` response header, if any. */
  xRobotsTag: string | null;
  title: string | null;
  metaDescription: string | null;
  metaRobots: string | null;
  viewport: string | null;
  htmlLang: string | null;
  h1Count: number;
  /** Absolute hrefs of every <link rel="canonical">, as the browser resolved them. */
  canonicals: string[];
  /** `raw` is the attribute as written; `resolved` is the absolute URL. */
  hreflangs: Array<{ lang: string; raw: string; resolved: string }>;
  /** One entry per <script type="application/ld+json">. */
  jsonLd: Array<{ valid: boolean; types: string[] }>;
}

export interface SeoOptions {
  /**
   * When set, every canonical must live on this origin (e.g.
   * "https://www.example.com"). Catches staging/preview canonicals leaking into
   * production, and production pages canonicalised to the wrong host.
   */
  canonicalOrigin?: string;
}

/** A check that ran. `issue` is set when it failed. */
interface Rule {
  id: string;
  weight: number;
  issue?: Omit<Issue, 'id'>;
}

const WEIGHT: Record<Severity, number> = { critical: 10, serious: 5, moderate: 3, minor: 1, info: 0 };

// Robots directives that take a value after a colon. Anything else before a
// colon is a user-agent prefix (X-Robots-Tag: "googlebot: noindex").
const VALUE_DIRECTIVES = new Set(['max-snippet', 'max-image-preview', 'max-video-preview', 'unavailable_after']);

// BCP 47-ish, as accepted by search engines for hreflang: language, optional
// script, optional region; or the literal x-default.
const HREFLANG_CODE = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;

function rule(id: string, severity: Severity, failed: boolean, message: string): Rule {
  return { id, weight: WEIGHT[severity], ...(failed ? { issue: { severity, message } } : {}) };
}

function normalizeUrl(u: string): string {
  try {
    const parsed = new URL(u);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return u;
  }
}

export function evaluateSeo(s: SeoSnapshot, options: SeoOptions = {}): Check {
  const rules: Rule[] = [];

  // --- Indexability ---------------------------------------------------------
  const okStatus = s.status !== null && s.status >= 200 && s.status < 300;
  rules.push(
    rule('http-status', 'critical', !okStatus, `Document returned HTTP ${s.status ?? 'unknown'} (expected 2xx)`)
  );

  // Whole directives only: a word-boundary regex would read the `none` in
  // `max-image-preview:none` as the `none` (= noindex, nofollow) directive.
  // X-Robots-Tag may carry a user-agent prefix ("googlebot: noindex"), which
  // is syntactically identical to a value-taking directive — so the known
  // value-taking directives are excluded from prefix stripping by name.
  const directives = `${s.metaRobots ?? ''},${s.xRobotsTag ?? ''}`
    .toLowerCase()
    .split(',')
    .map((d) => {
      const trimmed = d.trim();
      const m = /^([a-z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed);
      return m && !VALUE_DIRECTIVES.has(m[1]) ? m[2] : trimmed;
    });
  rules.push(
    rule(
      'noindex',
      'serious',
      directives.some((d) => d === 'noindex' || d === 'none'),
      `Page is excluded from indexing (${[s.metaRobots && `meta robots "${s.metaRobots}"`, s.xRobotsTag && `X-Robots-Tag "${s.xRobotsTag}"`].filter(Boolean).join(', ')})`
    )
  );

  // --- Canonical ------------------------------------------------------------
  const canonicals = [...new Set(s.canonicals.map(normalizeUrl))];
  rules.push(rule('canonical-missing', 'serious', canonicals.length === 0, 'No <link rel="canonical">'));
  if (canonicals.length > 0) {
    rules.push(
      rule(
        'canonical-multiple',
        'serious',
        canonicals.length > 1,
        `${canonicals.length} different canonicals — search engines ignore all of them: ${canonicals.join(', ')}`
      )
    );
    if (options.canonicalOrigin) {
      const expected = new URL(options.canonicalOrigin).origin;
      const foreign = canonicals.filter((c) => {
        try {
          return new URL(c).origin !== expected;
        } catch {
          return true;
        }
      });
      rules.push(
        rule(
          'canonical-wrong-origin',
          'serious',
          foreign.length > 0,
          `Canonical on the wrong origin (expected ${expected}): ${foreign.join(', ')}`
        )
      );
    }
    // Not a defect by itself (pagination, facets, duplicates are canonicalised
    // on purpose) — reported as info so it is visible without ever being a
    // regression or costing score.
    if (canonicals.length === 1 && canonicals[0] !== normalizeUrl(s.url)) {
      rules.push(rule('canonical-not-self', 'info', true, `Canonical points elsewhere: ${canonicals[0]}`));
    }
  }

  // --- Title & description ----------------------------------------------------
  const title = s.title?.trim() ?? '';
  rules.push(rule('title-missing', 'serious', title.length === 0, 'Missing or empty <title>'));
  if (title.length > 0) {
    rules.push(
      rule(
        'title-length',
        'minor',
        title.length < 10 || title.length > 60,
        `Title is ${title.length} characters (aim for 10–60): "${title.slice(0, 80)}"`
      )
    );
  }

  const description = s.metaDescription?.trim() ?? '';
  rules.push(
    rule('meta-description-missing', 'moderate', description.length === 0, 'Missing or empty meta description')
  );
  if (description.length > 0) {
    rules.push(
      rule(
        'meta-description-length',
        'minor',
        description.length < 50 || description.length > 160,
        `Meta description is ${description.length} characters (aim for 50–160)`
      )
    );
  }

  // --- Document structure -----------------------------------------------------
  rules.push(rule('h1-missing', 'moderate', s.h1Count === 0, 'No <h1> on the page'));
  if (s.h1Count > 0) {
    rules.push(rule('h1-multiple', 'minor', s.h1Count > 1, `${s.h1Count} <h1> elements on the page`));
  }
  rules.push(rule('html-lang-missing', 'moderate', !s.htmlLang?.trim(), 'Missing <html lang>'));
  rules.push(rule('viewport-missing', 'moderate', !s.viewport?.trim(), 'Missing <meta name="viewport">'));

  // --- hreflang (only judged when the page declares alternates) -----------------
  if (s.hreflangs.length > 0) {
    const badCodes = s.hreflangs.filter((h) => !HREFLANG_CODE.test(h.lang.trim()));
    rules.push(
      rule(
        'hreflang-invalid-code',
        'moderate',
        badCodes.length > 0,
        `Invalid hreflang code(s): ${badCodes.map((h) => `"${h.lang}"`).join(', ')}`
      )
    );
    const relative = s.hreflangs.filter((h) => !/^https?:\/\//i.test(h.raw.trim()));
    rules.push(
      rule(
        'hreflang-relative',
        'moderate',
        relative.length > 0,
        `hreflang URLs must be absolute: ${relative.map((h) => h.raw).join(', ')}`
      )
    );
    const self = new Set([normalizeUrl(s.url), ...canonicals]);
    rules.push(
      rule(
        'hreflang-no-self',
        'minor',
        !s.hreflangs.some((h) => self.has(normalizeUrl(h.resolved))),
        'hreflang set has no self-referencing entry'
      )
    );
  }

  // --- Structured data (only judged when present) -------------------------------
  if (s.jsonLd.length > 0) {
    const invalid = s.jsonLd.filter((j) => !j.valid).length;
    rules.push(
      rule('jsonld-invalid', 'serious', invalid > 0, `${invalid} JSON-LD block(s) are not valid JSON`)
    );
  }

  const total = rules.reduce((sum, r) => sum + r.weight, 0);
  const lost = rules.filter((r) => r.issue).reduce((sum, r) => sum + r.weight, 0);
  const score = total === 0 ? null : Math.round(((total - lost) / total) * 10_000) / 10_000;

  const issues: Issue[] = rules
    .filter((r): r is Rule & { issue: Omit<Issue, 'id'> } => r.issue !== undefined)
    .map((r) => ({ id: r.id, ...r.issue, message: r.issue.message.slice(0, 1000) }));

  return { category: 'seo', score, issues };
}
