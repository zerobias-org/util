import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findZbbChain,
  findLifecycleOwner,
  normalizeLifecycleEntry,
  resolveGateRegistry,
  type ToolDefinition,
  type EnvVarDeclaration,
} from '../lib/config.js';
import { checkToolGates, checkEnvGates, type EnvGateResult } from '../lib/preflight.js';

/**
 * Unit tests for the object-form lifecycle schema + gate machinery.
 * Divided into four concerns:
 *
 *   1. normalizeLifecycleEntry — parses string shorthand AND object
 *      form, rejects malformed object (non-string command).
 *   2. findLifecycleOwner — returns gates when entry is in object form,
 *      returns undefined gates for shorthand.
 *   3. resolveGateRegistry — finds the named stack manifest's
 *      tools/env blocks starting from the lifecycle owner's dir.
 *   4. checkToolGates / checkEnvGates — per-gate resolution pass/fail.
 *
 * Integration with the full dispatch path is in
 * dispatch.integration.test.ts.
 */

describe('normalizeLifecycleEntry', () => {
  it('accepts shorthand string form', () => {
    const e = normalizeLifecycleEntry('./gradlew monorepoBuild');
    assert.deepEqual(e, { command: './gradlew monorepoBuild' });
  });

  it('accepts full object form with tools + env', () => {
    const e = normalizeLifecycleEntry({
      command: './gradlew monorepoBuild',
      tools: ['node', 'docker'],
      env: ['NPM_TOKEN'],
    });
    assert.deepEqual(e, {
      command: './gradlew monorepoBuild',
      tools: ['node', 'docker'],
      env: ['NPM_TOKEN'],
    });
  });

  it('accepts object form with only command (no gates)', () => {
    const e = normalizeLifecycleEntry({ command: './gradlew monorepoGateCheck' });
    assert.deepEqual(e, { command: './gradlew monorepoGateCheck' });
  });

  it('rejects object form without a command string', () => {
    assert.equal(normalizeLifecycleEntry({ tools: ['docker'] }), null);
    assert.equal(normalizeLifecycleEntry({ command: 123 }), null);
  });

  it('rejects non-string, non-object values', () => {
    assert.equal(normalizeLifecycleEntry(null), null);
    assert.equal(normalizeLifecycleEntry(undefined), null);
    assert.equal(normalizeLifecycleEntry(42), null);
    assert.equal(normalizeLifecycleEntry(['./gradlew build']), null);
  });

  it('drops tools/env when they are not string arrays', () => {
    const e = normalizeLifecycleEntry({
      command: './gradlew build',
      tools: [1, 2, 3],
      env: 'NPM_TOKEN',
    });
    assert.deepEqual(e, { command: './gradlew build' });
  });
});

// ── findLifecycleOwner + resolveGateRegistry fixtures ────────────────

let tmpRoot: string;
let savedCwd: string;

before(() => {
  savedCwd = process.cwd();
});

after(() => {
  process.chdir(savedCwd);
});

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'zbb-gates-'));

  // Root zbb.yaml — stack manifest with tools: registry + env: decls +
  // lifecycle in object form.
  await writeFile(
    join(tmpRoot, 'zbb.yaml'),
    [
      'name: "@scope/root"',
      'version: "1.0.0"',
      'monorepo:',
      '  sourceDirs: [src]',
      'tools:',
      '  node:',
      '    check: "node --version"',
      '    parse: "v(\\\\S+)"',
      '    version: ">=22"',
      '  docker:',
      '    check: "docker --version"',
      '    parse: "Docker version (\\\\S+),"',
      '    version: ">=24"',
      'env:',
      '  NPM_TOKEN:',
      '    type: string',
      '    source: env',
      '    required: true',
      '  OPTIONAL_VAR:',
      '    type: string',
      '    default: "ok"',
      'lifecycle:',
      '  build:',
      '    command: ./gradlew monorepoBuild',
      '    tools: [node]',
      '    env: [NPM_TOKEN]',
      '  clean: ./gradlew monorepoClean',  // shorthand — no gates
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    join(tmpRoot, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: ['packages/*'] }, null, 2),
    'utf-8',
  );

  // packages/foo — nested stack manifest WITHOUT its own tools block.
  // Its lifecycle gate references hub's tools.
  await mkdir(join(tmpRoot, 'packages/foo'), { recursive: true });
  await writeFile(
    join(tmpRoot, 'packages/foo/zbb.yaml'),
    [
      'name: "@scope/foo"',
      'version: "1.0.0"',
      'lifecycle:',
      '  custom:',
      '    command: ./scripts/custom.sh',
      '    tools: [docker]',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    join(tmpRoot, 'packages/foo/package.json'),
    JSON.stringify({ name: '@scope/foo' }, null, 2),
    'utf-8',
  );
});

