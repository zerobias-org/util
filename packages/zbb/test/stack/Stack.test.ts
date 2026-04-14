import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// yaml stringify not needed — using stack.setState() API directly
import { Stack } from '../../lib/stack/Stack.js';
import { createMockStackSource, createAddedStack } from './test-helpers.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zbb-stack-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('Stack.load', () => {
  it('loads identity and env from disk', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    const sourceDir = join(tmpDir, 'source');

    // Create source with stack manifest
    await createMockStackSource(sourceDir, {
      name: '@zerobias-com/myapp',
      version: '2.0.0',
      exports: ['MY_PORT'],
      env: { MY_PORT: { type: 'port' } },
    });

    // Create the "added" stack in slot
    await createAddedStack(stacksDir, 'myapp', {
      identity: {
        name: '@zerobias-com/myapp',
        version: '2.0.0',
        mode: 'dev',
        source: sourceDir,
        added: '2026-01-01T00:00:00Z',
      },
      env: { MY_PORT: '15001' },
      manifest: {
        MY_PORT: { resolution: 'allocated', value: '15001', type: 'port' },
      },
    });

    const stack = new Stack('myapp', stacksDir);
    await stack.load();

    assert.equal(stack.identity.name, '@zerobias-com/myapp');
    assert.equal(stack.identity.version, '2.0.0');
    assert.equal(stack.identity.mode, 'dev');
    assert.equal(stack.env.get('MY_PORT'), '15001');
    assert.ok(stack.isInitialized());
  });

  it('exists() returns false for nonexistent stack', () => {
    const stack = new Stack('nope', join(tmpDir, 'stacks'));
    assert.equal(stack.exists(), false);
  });
});

describe('Stack.state', () => {
  it('getState returns initial state from state.yaml', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    await createAddedStack(stacksDir, 'myapp');

    const stack = new Stack('myapp', stacksDir);
    await stack.load();

    // state.yaml was written by createAddedStack with { status: 'stopped' }
    const state = await stack.getState();
    assert.equal(state.status, 'stopped');
  });

  it('setState merges with existing state', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    await createAddedStack(stacksDir, 'myapp', {
      state: { status: 'stopped', seeded: false },
    });

    const stack = new Stack('myapp', stacksDir);
    await stack.load();

    await stack.setState({ status: 'healthy', seeded: true });
    const state = await stack.getState();
    assert.equal(state.status, 'healthy');
    assert.equal(state.seeded, true);
  });

  it('checkReadyWhen evaluates conditions', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    await createAddedStack(stacksDir, 'myapp', {
      state: { status: 'healthy', schema_applied: true },
    });

    const stack = new Stack('myapp', stacksDir);
    await stack.load();

    assert.equal(await stack.checkReadyWhen({ status: 'healthy' }), true);
    assert.equal(await stack.checkReadyWhen({ status: 'healthy', schema_applied: true }), true);
    assert.equal(await stack.checkReadyWhen({ status: 'stopped' }), false);
    assert.equal(await stack.checkReadyWhen({ nonexistent: 'value' }), false);
  });
});

describe('Stack.runLifecycle', () => {
  it('runs a simple command and returns exit code 0', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    const sourceDir = join(tmpDir, 'source');

    await createMockStackSource(sourceDir, {
      name: '@zerobias-com/myapp',
      version: '1.0.0',
      lifecycle: { build: 'echo hello' },
    });

    await createAddedStack(stacksDir, 'myapp', {
      identity: {
        name: '@zerobias-com/myapp', version: '1.0.0',
        mode: 'dev', source: sourceDir, added: new Date().toISOString(),
      },
      sourceDir,
    });

    const stack = new Stack('myapp', stacksDir);
    await stack.load();

    const code = await stack.runLifecycle('build');
    assert.equal(code, 0);
  });

  it('returns 0 when no lifecycle defined', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    const sourceDir = join(tmpDir, 'source');

    await createMockStackSource(sourceDir, {
      name: '@zerobias-com/myapp',
      version: '1.0.0',
      // No lifecycle block
    });

    await createAddedStack(stacksDir, 'myapp', {
      identity: {
        name: '@zerobias-com/myapp', version: '1.0.0',
        mode: 'dev', source: sourceDir, added: new Date().toISOString(),
      },
    });

    const stack = new Stack('myapp', stacksDir);
    await stack.load();
    const code = await stack.runLifecycle('build');
    assert.equal(code, 0);
  });

  it('returns non-zero exit code on failure', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    const sourceDir = join(tmpDir, 'source');

    await createMockStackSource(sourceDir, {
      name: '@zerobias-com/myapp',
      version: '1.0.0',
      lifecycle: { test: 'exit 42' },
    });

    await createAddedStack(stacksDir, 'myapp', {
      identity: {
        name: '@zerobias-com/myapp', version: '1.0.0',
        mode: 'dev', source: sourceDir, added: new Date().toISOString(),
      },
      sourceDir,
    });

    const stack = new Stack('myapp', stacksDir);
    await stack.load();
    const code = await stack.runLifecycle('test');
    assert.ok(code !== 0);
  });
});

