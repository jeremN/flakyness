import { describe, it, expect } from 'vitest';
import { appendProjectParam, withQueryParam } from './href';

describe('appendProjectParam', () => {
  it('leaves the href untouched when projectId is undefined', () => {
    expect(appendProjectParam('/flaky?status=active', undefined)).toBe('/flaky?status=active');
  });
  it('uses & when a query string already exists', () => {
    expect(appendProjectParam('/flaky?status=active', 'p1')).toBe('/flaky?status=active&project=p1');
  });
  it('uses ? when there is no query string', () => {
    expect(appendProjectParam('/analysis', 'p1')).toBe('/analysis?project=p1');
  });
});

describe('withQueryParam', () => {
  it('adds the param when the URL has no query string at all', () => {
    expect(withQueryParam(new URL('http://x/flaky'), 'team', 't1')).toBe('/flaky?team=t1');
  });

  it('preserves an unrelated existing param', () => {
    expect(withQueryParam(new URL('http://x/flaky?project=p1'), 'team', 't1')).toBe('/flaky?project=p1&team=t1');
  });

  it('REPLACES an existing value for the same key rather than duplicating it', () => {
    // The property appendProjectParam above does NOT have — this is why the
    // project link list and TeamSwitcher need this function instead.
    expect(withQueryParam(new URL('http://x/flaky?team=t1'), 'team', 't2')).toBe('/flaky?team=t2');
  });

  it('removes the key entirely when value is null, leaving other params intact', () => {
    expect(withQueryParam(new URL('http://x/flaky?project=p1&team=t1'), 'team', null)).toBe('/flaky?project=p1');
  });

  it('drops the query string entirely when removing the only param', () => {
    expect(withQueryParam(new URL('http://x/flaky?team=t1'), 'team', null)).toBe('/flaky');
  });
});
