import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCommandForCwd } from '../lib/standardLifecycle.js';

/**
 * Tests for the non-monorepo lifecycle dispatcher. Focused on
 * `resolveCommandForCwd` since the rest of `spawnStandardLifecycleAndExit`
 * is wiring around process.exit / spawn — covered by smoke-tests against
 * a real repo, not unit tests.
 *
 * Each test sets up a fresh fake repo on disk inside tmpdir:
 *   <repoRoot>/
 *     gradlew                                 (so findGradleRoot resolves)
 *     settings.gradle.kts
 *     .gradle/zbb-projects.json               (cached project paths)
 *     <subproject-path>/build.gradle.kts      (registered subproject)
 *     <other-pkg>/package.json                (npm-only, no gradle)
 *
 * The cached `.gradle/zbb-projects.json` lets resolveCommandForCwd
 * discover subproject mappings without invoking gradle.
 */

let tmpRoot: string;
let savedCwd: string;
let savedExit: typeof process.exit;
let savedStderrWrite: typeof process.stderr.write;
let savedConsoleError: typeof console.error;
let exitCode: number | undefined;
let exitMessages: string[];

class ProcessExitInTest extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

before(() => {
  // Stub process.exit so resolveCommandForCwd's "refuse" path throws
  // instead of killing the test runner. Tests assert on `exitCode`.
  savedExit = process.exit;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new ProcessExitInTest(exitCode);
  }) as typeof process.exit;

  // Capture console.error output for refuse-path message assertions.
  savedConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    exitMessages.push(args.map(String).join(' '));
  };
  savedStderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    exitMessages.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
});

after(() => {
  process.exit = savedExit;
  console.error = savedConsoleError;
  process.stderr.write = savedStderrWrite;
});

beforeEach(async () => {
  savedCwd = process.cwd();
  exitCode = undefined;
  exitMessages = [];
  tmpRoot = await mkdtemp(join(tmpdir(), 'zbb-stdlc-'));
});

