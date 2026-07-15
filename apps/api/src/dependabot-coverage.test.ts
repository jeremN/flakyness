// Static-scan guard for `.github/dependabot.yml`.
//
// `dependabot.yml`'s npm `directories` list is EXPLICIT (`/`, `/apps/api`,
// `/apps/dashboard`), not an `/apps/*` glob — on purpose. A glob would
// overlap the dashboard's own entry (which carries an extra `typescript`
// majors `ignore` for the TS 6 pin, see AGENTS.md) and double-open its PRs,
// defeating that ignore. The trade-off documented in `dependabot.yml`'s own
// comment (and plans/README.md finding #6) is that a NEW workspace package
// must be added to the list by hand, or it silently gets no dependency
// updates.
//
// This test enumerates on-disk workspace package directories (anything
// under `apps/` or `packages/` with a `package.json`, plus the repo root)
// and asserts each one's path is still listed — quoted — in
// `dependabot.yml`. It is a STATIC SCAN, not a test of Dependabot's actual
// behavior: it does not verify ecosystem, ignore rules, schedule, or
// grouping correctness for any entry, only that the directory string is
// present somewhere in the file. Its only job is to turn "added a package,
// forgot to list it" into a loud, CI-red failure instead of a silent gap.
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const DEPENDABOT_PATH = path.join(REPO_ROOT, '.github/dependabot.yml');

function discoverPackageDirs(root: string): string[] {
  const dirs: string[] = [];

  for (const group of ['apps', 'packages']) {
    const groupPath = path.join(root, group);
    if (!existsSync(groupPath)) continue;

    for (const child of readdirSync(groupPath, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const pkgJsonPath = path.join(groupPath, child.name, 'package.json');
      if (existsSync(pkgJsonPath)) {
        dirs.push(`/${group}/${child.name}`);
      }
    }
  }

  return dirs;
}

describe('dependabot.yml workspace coverage', () => {
  const packageDirs = discoverPackageDirs(REPO_ROOT);
  const dependabotText = readFileSync(DEPENDABOT_PATH, 'utf8');

  beforeAll(() => {
    // A vacuous pass (empty list) would prove nothing — apps/api and
    // apps/dashboard always exist as real npm packages, so this must never
    // be empty. Fail loudly rather than silently skipping the it.each below.
    if (packageDirs.length === 0) {
      throw new Error(
        'discoverPackageDirs() found zero workspace packages — expected at ' +
          'least apps/api and apps/dashboard. The discovery logic itself is ' +
          'broken; fix it before trusting this guard.'
      );
    }
  });

  it('covers the repo root entry', () => {
    expect(dependabotText).toContain('"/"');
  });

  it.each(packageDirs)('lists workspace package %s', (dir) => {
    // Match the quoted form so e.g. "/apps/api" cannot match inside a
    // hypothetical "/apps/api-v2" directory string.
    expect(dependabotText).toContain(`"${dir}"`);
  });
});
