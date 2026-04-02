import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { parse as yamlParse } from 'yaml';
import { Slot } from '../slot/Slot.js';
import { StackManager } from './StackManager.js';
import { createTestSlot, createMockStackSource, createAddedStack } from './test-helpers.js';

let tmpDir: string;
let slotsDir: string;
let slotDir: string;
let slot: Slot;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zbb-mgr-'));
  slotsDir = tmpDir;
  slotDir = join(slotsDir, 'test-slot');
  await createTestSlot(slotDir);
  slot = new Slot('test-slot', slotsDir);
  await slot.load();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('StackManager.add', () => {
  it('adds a stack from source dir', async () => {
    const sourceDir = join(tmpDir, 'src-dana');
    await createMockStackSource(sourceDir, {
      name: '@zerobias-com/dana',
      version: '1.0.0',
      exports: ['DANA_PORT', 'DANA_URL'],
      env: {
        DANA_PORT: { type: 'port', description: 'Dana port' },
        DANA_URL: { type: 'string', value: 'http://localhost:${DANA_PORT}' },
        LOG_LEVEL: { type: 'string', default: 'info' },
      },
    });

    const mgr = new StackManager(slot);
    const stack = await mgr.add(sourceDir);

    assert.equal(stack.name, 'dana');
    assert.equal(stack.identity.name, '@zerobias-com/dana');
    assert.equal(stack.identity.mode, 'dev');

    // Verify files on disk
    assert.ok(existsSync(join(slotDir, 'stacks', 'dana', 'stack.yaml')));
    assert.ok(existsSync(join(slotDir, 'stacks', 'dana', 'manifest.yaml')));
    assert.ok(existsSync(join(slotDir, 'stacks', 'dana', '.env')));
    assert.ok(existsSync(join(slotDir, 'stacks', 'dana', 'state.yaml')));

    // Verify port allocated
    const port = stack.env.get('DANA_PORT');
    assert.ok(port);
    const portNum = parseInt(port, 10);
    assert.ok(portNum >= 15000 && portNum <= 15099);

    // Verify derived URL resolved
    assert.equal(stack.env.get('DANA_URL'), `http://localhost:${port}`);

    // Verify default frozen
    assert.equal(stack.env.get('LOG_LEVEL'), 'info');

    // Verify state
    const stateRaw = await readFile(join(slotDir, 'stacks', 'dana', 'state.yaml'), 'utf-8');
    const state = yamlParse(stateRaw);
    assert.equal(state.status, 'stopped');
  });

  it('uses --as alias for stack name', async () => {
    const sourceDir = join(tmpDir, 'src-dana');
    await createMockStackSource(sourceDir, {
      name: '@zerobias-com/dana',
      version: '1.0.0',
    });

    const mgr = new StackManager(slot);
    const stack = await mgr.add(sourceDir, { as: 'dana-2' });

    assert.equal(stack.name, 'dana-2');
    assert.ok(existsSync(join(slotDir, 'stacks', 'dana-2', 'stack.yaml')));
    assert.equal(stack.identity.alias, 'dana-2');
  });

  it('throws on duplicate stack name', async () => {
    const sourceDir = join(tmpDir, 'src-dana');
    await createMockStackSource(sourceDir, {
      name: '@zerobias-com/dana',
      version: '1.0.0',
    });

    const mgr = new StackManager(slot);
    await mgr.add(sourceDir);

    await assert.rejects(
      () => mgr.add(sourceDir),
      /already exists/,
    );
  });

  it('throws when dependency cannot be auto-resolved from registry', async () => {
    const sourceDir = join(tmpDir, 'src-hub');
    await createMockStackSource(sourceDir, {
      name: '@zerobias-com/hub',
      version: '1.0.0',
      depends: { dana: '@nonexistent-test-scope/dana-fake@^99.0.0' },
    });

    const mgr = new StackManager(slot);
    await assert.rejects(
      () => mgr.add(sourceDir),
      /Failed to auto-resolve dependency 'dana'/,
    );
  });

  it('allocates non-colliding ports across stacks', async () => {
    const src1 = join(tmpDir, 'src-a');
    await createMockStackSource(src1, {
      name: '@test/a',
      version: '1.0.0',
      env: { PORT_A: { type: 'port' } },
    });

    const src2 = join(tmpDir, 'src-b');
    await createMockStackSource(src2, {
      name: '@test/b',
      version: '1.0.0',
      env: { PORT_B: { type: 'port' } },
    });

    const mgr = new StackManager(slot);
    const stackA = await mgr.add(src1);
    const stackB = await mgr.add(src2);

    const portA = parseInt(stackA.env.get('PORT_A')!, 10);
    const portB = parseInt(stackB.env.get('PORT_B')!, 10);
    assert.notEqual(portA, portB);
    assert.ok(portA >= 15000 && portA <= 15099);
    assert.ok(portB >= 15000 && portB <= 15099);
  });
});