afterEach(async () => {
  process.chdir(savedCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

/** Create a minimal fake repo with a gradle wrapper + project cache. */
async function makeRepo(opts: {
  /** Map of gradle path → relative project dir. e.g. {':github:github': 'package/github/github'} */
  projects: Record<string, string>;
  /** Subproject dirs that should also receive a build.gradle.kts file. */
  buildFileDirs?: string[];
  /** Subproject dirs that should ONLY have a package.json (no gradle). */
  pkgOnlyDirs?: string[];
}): Promise<string> {
  const repoRoot = tmpRoot;

  // Marker files for findGradleRoot
  await writeFile(join(repoRoot, 'gradlew'), '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(join(repoRoot, 'settings.gradle.kts'), '// stub\n', 'utf-8');

  // Cache: settingsMtime must match the on-disk settings.gradle.kts mtime
  // for loadProjectCache to return the parsed map. We compute it by
  // statting the file we just wrote.
  const { statSync } = await import('node:fs');
  const settingsMtime = statSync(join(repoRoot, 'settings.gradle.kts')).mtimeMs;
  const cacheDir = join(repoRoot, '.gradle');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(cacheDir, 'zbb-projects.json'),
    JSON.stringify({ settingsMtime, projects: opts.projects }, null, 2),
    'utf-8',
  );

  // Materialize subprojects with build.gradle.kts
  for (const dir of opts.buildFileDirs ?? []) {
    const abs = join(repoRoot, dir);
    await mkdir(abs, { recursive: true });
    await writeFile(join(abs, 'build.gradle.kts'), '// stub\n', 'utf-8');
  }

  // Materialize package.json-only directories (refuse path)
  for (const dir of opts.pkgOnlyDirs ?? []) {
    const abs = join(repoRoot, dir);
    await mkdir(abs, { recursive: true });
    await writeFile(join(abs, 'package.json'), '{"name":"x"}\n', 'utf-8');
  }

  return repoRoot;
}

describe('resolveCommandForCwd — root passthrough', () => {
  it('returns the baseCommand unchanged when cwd equals repoRoot', async () => {
    const repoRoot = await makeRepo({ projects: {} });
    process.chdir(repoRoot);
    const result = resolveCommandForCwd(repoRoot, './gradlew build');
    assert.equal(result, './gradlew build');
  });

  it('returns the baseCommand unchanged for an unrelated subfolder (no package.json, no build.gradle.kts)', async () => {
    const repoRoot = await makeRepo({ projects: {} });
    const docs = join(repoRoot, 'docs');
    await mkdir(docs, { recursive: true });
    process.chdir(docs);
    const result = resolveCommandForCwd(repoRoot, './gradlew build');
    assert.equal(result, './gradlew build');
  });
});

describe('resolveCommandForCwd — subproject prefix rewrite', () => {
  it('rewrites a single-segment task name to :subproject:task when cwd is a registered gradle subproject', async () => {
    const repoRoot = await makeRepo({
      projects: { ':github:github': 'package/github/github' },
      buildFileDirs: ['package/github/github'],
    });
    process.chdir(join(repoRoot, 'package/github/github'));
    const result = resolveCommandForCwd(repoRoot, './gradlew build');
    assert.equal(result, './gradlew :github:github:build');
  });

  it('preserves leading flags when rewriting the task', async () => {
    const repoRoot = await makeRepo({
      projects: { ':github:github': 'package/github/github' },
      buildFileDirs: ['package/github/github'],
    });
    process.chdir(join(repoRoot, 'package/github/github'));
    const result = resolveCommandForCwd(repoRoot, './gradlew --info build');
    assert.equal(result, './gradlew --info :github:github:build');
  });

  it('skips rewrite if the task is already prefixed with a colon', async () => {
    const repoRoot = await makeRepo({
      projects: { ':github:github': 'package/github/github' },
      buildFileDirs: ['package/github/github'],
    });
    process.chdir(join(repoRoot, 'package/github/github'));
    const result = resolveCommandForCwd(repoRoot, './gradlew :other:test');
    assert.equal(result, './gradlew :other:test');
  });
});

describe('resolveCommandForCwd — refuse path', () => {
  it('exits 1 with an actionable message when cwd has package.json but no build.gradle.kts', async () => {
    const repoRoot = await makeRepo({
      projects: {},
      pkgOnlyDirs: ['package/orphan'],
    });
    process.chdir(join(repoRoot, 'package/orphan'));

    assert.throws(
      () => resolveCommandForCwd(repoRoot, './gradlew build'),
      ProcessExitInTest,
    );
    assert.equal(exitCode, 1);
    const combined = exitMessages.join('\n');
    assert.match(combined, /package\.json/);
    assert.match(combined, /build\.gradle\.kts/);
    assert.match(combined, /publishable/);
  });

  it('exits 1 when cwd has build.gradle.kts but the project is NOT in settings.gradle.kts', async () => {
    const repoRoot = await makeRepo({
      projects: {}, // empty cache → detectProject returns null
      buildFileDirs: ['package/unregistered'],
    });
    process.chdir(join(repoRoot, 'package/unregistered'));

    assert.throws(
      () => resolveCommandForCwd(repoRoot, './gradlew build'),
      ProcessExitInTest,
    );
    assert.equal(exitCode, 1);
    const combined = exitMessages.join('\n');
    assert.match(combined, /settings\.gradle\.kts/);
  });
});

describe('resolveCommandForCwd — bail-on-unsafe', () => {
  it('returns the baseCommand unchanged when it contains &&', async () => {
    const repoRoot = await makeRepo({
      projects: { ':github:github': 'package/github/github' },
      buildFileDirs: ['package/github/github'],
    });
    process.chdir(join(repoRoot, 'package/github/github'));
    const cmd = './gradlew build && echo done';
    assert.equal(resolveCommandForCwd(repoRoot, cmd), cmd);
  });

  it('returns the baseCommand unchanged when it contains a pipe', async () => {
    const repoRoot = await makeRepo({
      projects: { ':github:github': 'package/github/github' },
      buildFileDirs: ['package/github/github'],
    });
    process.chdir(join(repoRoot, 'package/github/github'));
    const cmd = './gradlew build | tee out.log';
    assert.equal(resolveCommandForCwd(repoRoot, cmd), cmd);
  });

  it('returns the baseCommand unchanged when it contains a semicolon', async () => {
    const repoRoot = await makeRepo({
      projects: { ':github:github': 'package/github/github' },
      buildFileDirs: ['package/github/github'],
    });
    process.chdir(join(repoRoot, 'package/github/github'));
    const cmd = './gradlew build; echo done';
    assert.equal(resolveCommandForCwd(repoRoot, cmd), cmd);
  });

  it('returns the baseCommand unchanged when the executable is not gradle/gradlew', async () => {
    const repoRoot = await makeRepo({
      projects: { ':github:github': 'package/github/github' },
      buildFileDirs: ['package/github/github'],
    });
    process.chdir(join(repoRoot, 'package/github/github'));
    const cmd = 'npm run build';
    assert.equal(resolveCommandForCwd(repoRoot, cmd), cmd);
  });

  it('returns the baseCommand unchanged when there is no positional task argument', async () => {
    const repoRoot = await makeRepo({
      projects: { ':github:github': 'package/github/github' },
      buildFileDirs: ['package/github/github'],
    });
    process.chdir(join(repoRoot, 'package/github/github'));
    const cmd = './gradlew --info';
    assert.equal(resolveCommandForCwd(repoRoot, cmd), cmd);
  });
});

describe('resolveCommandForCwd — gradle root mismatch', () => {
  it('returns the baseCommand unchanged when cwd is in a NESTED gradle tree (different root)', async () => {
    // Outer repo with gradlew + cached projects
    const outerRepo = await makeRepo({ projects: {} });

    // Inner gradle tree: nested directory with its own gradlew (so
    // findGradleRoot resolves to the inner one, not outerRepo).
    const innerRoot = join(outerRepo, 'nested');
    await mkdir(innerRoot, { recursive: true });
    await writeFile(join(innerRoot, 'gradlew'), '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(join(innerRoot, 'build.gradle.kts'), '// stub\n', 'utf-8');

    process.chdir(innerRoot);
    // Caller passes the OUTER repoRoot as the root. resolveCommandForCwd
    // should detect that cwd's nearest gradlew is somewhere else and bail.
    const cmd = './gradlew build';
    assert.equal(resolveCommandForCwd(outerRepo, cmd), cmd);
  });
});