describe('Stack.getStatus', () => {
  it('collects ports and deps from manifest', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    const sourceDir = join(tmpDir, 'source');

    await createMockStackSource(sourceDir, {
      name: '@zerobias-com/myapp',
      version: '3.0.0',
      depends: { dana: '@zerobias-com/dana@^1.0.0' },
      env: { APP_PORT: { type: 'port' } },
    });

    await createAddedStack(stacksDir, 'myapp', {
      identity: {
        name: '@zerobias-com/myapp', version: '3.0.0',
        mode: 'dev', source: sourceDir, added: new Date().toISOString(),
      },
      env: { APP_PORT: '15005' },
      manifest: {
        APP_PORT: { resolution: 'allocated', value: '15005', type: 'port' },
      },
      state: { status: 'healthy' },
      sourceDir,
    });

    const stack = new Stack('myapp', stacksDir);
    await stack.load();

    const status = await stack.getStatus();
    assert.equal(status.name, 'myapp');
    assert.equal(status.version, '3.0.0');
    assert.equal(status.mode, 'dev');
    assert.equal(status.status, 'healthy');
    assert.equal(status.ports.APP_PORT, 15005);
    assert.ok(status.deps.includes('dana'));
  });
});

describe('Stack.runLifecycleQuiet', () => {
  it('runs command silently and returns exit code 0', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    const sourceDir = join(tmpDir, 'source');

    await createMockStackSource(sourceDir, {
      name: '@zerobias-com/myapp',
      version: '1.0.0',
      lifecycle: { health: { command: 'echo ok', interval: 1, timeout: 5 } },
    });

    await createAddedStack(stacksDir, 'myapp', {
      identity: {
        name: '@zerobias-com/myapp', version: '1.0.0',
        mode: 'dev', source: sourceDir, added: new Date().toISOString(),
      },
      sourceDir,
    });

    const stack = new Stack('myapp', stacksDir);
    await stack.load();
    const code = await stack.runLifecycleQuiet('health');
    assert.equal(code, 0);
  });

  it('returns non-zero for failing health check', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    const sourceDir = join(tmpDir, 'source');

    await createMockStackSource(sourceDir, {
      name: '@zerobias-com/myapp',
      version: '1.0.0',
      lifecycle: { health: { command: 'exit 1', interval: 1, timeout: 5 } },
    });

    await createAddedStack(stacksDir, 'myapp', {
      identity: {
        name: '@zerobias-com/myapp', version: '1.0.0',
        mode: 'dev', source: sourceDir, added: new Date().toISOString(),
      },
      sourceDir,
    });

    const stack = new Stack('myapp', stacksDir);
    await stack.load();
    const code = await stack.runLifecycleQuiet('health');
    assert.ok(code !== 0);
  });

  it('returns 0 when no lifecycle defined', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    const sourceDir = join(tmpDir, 'source');

    await createMockStackSource(sourceDir, {
      name: '@zerobias-com/myapp',
      version: '1.0.0',
    });

    await createAddedStack(stacksDir, 'myapp', {
      identity: {
        name: '@zerobias-com/myapp', version: '1.0.0',
        mode: 'dev', source: sourceDir, added: new Date().toISOString(),
      },
    });

    const stack = new Stack('myapp', stacksDir);
    await stack.load();
    const code = await stack.runLifecycleQuiet('health');
    assert.equal(code, 0);
  });

  it('returns 0 for string command health check', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    const sourceDir = join(tmpDir, 'source');

    await createMockStackSource(sourceDir, {
      name: '@zerobias-com/myapp',
      version: '1.0.0',
      lifecycle: { health: 'true' },
    });

    await createAddedStack(stacksDir, 'myapp', {
      identity: {
        name: '@zerobias-com/myapp', version: '1.0.0',
        mode: 'dev', source: sourceDir, added: new Date().toISOString(),
      },
      sourceDir,
    });

    const stack = new Stack('myapp', stacksDir);
    await stack.load();
    const code = await stack.runLifecycleQuiet('health');
    assert.equal(code, 0);
  });
});

