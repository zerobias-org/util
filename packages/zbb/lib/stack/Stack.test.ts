import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as yamlStringify } from 'yaml';
import { Stack } from './Stack.js';
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
  it('getState returns empty object when no state file', async () => {
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
