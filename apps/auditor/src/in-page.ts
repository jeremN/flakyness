/**
 * Code that runs INSIDE the audited page, kept as plain-JS strings on purpose.
 *
 * Passing a TypeScript function to `page.evaluate` / `addInitScript` ships
 * whatever the transpiler emitted — and tsx/esbuild's `keepNames` wraps named
 * functions in a `__name(...)` helper that does not exist in the page, so the
 * call dies with "ReferenceError: __name is not defined" (measured on the
 * first run of this package). Strings are immune to that. Keep these small,
 * ES2020, dependency-free, and collect raw facts only: every judgement lives
 * in Node (perf.ts / seo.ts) where it is unit-tested.
 */

/**
 * Installed before the page's own scripts. Buffers LCP, layout shifts
 * (excluding input-driven ones) and long tasks into `window.__fkPerf`.
 * An unsupported entry type is skipped, so its metric reads as missing — never 0.
 */
export const PERF_OBSERVERS_SCRIPT = `(() => {
  // shifts/longTasks stay NULL until their observer is actually registered:
  // an empty array would read as "measured, nothing happened" = a perfect 0.
  const store = { lcp: undefined, shifts: null, longTasks: null };
  window.__fkPerf = store;
  const observe = (type, cb) => {
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) cb(e); })
        .observe({ type, buffered: true });
      return true;
    } catch (e) {
      return false; /* unsupported entry type */
    }
  };
  observe('largest-contentful-paint', (e) => { store.lcp = e.renderTime || e.startTime; });
  const shifts = [];
  if (observe('layout-shift', (e) => { if (!e.hadRecentInput) shifts.push([e.startTime, e.value]); })) {
    store.shifts = shifts;
  }
  const longTasks = [];
  if (observe('longtask', (e) => { longTasks.push([e.startTime, e.duration]); })) {
    store.longTasks = longTasks;
  }
})();`;

/** Evaluates to `{ lcp, fcp, ttfb, shifts, longTasks }` (see browser.ts RawPerf); null = not observed. */
export const READ_PERF_EXPRESSION = `(() => {
  const store = window.__fkPerf || { lcp: undefined, shifts: null, longTasks: null };
  const paint = performance.getEntriesByName('first-contentful-paint')[0];
  const nav = performance.getEntriesByType('navigation')[0];
  return {
    lcp: store.lcp,
    fcp: paint ? paint.startTime : undefined,
    ttfb: nav ? nav.responseStart : undefined,
    shifts: store.shifts,
    longTasks: store.longTasks,
  };
})()`;

/** Evaluates to the DOM half of a SeoSnapshot (status/headers are added in Node). */
export const READ_SEO_EXPRESSION = `(() => {
  const meta = (name) => {
    const el = Array.from(document.querySelectorAll('meta[name]'))
      .find((m) => (m.getAttribute('name') || '').toLowerCase() === name);
    return el ? el.getAttribute('content') : null;
  };
  const links = (rel) => Array.from(document.querySelectorAll('link[rel]'))
    .filter((l) => (l.getAttribute('rel') || '').toLowerCase().split(/\\s+/).includes(rel));
  return {
    url: location.href,
    title: document.title || null,
    metaDescription: meta('description'),
    metaRobots: meta('robots'),
    viewport: meta('viewport'),
    htmlLang: document.documentElement.getAttribute('lang'),
    h1Count: document.querySelectorAll('h1').length,
    canonicals: links('canonical').map((l) => l.href),
    hreflangs: links('alternate')
      .filter((l) => l.hasAttribute('hreflang'))
      .map((l) => ({ lang: l.getAttribute('hreflang') || '', raw: l.getAttribute('href') || '', resolved: l.href })),
    jsonLd: Array.from(document.querySelectorAll('script[type]'))
      .filter((s) => (s.getAttribute('type') || '').toLowerCase() === 'application/ld+json')
      .map((s) => {
        try {
          const parsed = JSON.parse(s.textContent || '');
          const nodes = Array.isArray(parsed) ? parsed : (parsed && parsed['@graph']) || [parsed];
          const types = nodes
            .flatMap((n) => (n && Array.isArray(n['@type']) ? n['@type'] : [n && n['@type']]))
            .filter((t) => typeof t === 'string');
          return { valid: true, types };
        } catch (e) {
          return { valid: false, types: [] };
        }
      }),
  };
})()`;
