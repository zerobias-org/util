import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findZbbChain,
  findLifecycleOwner,
  findMonorepoRoot,
  findStackManifestOwner,
  findActiveStackInChain,
} from '../lib/config.js';

/**
 * Tests for the walk-up chain helpers in `config.ts`. These helpers
 * power the lifecycle dispatcher's "which zbb.yaml declares this
 * command?" resolution when running `zbb build` from a subdir of a
 * monorepo.
 *
 * Fixture shape:
 *   <tmpRoot>/
 *     package.json                           (workspaces = ["packages/*"])
 *     zbb.yaml                               (monorepo-root, has monorepo:
 *                                             block + lifecycle.build)
 *     packages/
 *       foo/
 *         package.json
 *         zbb.yaml                           (nested stack — name only,
 *                                             NO lifecycle.build; has
 *                                             lifecycle.start)
 *         nested/                            (empty subdir, no zbb.yaml)
 *       bar/
 *         package.json                       (workspace pkg, NO zbb.yaml)
 */

let tmpRoot: string;
let savedCwd: string;

before(async () => {
  savedCwd = process.cwd();
});

after(() => {
  process.chdir(savedCwd);
});

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'zbb-walkup-'));

  // Root zbb.yaml — monorepo root with lifecycle.build
  await writeFile(
    join(tmpRoot, 'zbb.yaml'),
    [
      'name: "@scope/root"',
      'version: "1.0.0"',
      'monorepo:',
      '  sourceDirs: [src]',
      'lifecycle:',
      '  build: ./gradlew monorepoBuild',
      '  test: ./gradlew monorepoTest',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    join(tmpRoot, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: ['packages/*'] }, null, 2),
    'utf-8',
  );

  // packages/foo — nested stack w/ name but no lifecycle.build
  await mkdir(join(tmpRoot, 'packages/foo/nested'), { recursive: true });
  await writeFile(
    join(tmpRoot, 'packages/foo/zbb.yaml'),
    [
      'name: "@scope/foo"',
      'version: "1.0.0"',
      'lifecycle:',
      '  start: echo start',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(
    join(tmpRoot, 'packages/foo/package.json'),
    JSON.stringify({ name: '@scope/foo' }, null, 2),
    'utf-8',
  );

  // packages/bar — pure npm workspace pkg, no zbb.yaml
  await mkdir(join(tmpRoot, 'packages/bar'), { recursive: true });
  await writeFile(
    join(tmpRoot, 'packages/bar/package.json'),
    JSON.stringify({ name: '@scope/bar' }, null, 2),
    'utf-8',
  );
});