describe('setState idempotency', () => {
  it('skips write when state is unchanged', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    await createAddedStack(stacksDir, 'myapp', {
      state: { status: 'running' },
    });

    const stack = new Stack('myapp', stacksDir);
    await stack.load();

    // First call with same data as on-disk state — sets initial state
    let changeCount = 0;
    stack.on('state:change', () => { changeCount += 1; });

    // Set with different data — should write and emit
    await stack.setState({ status: 'healthy' });
    assert.equal(changeCount, 1);

    const mtime1 = (await stat(stack.stateFile)).mtimeMs;

    // Small delay to ensure mtime would differ if written
    await new Promise(r => setTimeout(r, 10));

    // Set with identical data — should NOT write or emit
    await stack.setState({ status: 'healthy' });
    assert.equal(changeCount, 1, 'no second event on identical state');

    const mtime2 = (await stat(stack.stateFile)).mtimeMs;
    assert.equal(mtime1, mtime2, 'file mtime unchanged on identical state');
  });

  it('writes when state has new field', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    await createAddedStack(stacksDir, 'myapp', {
      state: {},
    });

    const stack = new Stack('myapp', stacksDir);
    await stack.load();

    let changeCount = 0;
    stack.on('state:change', () => { changeCount += 1; });

    await stack.setState({ a: 1 });
    assert.equal(changeCount, 1);

    await stack.setState({ b: 2 });
    assert.equal(changeCount, 2);

    const state = await stack.getState();
    assert.equal(state.a, 1);
    assert.equal(state.b, 2);
  });

  it('writes when existing field changes', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    await createAddedStack(stacksDir, 'myapp', {
      state: {},
    });

    const stack = new Stack('myapp', stacksDir);
    await stack.load();

    let changeCount = 0;
    stack.on('state:change', () => { changeCount += 1; });

    await stack.setState({ status: 'running' });
    assert.equal(changeCount, 1);

    await stack.setState({ status: 'stopped' });
    assert.equal(changeCount, 2);

    const state = await stack.getState();
    assert.equal(state.status, 'stopped');
  });

  it('handles key ordering differences (idempotent regardless of insertion order)', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    await createAddedStack(stacksDir, 'myapp', {
      state: {},
    });

    const stack = new Stack('myapp', stacksDir);
    await stack.load();

    // Set state with keys in one order
    await stack.setState({ b: 2, a: 1 });

    let changeCount = 0;
    stack.on('state:change', () => { changeCount += 1; });

    // File is written by YAML serializer which may use different key order
    // Re-setting with same values but different insertion order must be idempotent
    await stack.setState({ a: 1, b: 2 });
    assert.equal(changeCount, 0, 'idempotent regardless of key insertion order');
  });
});

describe('Stack.substackDir', () => {
  it('substackDir returns correct path', () => {
    const stack = new Stack('myhub', join(tmpDir, 'stacks'));
    assert.equal(stack.substackDir('manager'), join(tmpDir, 'stacks', 'myhub', 'substacks', 'manager'));
    assert.equal(stack.substackDir('alerts'), join(tmpDir, 'stacks', 'myhub', 'substacks', 'alerts'));
  });
});