describe('StackManager.list', () => {
  it('lists added stacks', async () => {
    const src1 = join(tmpDir, 'src-a');
    await createMockStackSource(src1, { name: '@test/a', version: '1.0.0' });
    const src2 = join(tmpDir, 'src-b');
    await createMockStackSource(src2, { name: '@test/b', version: '1.0.0' });

    const mgr = new StackManager(slot);
    await mgr.add(src1);
    await mgr.add(src2);

    const stacks = await mgr.list();
    const names = stacks.map(s => s.name).sort();
    assert.deepEqual(names, ['a', 'b']);
  });

  it('returns empty list when no stacks', async () => {
    const mgr = new StackManager(slot);
    const stacks = await mgr.list();
    assert.equal(stacks.length, 0);
  });
});

describe('StackManager.remove', () => {
  it('removes stack directory', async () => {
    const sourceDir = join(tmpDir, 'src-dana');
    await createMockStackSource(sourceDir, {
      name: '@zerobias-com/dana',
      version: '1.0.0',
    });

    const mgr = new StackManager(slot);
    await mgr.add(sourceDir);
    assert.ok(existsSync(join(slotDir, 'stacks', 'dana')));

    await mgr.remove('dana');
    assert.ok(!existsSync(join(slotDir, 'stacks', 'dana')));
  });

  it('throws for nonexistent stack', async () => {
    const mgr = new StackManager(slot);
    await assert.rejects(
      () => mgr.remove('nope'),
      /not found/,
    );
  });
});

describe('StackManager.resolveImports', () => {
  it('parses bare imports', () => {
    const mgr = new StackManager(slot);
    const imports = mgr.resolveImports({
      name: '@test/x', version: '1.0.0',
      imports: { dana: ['DANA_URL', 'DANA_PORT'] },
    });
    assert.equal(imports.length, 2);
    assert.equal(imports[0].varName, 'DANA_URL');
    assert.equal(imports[0].fromStack, 'dana');
    assert.equal(imports[0].alias, undefined);
  });

  it('parses "VAR as ALIAS" syntax', () => {
    const mgr = new StackManager(slot);
    const imports = mgr.resolveImports({
      name: '@test/x', version: '1.0.0',
      imports: { dana: ['DANA_URL as PROXY_URL'] },
    });
    assert.equal(imports.length, 1);
    assert.equal(imports[0].varName, 'DANA_URL');
    assert.equal(imports[0].alias, 'PROXY_URL');
    assert.equal(imports[0].fromStack, 'dana');
  });
});

describe('StackManager.getStartOrder', () => {
  it('returns deps before target', async () => {
    const srcA = join(tmpDir, 'src-a');
    await createMockStackSource(srcA, { name: '@test/a', version: '1.0.0' });

    const srcB = join(tmpDir, 'src-b');
    await createMockStackSource(srcB, {
      name: '@test/b',
      version: '1.0.0',
      depends: { a: '@test/a@^1.0.0' },
    });

    const mgr = new StackManager(slot);
    await mgr.add(srcA);
    await mgr.add(srcB);

    const order = await mgr.getStartOrder('b');
    assert.deepEqual(order, ['a', 'b']);
  });

  it('detects circular dependencies', async () => {
    // Manually create two stacks that depend on each other
    const srcA = join(tmpDir, 'src-a');
    await createMockStackSource(srcA, {
      name: '@test/a', version: '1.0.0',
      depends: { b: '@test/b@^1.0.0' },
    });
    const srcB = join(tmpDir, 'src-b');
    await createMockStackSource(srcB, {
      name: '@test/b', version: '1.0.0',
      depends: { a: '@test/a@^1.0.0' },
    });

    // Manually create both (bypassing dep validation)
    await createAddedStack(join(slotDir, 'stacks'), 'a', { sourceDir: srcA });
    await createAddedStack(join(slotDir, 'stacks'), 'b', { sourceDir: srcB });

    const mgr = new StackManager(slot);
    await assert.rejects(
      () => mgr.getStartOrder('a'),
      /Circular dependency/,
    );
  });
});
