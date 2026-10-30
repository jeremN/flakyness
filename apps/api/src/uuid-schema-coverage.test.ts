// Static-scan guard: one `uuidSchema` for the whole API (plans/README.md #19).
//
// `resolveAccess` (middleware/access.ts) runs the scope check only for an id
// that passes `uuidSchema`. A malformed id falls through to the handler, which
// parses the same id again. Safety rests on both sides rejecting the SAME set
// of ids. If a route loosened its own copy of the schema, `resolveAccess`
// would skip the scope check for ids the handler still serves: a silent
// fail-open.
//
// The fix is one shared object, exported by middleware/access.ts. This guard
// fails when a source file declares its own `uuidSchema` again. It is a
// STATIC SCAN: it does not check inline `z.string().uuid()` fields inside
// request-body schemas, which never feed `resolveAccess`.
import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { uuidSchema } from './middleware/access';

const SRC = import.meta.dirname;
const OWNER = path.join('middleware', 'access.ts');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const DECLARATION = /\b(?:const|let|var)\s+uuidSchema\b/;

describe('uuidSchema has one owner', () => {
  const files = sourceFiles(SRC);
  const users = files.filter((f) => /\buuidSchema\b/.test(readFileSync(f, 'utf8')));

  beforeAll(() => {
    // A vacuous pass proves nothing: the owner and the route files must be found.
    if (!users.some((f) => path.relative(SRC, f) === OWNER) || users.length < 2) {
      throw new Error(`Discovery is broken: ${users.length} files use uuidSchema.`);
    }
  });

  it('is declared only in middleware/access.ts', () => {
    const declarers = files
      .filter((f) => DECLARATION.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f));
    expect(declarers).toEqual([OWNER]);
  });

  it('accepts a UUID and rejects a non-UUID', () => {
    expect(uuidSchema.safeParse('3f2504e0-4f89-41d3-9a0c-0305e82c3301').success).toBe(true);
    expect(uuidSchema.safeParse('not-a-uuid').success).toBe(false);
  });
});
