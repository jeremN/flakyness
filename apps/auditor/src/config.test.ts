import { describe, it, expect } from 'vitest';
import { parseConfig } from './config';
import { MAX_PAGES } from './types';

describe('parseConfig', () => {
  it('applies defaults to a minimal config', () => {
    const config = parseConfig({ urls: ['https://example.com/'] });
    expect(config).toMatchObject({
      devices: ['mobile'],
      categories: ['a11y', 'seo', 'perf'],
      timeoutMs: 30_000,
      settleMs: 3000,
      beforeAudit: { clickIfVisible: [], waitAfterMs: 500 },
      axe: { tags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'], exclude: [] },
      seo: {},
    });
  });

  it('dedupes urls, devices and categories (the API rejects a repeated url+device)', () => {
    const config = parseConfig({
      urls: ['https://a.test/', 'https://a.test/'],
      devices: ['mobile', 'mobile'],
      categories: ['seo', 'seo'],
    });
    expect(config.urls).toEqual(['https://a.test/']);
    expect(config.devices).toEqual(['mobile']);
    expect(config.categories).toEqual(['seo']);
  });

  it('rejects an empty url list and non-URLs, naming the path', () => {
    expect(() => parseConfig({ urls: [] })).toThrow(/urls/);
    expect(() => parseConfig({ urls: ['example.com'] })).toThrow(/urls\.0/);
  });

  it('rejects unknown devices and categories', () => {
    expect(() => parseConfig({ urls: ['https://a.test/'], devices: ['tablet'] })).toThrow(/devices/);
    expect(() => parseConfig({ urls: ['https://a.test/'], categories: ['security'] })).toThrow(/categories/);
  });

  it(`rejects more than ${MAX_PAGES} url x device pairs (the API would 400 the upload)`, () => {
    const urls = Array.from({ length: MAX_PAGES / 2 + 1 }, (_, i) => `https://a.test/${i}`);
    expect(() => parseConfig({ urls, devices: ['mobile', 'desktop'] })).toThrow(/must not exceed/);
    expect(() => parseConfig({ urls, devices: ['mobile'] })).not.toThrow();
  });
});
