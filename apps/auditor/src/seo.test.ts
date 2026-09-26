import { describe, it, expect } from 'vitest';
import { evaluateSeo, type SeoSnapshot } from './seo';

const URL_ = 'https://www.example.com/route';

function snapshot(overrides: Partial<SeoSnapshot> = {}): SeoSnapshot {
  return {
    url: URL_,
    status: 200,
    xRobotsTag: null,
    title: 'Plan your route — Example',
    metaDescription: 'Plan a route across Europe, compare itineraries and find places to stop on the way.',
    metaRobots: null,
    viewport: 'width=device-width, initial-scale=1',
    htmlLang: 'en',
    h1Count: 1,
    canonicals: [URL_],
    hreflangs: [],
    jsonLd: [],
    ...overrides,
  };
}

const ids = (s: SeoSnapshot, opts = {}) => evaluateSeo(s, opts).issues.map((i) => i.id);

describe('evaluateSeo', () => {
  it('passes a clean page with score 1 and no issues', () => {
    const check = evaluateSeo(snapshot());
    expect(check).toEqual({ category: 'seo', score: 1, issues: [] });
  });

  it.each([
    [{ status: 404 }, 'http-status', 'critical'],
    [{ status: null }, 'http-status', 'critical'],
    [{ metaRobots: 'noindex, follow' }, 'noindex', 'serious'],
    [{ metaRobots: 'none' }, 'noindex', 'serious'],
    [{ xRobotsTag: 'noindex' }, 'noindex', 'serious'],
    [{ canonicals: [] }, 'canonical-missing', 'serious'],
    [{ canonicals: [URL_, 'https://www.example.com/other'] }, 'canonical-multiple', 'serious'],
    [{ title: '' }, 'title-missing', 'serious'],
    [{ title: 'Short' }, 'title-length', 'minor'],
    [{ title: 'x'.repeat(61) }, 'title-length', 'minor'],
    [{ metaDescription: null }, 'meta-description-missing', 'moderate'],
    [{ metaDescription: 'Too short' }, 'meta-description-length', 'minor'],
    [{ h1Count: 0 }, 'h1-missing', 'moderate'],
    [{ h1Count: 2 }, 'h1-multiple', 'minor'],
    [{ htmlLang: '  ' }, 'html-lang-missing', 'moderate'],
    [{ viewport: null }, 'viewport-missing', 'moderate'],
    [{ jsonLd: [{ valid: false, types: [] }] }, 'jsonld-invalid', 'serious'],
  ] as const)('%o → %s (%s)', (overrides, id, severity) => {
    const check = evaluateSeo(snapshot(overrides as Partial<SeoSnapshot>));
    expect(check.issues.find((i) => i.id === id)?.severity).toBe(severity);
    expect(check.score!).toBeLessThan(1);
  });

  it('does not treat "index, follow" or "nofollow" as noindex', () => {
    expect(ids(snapshot({ metaRobots: 'index, follow' }))).toEqual([]);
    expect(ids(snapshot({ metaRobots: 'nofollow' }))).toEqual([]);
  });

  it('does not read the value of max-image-preview:none as the `none` directive (review finding)', () => {
    expect(ids(snapshot({ metaRobots: 'index, follow, max-image-preview:none' }))).toEqual([]);
    expect(ids(snapshot({ xRobotsTag: 'max-snippet:-1, max-video-preview:none' }))).toEqual([]);
  });

  it('honours a user-agent-prefixed X-Robots-Tag', () => {
    expect(ids(snapshot({ xRobotsTag: 'googlebot: noindex' }))).toEqual(['noindex']);
    expect(ids(snapshot({ xRobotsTag: 'otherbot: none' }))).toEqual(['noindex']);
  });

  it('accepts title and description exactly at their bounds', () => {
    expect(ids(snapshot({ title: 'x'.repeat(10) }))).toEqual([]);
    expect(ids(snapshot({ title: 'x'.repeat(60) }))).toEqual([]);
    expect(ids(snapshot({ metaDescription: 'x'.repeat(50) }))).toEqual([]);
    expect(ids(snapshot({ metaDescription: 'x'.repeat(160) }))).toEqual([]);
    expect(ids(snapshot({ metaDescription: 'x'.repeat(161) }))).toEqual(['meta-description-length']);
  });

  it('dedupes identical canonicals and ignores the fragment', () => {
    expect(ids(snapshot({ canonicals: [URL_, `${URL_}#top`] }))).toEqual([]);
  });

  it('reports a canonical pointing elsewhere as info only — no score cost', () => {
    const check = evaluateSeo(snapshot({ canonicals: ['https://www.example.com/route?page=1'] }));
    expect(check.issues).toEqual([
      expect.objectContaining({ id: 'canonical-not-self', severity: 'info' }),
    ]);
    expect(check.score).toBe(1);
  });

  describe('canonicalOrigin', () => {
    it('flags a canonical on another origin (staging leaking into prod)', () => {
      const check = evaluateSeo(snapshot({ canonicals: ['https://staging.example.com/route'] }), {
        canonicalOrigin: 'https://www.example.com',
      });
      expect(check.issues.map((i) => i.id)).toContain('canonical-wrong-origin');
    });

    it('accepts a canonical on the expected origin', () => {
      expect(ids(snapshot(), { canonicalOrigin: 'https://www.example.com/' })).toEqual([]);
    });

    it('is not judged when unset', () => {
      expect(ids(snapshot({ canonicals: ['https://elsewhere.test/route'] }))).toEqual(['canonical-not-self']);
    });
  });

  describe('hreflang', () => {
    const alt = (lang: string, raw: string) => ({ lang, raw, resolved: new URL(raw, URL_).href });

    it('is not judged when the page declares no alternates', () => {
      expect(ids(snapshot({ hreflangs: [] }))).toEqual([]);
    });

    it('accepts a valid, absolute, self-referencing set', () => {
      const hreflangs = [alt('en', URL_), alt('fr-FR', 'https://www.example.com/fr/route'), alt('x-default', URL_)];
      expect(ids(snapshot({ hreflangs }))).toEqual([]);
    });

    it('accepts script subtags and numeric regions', () => {
      const hreflangs = [alt('zh-Hant-TW', URL_), alt('es-419', 'https://www.example.com/es/route')];
      expect(ids(snapshot({ hreflangs }))).toEqual([]);
    });

    it('flags invalid codes, relative URLs, and a missing self-reference', () => {
      const hreflangs = [alt('english', '/en/route'), alt('fr_FR', 'https://www.example.com/fr/route')];
      expect(ids(snapshot({ hreflangs }))).toEqual([
        'hreflang-invalid-code',
        'hreflang-relative',
        'hreflang-no-self',
      ]);
    });

    it('counts a hreflang pointing at the canonical as self-referencing', () => {
      const canonical = 'https://www.example.com/route-canonical';
      const hreflangs = [alt('en', canonical)];
      expect(ids(snapshot({ canonicals: [canonical], hreflangs }))).toEqual(['canonical-not-self']);
    });
  });

  it('weights failures by severity: one critical costs more than several minors', () => {
    const critical = evaluateSeo(snapshot({ status: 500 })).score!;
    const minors = evaluateSeo(snapshot({ title: 'Short', h1Count: 3, metaDescription: 'Too short' })).score!;
    expect(critical).toBeLessThan(minors);
  });

  it('truncates messages to the API limit', () => {
    const long = Array.from({ length: 200 }, (_, i) => `https://www.example.com/${'x'.repeat(20)}/${i}`);
    const check = evaluateSeo(snapshot({ canonicals: long }));
    for (const issue of check.issues) expect(issue.message.length).toBeLessThanOrEqual(1000);
  });
});