afterEach(async () => {
  process.chdir(savedCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('findLifecycleOwner — gate metadata', () => {
  it('returns tools + env when the owner entry is in object form', async () => {
    const chain = await findZbbChain(tmpRoot);
    const owner = findLifecycleOwner(chain, 'build', { check: false });
    assert.notEqual(owner, null);
    assert.equal(owner!.lifecycleCmd, './gradlew monorepoBuild');
    assert.deepEqual(owner!.tools, ['node']);
    assert.deepEqual(owner!.env, ['NPM_TOKEN']);
    assert.equal(owner!.isFallback, false);
  });

  it('returns undefined tools/env when the owner entry is shorthand', async () => {
    const chain = await findZbbChain(tmpRoot);
    const owner = findLifecycleOwner(chain, 'clean', { check: false });
    assert.equal(owner!.lifecycleCmd, './gradlew monorepoClean');
    assert.equal(owner!.tools, undefined);
    assert.equal(owner!.env, undefined);
  });

  it('still walks up across sub-manifests that lack the command', async () => {
    // packages/foo/zbb.yaml defines 'custom' but not 'build'. Walk-up
    // must reach tmpRoot for 'build' AND carry tmpRoot's gates.
    const chain = await findZbbChain(join(tmpRoot, 'packages/foo'));
    const owner = findLifecycleOwner(chain, 'build', { check: false });
    assert.equal(owner!.entry.dir, tmpRoot);
    assert.deepEqual(owner!.tools, ['node']);
    assert.deepEqual(owner!.env, ['NPM_TOKEN']);
  });
});

describe('resolveGateRegistry', () => {
  it('returns the lifecycle-owner manifest registry when the owner IS a stack manifest', async () => {
    const chain = await findZbbChain(tmpRoot);
    const reg = resolveGateRegistry(chain, tmpRoot);
    assert.notEqual(reg, null);
    assert.equal(reg!.manifestDir, tmpRoot);
    assert.ok(reg!.tools.node);
    assert.ok(reg!.tools.docker);
    assert.ok(reg!.envDecls.NPM_TOKEN);
  });

  it("returns the containing manifest when the owner is a nested sub-manifest", async () => {
    // packages/foo owns lifecycle.custom; resolveGateRegistry(chain,
    // packages/foo) must land on packages/foo's manifest (it has a
    // name). Verifies "closest-or-self" walk-up.
    const chain = await findZbbChain(join(tmpRoot, 'packages/foo'));
    const reg = resolveGateRegistry(chain, join(tmpRoot, 'packages/foo'));
    assert.notEqual(reg, null);
    assert.equal(reg!.manifestDir, join(tmpRoot, 'packages/foo'));
    // packages/foo has no tools: block → empty registry. Gate resolution
    // against this will error on `tools: [docker]` which is correct —
    // the user must declare tools at the stack manifest level.
    assert.deepEqual(reg!.tools, {});
  });

  it('returns null when no named manifest is reachable', async () => {
    // Fabricate an unnamed-only chain by rewriting the root.
    await writeFile(
      join(tmpRoot, 'zbb.yaml'),
      'monorepo:\n  sourceDirs: [src]\nlifecycle:\n  build: ./gradlew build\n',
      'utf-8',
    );
    await rm(join(tmpRoot, 'packages/foo/zbb.yaml'), { force: true });
    const chain = await findZbbChain(tmpRoot);
    assert.equal(resolveGateRegistry(chain, tmpRoot), null);
  });
});

describe('checkToolGates', () => {
  const registry: Record<string, ToolDefinition> = {
    pass: { check: "bash -c 'echo v1.2.3'", parse: 'v(\\S+)', version: '>=1.0.0' },
    fail: { check: "bash -c 'echo v0.1.0'", parse: 'v(\\S+)', version: '>=2.0.0' },
  };

  it('passes when registry entry satisfies version constraint', () => {
    const results = checkToolGates(['pass'], registry);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].version, '1.2.3');
  });

  it('fails when registry entry does not satisfy version constraint', () => {
    const results = checkToolGates(['fail'], registry);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error ?? '', /does not satisfy/);
  });

  it('fails hard when a referenced tool name is undefined in the registry', () => {
    const results = checkToolGates(['pass', 'ghost'], registry);
    assert.equal(results.length, 2);
    const ghost = results.find(r => r.tool === 'ghost');
    assert.ok(ghost);
    assert.equal(ghost!.ok, false);
    assert.match(ghost!.error ?? '', /not defined in the stack manifest/);
  });

  it('honors skipTools', () => {
    const results = checkToolGates(['pass', 'fail'], registry, ['fail']);
    assert.equal(results.length, 1);
    assert.equal(results[0].tool, 'pass');
  });
});

describe('checkEnvGates', () => {
  const envDecls: Record<string, EnvVarDeclaration> = {
    HAS_VALUE: { type: 'string' },
    EMPTY_VALUE: { type: 'string', source: 'env' },
  };
  const lookup = (name: string) => {
    if (name === 'HAS_VALUE') return 'real-value';
    if (name === 'EMPTY_VALUE') return '';
    return undefined;
  };

  it('passes when the value is non-empty', () => {
    const results: EnvGateResult[] = checkEnvGates(['HAS_VALUE'], envDecls, lookup);
    assert.equal(results[0].ok, true);
  });

  it('fails when the value is empty', () => {
    const results = checkEnvGates(['EMPTY_VALUE'], envDecls, lookup);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error ?? '', /empty or unresolved/);
    assert.match(results[0].error ?? '', /source: env/);
  });

  it('fails when the env var is not declared in the manifest', () => {
    const results = checkEnvGates(['GHOST_VAR'], envDecls, lookup);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error ?? '', /not declared in the stack manifest/);
  });

  it('returns one result per requested name in request order', () => {
    const results = checkEnvGates(
      ['HAS_VALUE', 'EMPTY_VALUE', 'GHOST_VAR'],
      envDecls,
      lookup,
    );
    assert.equal(results.length, 3);
    assert.equal(results[0].name, 'HAS_VALUE');
    assert.equal(results[1].name, 'EMPTY_VALUE');
    assert.equal(results[2].name, 'GHOST_VAR');
  });
});
