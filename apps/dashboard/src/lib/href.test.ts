import { describe, it, expect } from 'vitest';
import { appendProjectParam } from './href';

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