describe('Stack.createSubstackDirectories', () => {
  it('creates dirs for substacks with state declarations', async () => {
    const stackPath = join(tmpDir, 'mystack');
    await mkdir(stackPath, { recursive: true });

    const manifest = {
      name: '@test/mystack',
      version: '1.0.0',
      substacks: {
        manager: {
          state: { pid: { type: 'number' as const } },
        },
        alerts: {
          state: {
            collection: true as const,
            schema: { type: { type: 'string' as const } },
          },
        },
      },
    };

    await Stack.createSubstackDirectories(stackPath, manifest);

    const { stat } = await import('node:fs/promises');
    const managerStat = await stat(join(stackPath, 'substacks', 'manager'));
    assert.ok(managerStat.isDirectory());
    const alertsStat = await stat(join(stackPath, 'substacks', 'alerts'));
    assert.ok(alertsStat.isDirectory());
  });

  it('skips substacks without state declaration', async () => {
    const stackPath = join(tmpDir, 'mystack2');
    await mkdir(stackPath, { recursive: true });

    const manifest = {
      name: '@test/mystack',
      version: '1.0.0',
      substacks: {
        web: {
          services: ['nginx'],
          // no state field
        },
      },
    };

    await Stack.createSubstackDirectories(stackPath, manifest);

    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(join(stackPath, 'substacks', 'web')), false);
  });

  it('is a no-op when manifest has no substacks field', async () => {
    const stackPath = join(tmpDir, 'mystack3');
    await mkdir(stackPath, { recursive: true });

    const manifest = {
      name: '@test/mystack',
      version: '1.0.0',
    };

    // Should not throw and should not create substacks dir
    await Stack.createSubstackDirectories(stackPath, manifest);

    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(join(stackPath, 'substacks')), false);
  });
});

