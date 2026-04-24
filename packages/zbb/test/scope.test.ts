import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { derivePackageScope } from '../lib/monorepo/scope.js';

/**
 * Tests for `derivePackageScope` — the cwd → scope classifier used by
 * the lifecycle dispatcher to decide whether to pass
 * `-Pmonorepo.scope=<pkg>` to the Kotlin plugin.
 *
 * Fixture:
 *   <tmpRoot>/                  ← monorepoRootDir
 *     package.json              (workspaces: ["packages/*", "app"])
 *     gradlew, settings.gradle.kts, .gradle/zbb-projects.json
 *     packages/
 *       gradle-pkg/             (build.gradle.kts + package.json)
 *       npm-pkg/                (package.json only)
 *       unregistered/           (build.gradle.kts but NOT in settings)
 *     app/                      (literal workspace, package.json only)
 *     scripts/                  (NOT a workspace member)
 *     outside-tmpRoot/          (sibling — for the "outside" test)
 */

let tmpRoot: string;
let savedCwd: string;

before(() => {
  savedCwd = process.cwd();
});

after(() => {
  process.chdir(savedCwd);
});

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'zbb-scope-'));

  await writeFile(
    join(tmpRoot, 'package.json'),
    JSON.stringify({ name: 'monorepo-root', workspaces: ['packages/*', 'app'] }, null, 2),
    'utf-8',
  );

  // Gradle wrapper + settings + cached project map
  await writeFile(join(tmpRoot, 'gradlew'), '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(join(tmpRoot, 'settings.gradle.kts'), '// stub\n', 'utf-8');
  const { statSync } = await import('node:fs');
  const settingsMtime = statSync(join(tmpRoot, 'settings.gradle.kts')).mtimeMs;
  await mkdir(join(tmpRoot, '.gradle'), { recursive: true });
  await writeFile(
    join(tmpRoot, '.gradle', 'zbb-projects.json'),
    JSON.stringify(
      {
        settingsMtime,
        projects: { ':packages:gradle-pkg': 'packages/gradle-pkg' },
      },
      null,
      2,
    ),
    'utf-8',
  );

  // packages/gradle-pkg — registered gradle subproject w/ build file
  await mkdir(join(tmpRoot, 'packages/gradle-pkg'), { recursive: true });
  await writeFile(
    join(tmpRoot, 'packages/gradle-pkg/package.json'),
    JSON.stringify({ name: '@scope/gradle-pkg' }, null, 2),
    'utf-8',
  );
  await writeFile(join(tmpRoot, 'packages/gradle-pkg/build.gradle.kts'), '// stub\n', 'utf-8');

  // packages/npm-pkg — workspace member, package.json only
  await mkdir(join(tmpRoot, 'packages/npm-pkg'), { recursive: true });
  await writeFile(
    join(tmpRoot, 'packages/npm-pkg/package.json'),
    JSON.stringify({ name: '@scope/npm-pkg' }, null, 2),
    'utf-8',
  );

  // packages/unregistered — has build.gradle.kts but NOT in the cached
  // settings map. We want this to downgrade to npm-scope (still
  // targetable by the monorepo plugin via npm package name).
  await mkdir(join(tmpRoot, 'packages/unregistered'), { recursive: true });
  await writeFile(
    join(tmpRoot, 'packages/unregistered/package.json'),
    JSON.stringify({ name: '@scope/unregistered' }, null, 2),
    'utf-8',
  );
  await writeFile(join(tmpRoot, 'packages/unregistered/build.gradle.kts'), '// stub\n', 'utf-8');

  // app — literal workspace (no wildcard)
  await mkdir(join(tmpRoot, 'app'), { recursive: true });
  await writeFile(
    join(tmpRoot, 'app/package.json'),
    JSON.stringify({ name: '@scope/app' }, null, 2),
    'utf-8',
  );

  // scripts — NOT a workspace member (not in workspaces array)
  await mkdir(join(tmpRoot, 'scripts'), { recursive: true });
  await writeFile(
    join(tmpRoot, 'scripts/package.json'),
    JSON.stringify({ name: '@scope/scripts' }, null, 2),
    'utf-8',
  );
});

afterEach(async () => {
  process.chdir(savedCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('derivePackageScope', () => {
  it('returns {kind:"root"} when cwd is the monorepo root', () => {
    const scope = derivePackageScope(tmpRoot, tmpRoot);
    assert.deepEqual(scope, { kind: 'root' });
  });

  it('returns {kind:"gradle"} for a registered gradle subproject with build.gradle.kts', () => {
    const cwd = join(tmpRoot, 'packages/gradle-pkg');
    const scope = derivePackageScope(cwd, tmpRoot);
    assert.equal(scope.kind, 'gradle');
    if (scope.kind !== 'gradle') throw new Error('unreachable');
    assert.equal(scope.projectPath, ':packages:gradle-pkg');
    assert.equal(scope.packageName, '@scope/gradle-pkg');
    assert.equal(scope.relPath, 'packages/gradle-pkg');
  });

  it('returns {kind:"npm"} for a pure-npm workspace package', () => {
    const cwd = join(tmpRoot, 'packages/npm-pkg');
    const scope = derivePackageScope(cwd, tmpRoot);
    assert.equal(scope.kind, 'npm');
    if (scope.kind !== 'npm') throw new Error('unreachable');
    assert.equal(scope.packageName, '@scope/npm-pkg');
    assert.equal(scope.relPath, 'packages/npm-pkg');
  });

  it('downgrades unregistered gradle subproject to {kind:"npm"}', () => {
    const cwd = join(tmpRoot, 'packages/unregistered');
    const scope = derivePackageScope(cwd, tmpRoot);
    // Has build.gradle.kts but isn't in settings → functionally npm.
    assert.equal(scope.kind, 'npm');
    if (scope.kind !== 'npm') throw new Error('unreachable');
    assert.equal(scope.packageName, '@scope/unregistered');
  });

  it('resolves a literal (non-wildcard) workspace entry', () => {
    const cwd = join(tmpRoot, 'app');
    const scope = derivePackageScope(cwd, tmpRoot);
    assert.equal(scope.kind, 'npm');
    if (scope.kind !== 'npm') throw new Error('unreachable');
    assert.equal(scope.packageName, '@scope/app');
    assert.equal(scope.relPath, 'app');
  });

  it('returns {kind:"invalid"} when cwd has package.json but is NOT a workspace member', () => {
    const cwd = join(tmpRoot, 'scripts');
    const scope = derivePackageScope(cwd, tmpRoot);
    assert.equal(scope.kind, 'invalid');
    if (scope.kind !== 'invalid') throw new Error('unreachable');
    assert.match(scope.reason, /workspace member/);
  });

  it('returns {kind:"invalid"} for a subdir with no package.json', async () => {
    const cwd = join(tmpRoot, 'packages/npm-pkg/subdir');
    await mkdir(cwd, { recursive: true });
    const scope = derivePackageScope(cwd, tmpRoot);
    assert.equal(scope.kind, 'invalid');
    if (scope.kind !== 'invalid') throw new Error('unreachable');
    assert.match(scope.reason, /package\.json/);
  });

  it('returns {kind:"invalid"} for a cwd outside the monorepo root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'zbb-scope-outside-'));
    try {
      const scope = derivePackageScope(outside, tmpRoot);
      assert.equal(scope.kind, 'invalid');
      if (scope.kind !== 'invalid') throw new Error('unreachable');
      assert.match(scope.reason, /not under monorepo root/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
