// Static-scan guard for `.github/dependabot.yml` and `pnpm-workspace.yaml`.
//
// `dependabot.yml` has ONE npm entry, for the repo root "/". From the root,
// Dependabot's npm updater covers every workspace package that matches a
// `packages` glob in `pnpm-workspace.yaml`, and it updates the root lockfile
// in the same PR. This guard enforces two rules:
//
// 1. Every workspace package directory on disk (anything under `apps/` or
//    `packages/` with a `package.json`) matches a `pnpm-workspace.yaml` glob.
//    Otherwise Dependabot does not cover it and it gets no dependency updates.
// 2. `dependabot.yml` lists no workspace subdirectory (`"/apps/..."`,
//    `"/packages/..."`). A subdirectory entry opens a duplicate PR with no
//    lockfile change, and security updates fail on it with pnpm
//    `misconfigured_tooling` (plans/README.md follow-up #23).
//
// This is a STATIC SCAN, not a test of Dependabot's behavior. It does not
// check ecosystems, ignore rules, schedules or groups.
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const DEPENDABOT_PATH = path.join(REPO_ROOT, '.github/dependabot.yml');
const WORKSPACE_PATH = path.join(REPO_ROOT, 'pnpm-workspace.yaml');

function discoverPackageDirs(root: string): string[] {
  const dirs: string[] = [];

  for (const group of ['apps', 'packages']) {
    const groupPath = path.join(root, group);
    if (!existsSync(groupPath)) continue;

    for (const child of readdirSync(groupPath, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const pkgJsonPath = path.join(groupPath, child.name, 'package.json');
      if (existsSync(pkgJsonPath)) {
        dirs.push(`${group}/${child.name}`);
      }
    }
  }

  return dirs;
}

/** Reads the `packages:` list of pnpm-workspace.yaml (one `- 'glob'` per line). */
function readWorkspaceGlobs(yamlText: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const line of yamlText.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s+['"]?([^'"#\s]+)['"]?\s*$/.exec(line);
    if (item) {
      globs.push(item[1]);
    } else if (line.trim() !== '' && !line.trim().startsWith('#')) {
      break;
    }
  }
  return globs;
}

/** True when `dir` (e.g. `apps/api`) matches an exact path or a one-level `parent/*` glob. */
function isCoveredByGlobs(dir: string, globs: string[]): boolean {
  return globs.some((glob) => {
    if (glob.endsWith('/*')) {
      const parent = glob.slice(0, -2);
      const rest = dir.slice(parent.length + 1);
      return dir.startsWith(`${parent}/`) && rest.length > 0 && !rest.includes('/');
    }
    return glob === dir;
  });
}

describe('workspace glob helpers', () => {
  it('reads the packages list and stops at the next top-level key', () => {
    const yaml = "packages:\n  - 'apps/*'\n  - \"packages/*\"\n\n# comment\nminimumReleaseAge: 1440\n  - 'ignored/*'\n";
    expect(readWorkspaceGlobs(yaml)).toEqual(['apps/*', 'packages/*']);
  });

  it('matches a direct child of a parent/* glob only', () => {
    expect(isCoveredByGlobs('apps/api', ['apps/*'])).toBe(true);
    expect(isCoveredByGlobs('apps/api/nested', ['apps/*'])).toBe(false);
    expect(isCoveredByGlobs('apps-old/api', ['apps/*'])).toBe(false);
    expect(isCoveredByGlobs('tools/cli', ['apps/*', 'packages/*'])).toBe(false);
    expect(isCoveredByGlobs('tools/cli', ['tools/cli'])).toBe(true);
  });
});

describe('dependabot.yml workspace coverage', () => {
  const packageDirs = discoverPackageDirs(REPO_ROOT);
  // Drop full-line comments: dependabot.yml's own comments name the
  // forbidden subdirectory entries.
  const dependabotText = readFileSync(DEPENDABOT_PATH, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  const workspaceGlobs = readWorkspaceGlobs(readFileSync(WORKSPACE_PATH, 'utf8'));

  beforeAll(() => {
    // A vacuous pass would prove nothing: apps/api and apps/dashboard always
    // exist, and pnpm-workspace.yaml always declares globs.
    if (packageDirs.length === 0 || workspaceGlobs.length === 0) {
      throw new Error(
        `Discovery is broken: ${packageDirs.length} package dirs, ` +
          `${workspaceGlobs.length} workspace globs. Fix it before trusting this guard.`
      );
    }
  });

  it('covers the repo root entry', () => {
    expect(dependabotText).toContain('"/"');
  });

  it.each(packageDirs)('workspace package %s matches a pnpm-workspace.yaml glob', (dir) => {
    expect(isCoveredByGlobs(dir, workspaceGlobs)).toBe(true);
  });

  it('lists no workspace subdirectory (duplicate PRs, broken security updates)', () => {
    const subdirEntries = dependabotText.match(/"\/(apps|packages)\/[^"]*"/g) ?? [];
    expect(subdirEntries).toEqual([]);
  });
});