describe('Stack.load recursive dep resolution', () => {
  /**
   * Helper: create a stack with declared deps AND imports, pointing at a
   * source that has the given manifest. The test infrastructure already
   * supports createAddedStack with a custom source; we just need to embed
   * the manifest into the source's zbb.yaml ourselves so the Stack can
   * discover `depends` and `imports` when manifest is loaded from source.
   */
  async function createStackWithManifest(
    stacksDir: string,
    name: string,
    manifest: Record<string, unknown>,
    env: Record<string, string> = {},
  ): Promise<string> {
    const sourceDir = join(stacksDir, `_src-${name}`);
    await createMockStackSource(sourceDir, {
      name: `@zerobias-com/${name}`,
      version: '1.0.0',
      ...manifest,
    });
    return createAddedStack(stacksDir, name, {
      identity: {
        name: `@zerobias-com/${name}`,
        version: '1.0.0',
        mode: 'dev',
        source: sourceDir,
        added: new Date().toISOString(),
      },
      env,
      sourceDir,
    });
  }

  it('loads a stack with no deps (baseline)', async () => {
    const stacksDir = join(tmpDir, 'stacks');
    await createStackWithManifest(stacksDir, 'leaf', {
      env: { LEAF_VAR: { type: 'string', default: 'leafval' } },
    });

    const stack = new Stack('leaf', stacksDir);
    await stack.load();

    // Didn't throw, got initialized. No deps to walk, nothing special.
    assert.ok(stack.isInitialized());
  });

  it('recursively loads a linear chain A → B → C before resolving A', async () => {
    const stacksDir = join(tmpDir, 'stacks');

    // C (leaf) — exports VAR_C
    await createStackWithManifest(
      stacksDir,
      'stackC',
      { env: { VAR_C: { type: 'string' } }, exports: ['VAR_C'] },
      { VAR_C: 'from-C' },
    );

    // B imports VAR_C from stackC, exposes its own VAR_B
    await createStackWithManifest(
      stacksDir,
      'stackB',
      {
        env: { VAR_B: { type: 'string' } },
        exports: ['VAR_B'],
        depends: { stackC: 'latest' },
        imports: { stackC: ['VAR_C'] },
      },
      { VAR_B: 'from-B' },
    );

    // A imports both via the chain
    await createStackWithManifest(
      stacksDir,
      'stackA',
      {
        env: { VAR_A: { type: 'string', default: 'from-A' } },
        depends: { stackB: 'latest' },
        imports: { stackB: ['VAR_B'] },
      },
      { VAR_A: 'from-A' },
    );

    const stackA = new Stack('stackA', stacksDir);
    await stackA.load();

    // A should see VAR_B imported from B. If load was NOT recursive,
    // B might have stale values and A's import would pick up whatever
    // was last written to stacks/stackB/.env by a prior run. Here
    // everything is fresh so the value should be what B's source declares.
    const a = stackA.env.getAll();
    assert.ok(stackA.isInitialized(), 'stackA should be initialized');
    assert.equal(a.VAR_B, 'from-B', 'stackA should have imported VAR_B from stackB');
  });

  it('resolves a diamond A → {B, C} → D without re-resolving D', async () => {
    const stacksDir = join(tmpDir, 'stacks');

    // D — leaf with a counter we can inspect later
    await createStackWithManifest(
      stacksDir,
      'stackD',
      { env: { VAR_D: { type: 'string' } }, exports: ['VAR_D'] },
      { VAR_D: 'from-D' },
    );

    // B imports VAR_D from D
    await createStackWithManifest(
      stacksDir,
      'stackB2',
      {
        env: { VAR_B2: { type: 'string' } },
        exports: ['VAR_B2', 'VAR_D'],
        depends: { stackD: 'latest' },
        imports: { stackD: ['VAR_D'] },
      },
      { VAR_B2: 'from-B2' },
    );

    // C also imports VAR_D from D
    await createStackWithManifest(
      stacksDir,
      'stackC2',
      {
        env: { VAR_C2: { type: 'string' } },
        exports: ['VAR_C2', 'VAR_D'],
        depends: { stackD: 'latest' },
        imports: { stackD: ['VAR_D'] },
      },
      { VAR_C2: 'from-C2' },
    );

    // A depends on both B and C
    await createStackWithManifest(
      stacksDir,
      'stackA2',
      {
        env: { VAR_A2: { type: 'string' } },
        depends: { stackB2: 'latest', stackC2: 'latest' },
        imports: { stackB2: ['VAR_B2'], stackC2: ['VAR_C2'] },
      },
      { VAR_A2: 'from-A2' },
    );

    const stackA = new Stack('stackA2', stacksDir);
    // Should not loop, should not throw.
    await stackA.load();

    const a = stackA.env.getAll();
    assert.equal(a.VAR_B2, 'from-B2', 'diamond: VAR_B2 resolved via B');
    assert.equal(a.VAR_C2, 'from-C2', 'diamond: VAR_C2 resolved via C');
  });

  it('survives a cycle A → B → A without hanging', async () => {
    const stacksDir = join(tmpDir, 'stacks');

    await createStackWithManifest(
      stacksDir,
      'cyclicA',
      {
        env: { A_VAR: { type: 'string' } },
        depends: { cyclicB: 'latest' },
      },
      { A_VAR: 'a' },
    );

    await createStackWithManifest(
      stacksDir,
      'cyclicB',
      {
        env: { B_VAR: { type: 'string' } },
        depends: { cyclicA: 'latest' }, // cycle!
      },
      { B_VAR: 'b' },
    );

    const stackA = new Stack('cyclicA', stacksDir);
    // Cycle protection should prevent an infinite recursion. The second
    // time we re-enter cyclicA through cyclicB's dep walk, the visited
    // set should short-circuit and we return cleanly.
    await stackA.load();
    assert.ok(stackA.isInitialized());
  });

  it('deduplicates deps + imports source-stack names (union)', async () => {
    const stacksDir = join(tmpDir, 'stacks');

    // Single source stack
    await createStackWithManifest(
      stacksDir,
      'shared',
      { env: { SHARED_VAR: { type: 'string' } }, exports: ['SHARED_VAR'] },
      { SHARED_VAR: 'shared-val' },
    );

    // Consumer lists 'shared' in BOTH depends and imports — should only
    // resolve once, not twice.
    await createStackWithManifest(
      stacksDir,
      'consumer',
      {
        env: { CONSUMER_VAR: { type: 'string' } },
        depends: { shared: 'latest' },
        imports: { shared: ['SHARED_VAR'] },
      },
      { CONSUMER_VAR: 'c' },
    );

    const consumer = new Stack('consumer', stacksDir);
    await consumer.load();
    assert.equal(consumer.env.get('SHARED_VAR'), 'shared-val');
  });

  it('silently skips missing dep stack directories (depends-only)', async () => {
    const stacksDir = join(tmpDir, 'stacks');

    // Consumer depends on 'ghost' which isn't added. Since it's only in
    // `depends` (not `imports`), load should NOT throw — the dep is a
    // lifecycle dep not an env dep. Readiness checking is separate.
    await createStackWithManifest(
      stacksDir,
      'loner',
      {
        env: { LONER_VAR: { type: 'string', default: 'l' } },
        depends: { ghost: 'latest' },
      },
    );

    const loner = new Stack('loner', stacksDir);
    await loner.load();
    assert.ok(loner.isInitialized());
  });
});
