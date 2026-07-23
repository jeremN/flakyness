import { describe, it, expect } from 'vitest';
import { buildLinks } from './links';

describe('buildLinks', () => {
  it('returns all-null when no base URL is configured', () => {
    expect(buildLinks(null, 'some test')).toEqual({ dashboard: null, test: null });
    expect(buildLinks('', 'some test')).toEqual({ dashboard: null, test: null });
    expect(buildLinks(undefined)).toEqual({ dashboard: null, test: null });
  });

  it('builds dashboard and test links from a base URL', () => {
    expect(buildLinks('https://flacky.example.com', 'login test')).toEqual({
      dashboard: 'https://flacky.example.com/flaky',
      test: 'https://flacky.example.com/tests/login%20test',
    });
  });

  it('omits the test link when no test name is given', () => {
    expect(buildLinks('https://flacky.example.com')).toEqual({
      dashboard: 'https://flacky.example.com/flaky',
      test: null,
    });
  });

  it('strips trailing slashes from the base URL', () => {
    expect(buildLinks('https://flacky.example.com///', 'a').dashboard).toBe(
      'https://flacky.example.com/flaky'
    );
  });

  it('encodes special characters in the test name', () => {
    expect(buildLinks('https://x.io', 'a/b c').test).toBe('https://x.io/tests/a%2Fb%20c');
  });

  it('returns all-null for a non-http(s) or malformed base URL', () => {
    expect(buildLinks('ftp://x.io', 'a')).toEqual({ dashboard: null, test: null });
    expect(buildLinks('not a url', 'a')).toEqual({ dashboard: null, test: null });
  });
});
