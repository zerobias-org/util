/**
 * Derive the package scope for the current cwd.
 *
 * When `zbb build` / `zbb test` / `zbb gate` runs inside a workspace
 * subpackage, the monorepo aggregator tasks still want to execute from
 * the repo root — but scoped to that single package so the user doesn't
 * get a full-repo build every time. This module answers: "what package
 * is cwd, relative to the monorepo root?"
 *
 * Scope kinds:
 *   - `root`    — cwd is the monorepo root (no scoping, run aggregator)
 *   - `gradle`  — cwd is a registered gradle subproject w/ build.gradle.kts
 *   - `npm`     — cwd is a pure-npm workspace package (no build.gradle.kts)
 *   - `invalid` — cwd is somewhere else (not a workspace pkg, not root).
 *                 Dispatcher should print the `reason` and refuse.
 *
 * `gradle` and `npm` are flavor variations — they carry the same
 * `packageName` (the npm package name from package.json), which is what
 * the Kotlin monorepo plugin keys on for `-Pmonorepo.scope=<name>`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import {
  findGradleRoot,
  loadProjectCache,
  buildProjectCache,
} from '../gradle.js';

export type PackageScope =
  | { kind: 'root' }
  | { kind: 'gradle'; projectPath: string; packageName: string; relPath: string }
  | { kind: 'npm'; packageName: string; relPath: string }
  | { kind: 'invalid'; reason: string };

/**
 * Resolve cwd's scope relative to `monorepoRootDir`.
 *
 * @param cwd              — the working directory to classify
 * @param monorepoRootDir  — the directory whose zbb.yaml has a `monorepo:`
 *                            block (i.e. findMonorepoRoot(chain).dir)
 */
export function derivePackageScope(
  cwd: string,
  monorepoRootDir: string,
): PackageScope {
  const cwdAbs = resolve(cwd);
  const rootAbs = resolve(monorepoRootDir);

  if (cwdAbs === rootAbs) return { kind: 'root' };

  // cwd must be under the monorepo root. If it isn't, we were handed
  // inconsistent inputs — bail loudly rather than guessing.
  const rel = relative(rootAbs, cwdAbs);
  if (rel.startsWith('..') || rel === '') {
    return {
      kind: 'invalid',
      reason: `cwd (${cwdAbs}) is not under monorepo root (${rootAbs})`,
    };
  }
  const relNorm = rel.split(sep).join('/');

  // cwd's own package.json — must exist and carry a `name` for any
  // subpackage classification.
  const ownPkg = readPackageJson(cwdAbs);
  if (!ownPkg || typeof ownPkg.name !== 'string') {
    return {
      kind: 'invalid',
      reason: `cwd (${cwdAbs}) is not a workspace package — no package.json with "name" found here. ` +
        `Run from the monorepo root or a workspace package directory.`,
    };
  }
  const packageName = ownPkg.name;

  // Verify cwd actually IS a workspace member of the monorepo root
  // (rather than an unrelated package.json that happens to live under
  // the repo tree). This is cheap and catches typos / dropped globs.
  const workspaces = readRootWorkspaces(rootAbs);
  if (!matchesWorkspace(relNorm, workspaces)) {
    return {
      kind: 'invalid',
      reason: `cwd (${cwdAbs}) has a package.json but '${relNorm}' is not a workspace member of the monorepo root. ` +
        `Check the "workspaces" array in ${rootAbs}/package.json.`,
    };
  }

  // Gradle vs npm flavor. A package is "gradle-flavored" when it has
  // build.gradle.kts AND is registered as a subproject in
  // settings.gradle.kts. Both conditions matter — an orphan build file
  // that isn't in settings can't be targeted by `:<path>:<task>`.
  const hasBuildFile =
    existsSync(join(cwdAbs, 'build.gradle.kts')) ||
    existsSync(join(cwdAbs, 'build.gradle'));

  if (hasBuildFile) {
    const gradlePath = resolveGradleProjectPath(rootAbs, cwdAbs);
    if (gradlePath) {
      return {
        kind: 'gradle',
        projectPath: gradlePath,
        packageName,
        relPath: relNorm,
      };
    }
    // Has build.gradle.kts but isn't registered. In monorepo mode we
    // still scope by npm package name (that's the plugin's key), so
    // this is functionally equivalent to an npm-only package. The
    // user's build.gradle.kts may still get picked up via the
    // per-subproject wiring inside the aggregator — the plugin's job,
    // not ours. Downgrade silently.
    return { kind: 'npm', packageName, relPath: relNorm };
  }

  return { kind: 'npm', packageName, relPath: relNorm };
}

// ── Internals ───────────────────────────────────────────────────────

function readPackageJson(dir: string): { name?: unknown } | null {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as { name?: unknown };
  } catch {
    return null;
  }
}

function readRootWorkspaces(rootDir: string): string[] {
  const p = join(rootDir, 'package.json');
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as {
      workspaces?: string[] | { packages?: string[] };
    };
    if (Array.isArray(parsed.workspaces)) return parsed.workspaces;
    if (parsed.workspaces && Array.isArray(parsed.workspaces.packages)) {
      return parsed.workspaces.packages;
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Match a POSIX-normalized relative path against a npm workspaces glob.
 *
 * Supports the two forms the monorepo plugin actually uses:
 *   - literal:  "packages/foo"          → exact match
 *   - wildcard: "packages/*"            → "packages/<anything-without-slash>"
 *
 * More exotic glob patterns (double-star, brace-expansion) aren't used
 * in our repos — if that changes, route through a proper glob lib.
 */
function matchesWorkspace(relPath: string, workspaces: string[]): boolean {
  for (const glob of workspaces) {
    if (!glob.includes('*')) {
      if (relPath === glob) return true;
      continue;
    }
    const base = glob.substring(0, glob.indexOf('*'));
    // base ends with "/" for "packages/*" — match the next segment only.
    if (!relPath.startsWith(base)) continue;
    const tail = relPath.substring(base.length);
    // "packages/foo" tail "foo" — ok. "packages/foo/bar" tail "foo/bar"
    // — not a workspace member (globs here are single-segment).
    if (tail.length > 0 && !tail.includes('/')) return true;
  }
  return false;
}

/**
 * Resolve `cwd`'s Gradle subproject path (":foo:bar") using the cached
 * project map if present, building it on demand otherwise. Returns null
 * when cwd isn't a registered subproject of `rootDir`.
 */
function resolveGradleProjectPath(rootDir: string, cwd: string): string | null {
  const gradle = findGradleRoot(cwd);
  if (!gradle || resolve(gradle.root) !== resolve(rootDir)) return null;

  let projects = loadProjectCache(gradle.root);
  if (projects === null) {
    try {
      projects = buildProjectCache(gradle.root, gradle.wrapper);
    } catch {
      return null;
    }
  }
  // detectProject uses process.cwd() internally — we need the mapping
  // for the specific dir we were handed, which may differ from
  // process.cwd() in tests. Re-implement the longest-prefix match here.
  const rel = relative(gradle.root, cwd).split(sep).join('/');
  if (!rel || rel === '.') return null;
  let best: string | null = null;
  let bestLen = -1;
  for (const [path, projectDir] of Object.entries(projects)) {
    const dirNorm = projectDir.split(sep).join('/');
    if (rel === dirNorm || rel.startsWith(dirNorm + '/')) {
      if (dirNorm.length > bestLen) {
        bestLen = dirNorm.length;
        best = path;
      }
    }
  }
  return best;
}
