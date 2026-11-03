import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Backlog #25: every `zValidator(...)` call passes `validationHook` as its
 * third argument. A call without it answers a 400 with the library's default
 * shape (`error` is an object), and nothing else would notice.
 *
 * A static scan, like routes-auth-coverage.test.ts: it reads the source, so a
 * route added later is covered without an edit here.
 */
const ROUTES_DIR = join(__dirname, 'routes');

/** The argument text of every `zValidator(` call in `source`, parentheses balanced. */
function zValidatorCalls(source: string): string[] {
  const calls: string[] = [];
  const marker = 'zValidator(';
  let from = 0;
  for (;;) {
    const start = source.indexOf(marker, from);
    if (start === -1) return calls;
    let depth = 1;
    let i = start + marker.length;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
    }
    calls.push(source.slice(start + marker.length, i - 1));
    from = i;
  }
}

describe('validation hook coverage', () => {
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const calls = files.flatMap((f) =>
    zValidatorCalls(readFileSync(join(ROUTES_DIR, f), 'utf8')).map((args) => ({ file: f, args }))
  );

  it('finds the call sites (a scan that finds none proves nothing)', () => {
    // Bump deliberately when a validated route is added or removed.
    expect(calls).toHaveLength(15);
  });

  it('every zValidator call passes validationHook', () => {
    const missing = calls.filter((c) => !/,\s*validationHook\s*$/.test(c.args.trim()));
    expect(missing).toEqual([]);
  });

  it('the scanner sees a call without the hook', () => {
    expect(zValidatorCalls("x.post('/', zValidator('json', schema), h)")).toEqual(["'json', schema"]);
  });
});