afterEach(async () => {
  process.chdir(savedCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('findZbbChain', () => {
  it('returns a single-entry chain when starting at the monorepo root', async () => {
    const chain = await findZbbChain(tmpRoot);
    assert.equal(chain.length, 1);
    assert.equal(chain[0].dir, tmpRoot);
    assert.equal(chain[0].hasMonorepoBlock, true);
  });

  it('returns closest-first chain when starting in a nested stack dir', async () => {
    const chain = await findZbbChain(join(tmpRoot, 'packages/foo'));
    assert.equal(chain.length, 2);
    assert.equal(chain[0].dir, join(tmpRoot, 'packages/foo'));
    assert.equal(chain[0].hasMonorepoBlock, false);
    assert.equal(chain[1].dir, tmpRoot);
    assert.equal(chain[1].hasMonorepoBlock, true);
  });

  it('walks through subdirs without zbb.yaml and still finds ancestors', async () => {
    const chain = await findZbbChain(join(tmpRoot, 'packages/foo/nested'));
    // nested/ has no zbb.yaml, so the chain is [foo, root] — same as
    // starting at foo/.
    assert.equal(chain.length, 2);
    assert.equal(chain[0].dir, join(tmpRoot, 'packages/foo'));
    assert.equal(chain[1].dir, tmpRoot);
  });

  it('returns the monorepo root for a pure-npm pkg with no zbb.yaml', async () => {
    const chain = await findZbbChain(join(tmpRoot, 'packages/bar'));
    assert.equal(chain.length, 1);
    assert.equal(chain[0].dir, tmpRoot);
    assert.equal(chain[0].hasMonorepoBlock, true);
  });

  it('stops walking after the monorepo root (does not continue above it)', async () => {
    // Add a zbb.yaml in a synthetic parent ABOVE tmpRoot to test the
    // boundary. We can't do this directly (tmpRoot parent is /tmp), but
    // we can verify by asserting the chain has exactly ONE entry with
    // hasMonorepoBlock — the last one in the chain — and nothing after.
    const chain = await findZbbChain(join(tmpRoot, 'packages/foo'));
    const monorepoBlocks = chain.filter(e => e.hasMonorepoBlock);
    assert.equal(monorepoBlocks.length, 1);
    assert.equal(monorepoBlocks[0], chain[chain.length - 1]);
  });
});

describe('findMonorepoRoot', () => {
  it('returns the entry with monorepo: block', async () => {
    const chain = await findZbbChain(join(tmpRoot, 'packages/foo'));
    const root = findMonorepoRoot(chain);
    assert.notEqual(root, null);
    assert.equal(root!.dir, tmpRoot);
  });

  it('returns null for a chain with no monorepo: block', async () => {
    // Empty root zbb.yaml with no monorepo key
    await writeFile(
      join(tmpRoot, 'zbb.yaml'),
      'name: standalone\nversion: "1.0.0"\n',
      'utf-8',
    );
    const chain = await findZbbChain(tmpRoot);
    assert.equal(findMonorepoRoot(chain), null);
  });
});

describe('findLifecycleOwner', () => {
  it('picks the closest chain entry that defines the command', async () => {
    const chain = await findZbbChain(join(tmpRoot, 'packages/foo'));
    // foo/zbb.yaml defines `start` but not `build` — so `build` should
    // walk up and find root/zbb.yaml.
    const buildOwner = findLifecycleOwner(chain, 'build', { check: false });
    assert.notEqual(buildOwner, null);
    assert.equal(buildOwner!.entry.dir, tmpRoot);
    assert.equal(buildOwner!.lifecycleCmd, './gradlew monorepoBuild');
    assert.equal(buildOwner!.isFallback, false);

    // But `start` is defined in foo/zbb.yaml — should stop there.
    const startOwner = findLifecycleOwner(chain, 'start', { check: false });
    assert.notEqual(startOwner, null);
    assert.equal(startOwner!.entry.dir, join(tmpRoot, 'packages/foo'));
    assert.equal(startOwner!.lifecycleCmd, 'echo start');
  });

  it('returns fallback = true when no chain entry defines the command', async () => {
    const chain = await findZbbChain(join(tmpRoot, 'packages/foo'));
    // Neither foo nor root defines `dockerBuild` in this fixture.
    const owner = findLifecycleOwner(chain, 'dockerBuild', { check: false });
    assert.notEqual(owner, null);
    assert.equal(owner!.isFallback, true);
    assert.equal(owner!.lifecycleCmd, null);
    // Fallback entry is the outermost (monorepo root).
    assert.equal(owner!.entry.dir, tmpRoot);
  });

  it('looks up lifecycle.gateCheck when command=gate and parsed.check=true', async () => {
    // Add gateCheck to the root zbb.yaml
    await writeFile(
      join(tmpRoot, 'zbb.yaml'),
      [
        'name: "@scope/root"',
        'version: "1.0.0"',
        'monorepo:',
        '  sourceDirs: [src]',
        'lifecycle:',
        '  gate: ./gradlew monorepoGate',
        '  gateCheck: ./gradlew monorepoGateCheck',
        '',
      ].join('\n'),
      'utf-8',
    );
    const chain = await findZbbChain(tmpRoot);
    const checkOwner = findLifecycleOwner(chain, 'gate', { check: true });
    assert.equal(checkOwner!.lifecycleCmd, './gradlew monorepoGateCheck');
    const fullOwner = findLifecycleOwner(chain, 'gate', { check: false });
    assert.equal(fullOwner!.lifecycleCmd, './gradlew monorepoGate');
  });

  it('does NOT substitute lifecycle.gate when gateCheck is missing', async () => {
    // fixture root only has gate, not gateCheck — gateCheck lookup
    // should return fallback rather than silently running the full gate.
    await writeFile(
      join(tmpRoot, 'zbb.yaml'),
      [
        'name: "@scope/root"',
        'version: "1.0.0"',
        'monorepo:',
        '  sourceDirs: [src]',
        'lifecycle:',
        '  gate: ./gradlew monorepoGate',
        '',
      ].join('\n'),
      'utf-8',
    );
    const chain = await findZbbChain(tmpRoot);
    const checkOwner = findLifecycleOwner(chain, 'gate', { check: true });
    assert.equal(checkOwner!.isFallback, true);
    assert.equal(checkOwner!.lifecycleCmd, null);
  });

  it('returns null for an empty chain', () => {
    const owner = findLifecycleOwner([], 'build', { check: false });
    assert.equal(owner, null);
  });
});

describe('findStackManifestOwner', () => {
  it('returns the closest entry with a name field', async () => {
    const chain = await findZbbChain(join(tmpRoot, 'packages/foo'));
    const owner = findStackManifestOwner(chain);
    assert.notEqual(owner, null);
    // foo/zbb.yaml has `name: "@scope/foo"` — closest wins.
    assert.equal(owner!.dir, join(tmpRoot, 'packages/foo'));
    assert.equal((owner!.config as { name: string }).name, '@scope/foo');
  });

  it('returns null when no chain entry declares a name', async () => {
    // Remove names from both yamls
    await writeFile(
      join(tmpRoot, 'zbb.yaml'),
      'monorepo:\n  sourceDirs: [src]\nlifecycle:\n  build: ./gradlew build\n',
      'utf-8',
    );
    await writeFile(
      join(tmpRoot, 'packages/foo/zbb.yaml'),
      'lifecycle:\n  start: echo\n',
      'utf-8',
    );
    const chain = await findZbbChain(join(tmpRoot, 'packages/foo'));
    assert.equal(findStackManifestOwner(chain), null);
  });
});

describe('findActiveStackInChain', () => {
  it('returns the closest entry whose name matches an added stack', async () => {
    const chain = await findZbbChain(join(tmpRoot, 'packages/foo'));
    // Only the root is added (by short name 'root').
    const active = findActiveStackInChain(
      chain,
      new Set(['root']),
      new Set(['@scope/root']),
    );
    assert.notEqual(active, null);
    assert.equal(active!.dir, tmpRoot);
  });

  it('picks the sub-manifest when it IS added (stack > overlay)', async () => {
    // Both foo and root could be stacks; foo is closer and added.
    const chain = await findZbbChain(join(tmpRoot, 'packages/foo'));
    const active = findActiveStackInChain(
      chain,
      new Set(['foo', 'root']),
      new Set(['@scope/foo', '@scope/root']),
    );
    assert.equal(active!.dir, join(tmpRoot, 'packages/foo'));
  });

  it('walks past a named-but-not-added sub-manifest to the added ancestor', async () => {
    // foo has name: but is NOT in the added set. Walk up to root.
    const chain = await findZbbChain(join(tmpRoot, 'packages/foo'));
    const active = findActiveStackInChain(
      chain,
      new Set(['root']),
      new Set(['@scope/root']),
    );
    assert.equal(active!.dir, tmpRoot);
  });

  it('walks past an overlay: true entry even if it has a name and is in the set', async () => {
    // Mark foo as an overlay. Even if by accident its name matches an
    // added stack, the marker opts it out of stack-context resolution.
    await writeFile(
      join(tmpRoot, 'packages/foo/zbb.yaml'),
      [
        'name: "@scope/foo"',
        'version: "1.0.0"',
        'overlay: true',
        'lifecycle:',
        '  start: echo start',
        '',
      ].join('\n'),
      'utf-8',
    );
    const chain = await findZbbChain(join(tmpRoot, 'packages/foo'));
    const active = findActiveStackInChain(
      chain,
      new Set(['foo', 'root']),
      new Set(['@scope/foo', '@scope/root']),
    );
    // Skipped foo; resolved to root instead.
    assert.equal(active!.dir, tmpRoot);
  });

  it('returns null when no entry in the chain matches', async () => {
    const chain = await findZbbChain(join(tmpRoot, 'packages/foo'));
    const active = findActiveStackInChain(chain, new Set(['other']), new Set([]));
    assert.equal(active, null);
  });

  it('skips nameless overlay entries regardless of added set', async () => {
    // Make foo's zbb.yaml nameless.
    await writeFile(
      join(tmpRoot, 'packages/foo/zbb.yaml'),
      'lifecycle:\n  start: echo\n',
      'utf-8',
    );
    const chain = await findZbbChain(join(tmpRoot, 'packages/foo'));
    const active = findActiveStackInChain(
      chain,
      new Set(['root']),
      new Set(['@scope/root']),
    );
    assert.equal(active!.dir, tmpRoot);
  });
});
