import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './mutation-gate.mjs';

// A fake report: logger fully killed, projects has one survivor.
const reports = {
  'r-api.json': { files: {
    'src/middleware/logger.ts': { mutants: [{ status: 'Killed' }, { status: 'Killed' }, { status: 'Timeout' }] },
    'src/routes/projects.ts':   { mutants: [{ status: 'Killed' }, { status: 'Survived' }, { status: 'Ignored' }] },
  } },
};
const readJson = (p) => reports[p];

test('scores a fully-killed file at 100 and passes its floor', () => {
  const { results } = evaluate([{ report: 'r-api.json', file: 'src/middleware/logger.ts', floor: 90 }], readJson);
  assert.equal(results[0].score, 100);
  assert.equal(results[0].pass, true);
});

test('excludes Ignored from the denominator; one survivor of two valid = 50%', () => {
  const { results } = evaluate([{ report: 'r-api.json', file: 'src/routes/projects.ts', floor: 80 }], readJson);
  assert.equal(results[0].score, 50);   // 1 Killed / (1 Killed + 1 Survived); Ignored dropped
  assert.equal(results[0].pass, false); // 50 < 80
});

test('ok is false if ANY file fails its floor', () => {
  const { ok } = evaluate([
    { report: 'r-api.json', file: 'src/middleware/logger.ts', floor: 90 },
    { report: 'r-api.json', file: 'src/routes/projects.ts', floor: 80 },
  ], readJson);
  assert.equal(ok, false);
});

test('a missing file entry is a hard error (ok false, error set)', () => {
  const { ok, error } = evaluate([{ report: 'r-api.json', file: 'src/nope.ts', floor: 90 }], readJson);
  assert.equal(ok, false);
  assert.match(error, /src\/nope\.ts/);
});
