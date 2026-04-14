import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SlotEnvironment, isSlotLevelVar, ZBB_SLOT_VARS } from '../../lib/slot/SlotEnvironment.js';

describe('SlotEnvironment.registerResolver', () => {
  let tmpDir: string;
  let slotDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'zbb-resolver-test-'));
    slotDir = join(tmpDir, 'test-slot');
    await mkdir(slotDir, { recursive: true });
    SlotEnvironment.clearResolvers();
  });

  afterEach(async () => {
    SlotEnvironment.clearResolvers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('stores resolver and get() invokes it when key not in declared/overrides', async () => {
    SlotEnvironment.registerResolver('MY_VAR', (_env) => 'computed');

    await writeFile(join(slotDir, '.env'), 'OTHER=hello\n', 'utf-8');
    const env = new SlotEnvironment(slotDir);
    await env.load();

    assert.equal(env.get('MY_VAR'), 'computed');
  });

  it('declared values take precedence over resolver', async () => {
    SlotEnvironment.registerResolver('MY_VAR', (_env) => 'from-resolver');

    await writeFile(join(slotDir, '.env'), 'MY_VAR=declared\n', 'utf-8');
    const env = new SlotEnvironment(slotDir);
    await env.load();

    assert.equal(env.get('MY_VAR'), 'declared');
  });

  it('override values take precedence over resolver', async () => {
    SlotEnvironment.registerResolver('MY_VAR', (_env) => 'from-resolver');

    await writeFile(join(slotDir, '.env'), '', 'utf-8');
    await writeFile(join(slotDir, 'overrides.env'), 'MY_VAR=overridden\n', 'utf-8');
    const env = new SlotEnvironment(slotDir);
    await env.load();

    assert.equal(env.get('MY_VAR'), 'overridden');
  });

  it('resolver receives SlotEnvironment instance and can read other vars', async () => {
    SlotEnvironment.registerResolver('WEBSOCKET_URL', (env) => {
      const port = env.get('HUB_SERVER_PORT');
      return port ? `ws://localhost:${port}` : undefined;
    });

    await writeFile(join(slotDir, '.env'), 'HUB_SERVER_PORT=9090\n', 'utf-8');
    const env = new SlotEnvironment(slotDir);
    await env.load();

    assert.equal(env.get('WEBSOCKET_URL'), 'ws://localhost:9090');
  });

  it('registerResolver called twice for same key overwrites first resolver', async () => {
    SlotEnvironment.registerResolver('MY_VAR', (_env) => 'first');
    SlotEnvironment.registerResolver('MY_VAR', (_env) => 'second');

    await writeFile(join(slotDir, '.env'), '', 'utf-8');
    const env = new SlotEnvironment(slotDir);
    await env.load();

    assert.equal(env.get('MY_VAR'), 'second');
  });

  it('get() returns undefined when no declared, no override, and no resolver', async () => {
    await writeFile(join(slotDir, '.env'), '', 'utf-8');
    const env = new SlotEnvironment(slotDir);
    await env.load();

    assert.equal(env.get('NONEXISTENT'), undefined);
  });

  it('clearResolvers() resets the resolver map', async () => {
    SlotEnvironment.registerResolver('MY_VAR', (_env) => 'computed');
    SlotEnvironment.clearResolvers();

    await writeFile(join(slotDir, '.env'), '', 'utf-8');
    const env = new SlotEnvironment(slotDir);
    await env.load();

    assert.equal(env.get('MY_VAR'), undefined);
  });
});

describe('SlotEnvironment lockdown (zbb-only vars)', () => {
  let tmpDir: string;
  let slotDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'zbb-lockdown-'));
    slotDir = join(tmpDir, 'test-slot');
    await mkdir(slotDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('isSlotLevelVar reports ZBB_SLOT_VARS as slot-level and others as not', () => {
    assert.ok(isSlotLevelVar('ZB_SLOT'));
    assert.ok(isSlotLevelVar('ZB_SLOT_DIR'));
    assert.ok(isSlotLevelVar('ZB_STACKS_DIR'));
    assert.ok(!isSlotLevelVar('ZB_STACK'), 'ZB_STACK is stack-scoped, not slot-level');
    assert.ok(!isSlotLevelVar('STACK_NAME'), 'STACK_NAME was removed — ZB_STACK is the only stack identifier');
    assert.ok(!isSlotLevelVar('AWS_ACCESS_KEY_ID'));
    assert.ok(!isSlotLevelVar('PGHOST'));
    assert.ok(!isSlotLevelVar('MY_CUSTOM_VAR'));
  });

  it('getAll() filters a polluted .env to only return zbb-level vars', async () => {
    // Simulate an old, polluted slot: declared .env has stack-owned vars
    // (AWS_*, PG*) alongside the legitimate ZB_* vars.
    await writeFile(
      join(slotDir, '.env'),
      [
        'ZB_SLOT=local',
        'ZB_SLOT_DIR=/home/x/.zbb/slots/local',
        'AWS_ACCESS_KEY_ID=AKIA_LEGACY',
        'AWS_SECRET_ACCESS_KEY=sekret',
        'PGHOST=localhost',
        'DANA_PORT=15002',
      ].join('\n') + '\n',
      'utf-8',
    );

    const env = new SlotEnvironment(slotDir);
    await env.load();

    const all = env.getAll();
    assert.equal(all.ZB_SLOT, 'local');
    assert.equal(all.ZB_SLOT_DIR, '/home/x/.zbb/slots/local');
    assert.equal(all.AWS_ACCESS_KEY_ID, undefined, 'polluted AWS var filtered out');
    assert.equal(all.AWS_SECRET_ACCESS_KEY, undefined, 'polluted AWS secret filtered out');
    assert.equal(all.PGHOST, undefined, 'polluted PG var filtered out');
    assert.equal(all.DANA_PORT, undefined, 'polluted DANA_PORT filtered out');
  });

  it('getAll() also filters polluted overrides.env', async () => {
    await writeFile(join(slotDir, '.env'), 'ZB_SLOT=local\n', 'utf-8');
    await writeFile(
      join(slotDir, 'overrides.env'),
      'AWS_ACCESS_KEY_ID=AKIA_BAD\nZB_SLOT_DIR=/home/x/.zbb/slots/local\n',
      'utf-8',
    );

    const env = new SlotEnvironment(slotDir);
    await env.load();

    const all = env.getAll();
    assert.equal(all.ZB_SLOT_DIR, '/home/x/.zbb/slots/local', 'ZB_SLOT_DIR is slot-level, should appear');
    assert.equal(all.AWS_ACCESS_KEY_ID, undefined, 'polluted override filtered');
  });

  it('set() throws when trying to set a non-slot-level var', async () => {
    await writeFile(join(slotDir, '.env'), 'ZB_SLOT=local\n', 'utf-8');
    const env = new SlotEnvironment(slotDir);
    await env.load();

    await assert.rejects(
      () => env.set('AWS_ACCESS_KEY_ID', 'evil'),
      (e: Error) => /AWS_ACCESS_KEY_ID/.test(e.message) && /stack\.env\.set/.test(e.message),
    );
    await assert.rejects(
      () => env.set('PGHOST', 'otherhost'),
      (e: Error) => /PGHOST/.test(e.message),
    );
  });

  it('set() succeeds for legitimate slot-level vars (ZB_SLOT_DIR)', async () => {
    await writeFile(join(slotDir, '.env'), 'ZB_SLOT=local\n', 'utf-8');
    await writeFile(join(slotDir, 'overrides.env'), '', 'utf-8');
    const env = new SlotEnvironment(slotDir);
    await env.load();

    await env.set('ZB_SLOT_DIR', '/tmp/relocated');
    assert.equal(env.get('ZB_SLOT_DIR'), '/tmp/relocated');
  });

  it('set() throws when trying to set ZB_STACK (stack-scoped, not slot-level)', async () => {
    await writeFile(join(slotDir, '.env'), 'ZB_SLOT=local\n', 'utf-8');
    const env = new SlotEnvironment(slotDir);
    await env.load();
    await assert.rejects(
      () => env.set('ZB_STACK', 'file-service'),
      (e: Error) => /ZB_STACK/.test(e.message) && /stack\.env\.set/.test(e.message),
    );
  });

  it('writeOverrides() only serializes zbb-level vars to disk', async () => {
    // Set up a polluted overrides.env as the starting state
    await writeFile(join(slotDir, '.env'), 'ZB_SLOT=local\n', 'utf-8');
    await writeFile(
      join(slotDir, 'overrides.env'),
      'AWS_ACCESS_KEY_ID=leaked\nZB_SLOT_DIR=/tmp/orig\n',
      'utf-8',
    );

    const env = new SlotEnvironment(slotDir);
    await env.load();

    // A single legitimate set triggers writeOverrides(), which should
    // rewrite the file WITHOUT the non-zbb entry
    await env.set('ZB_SLOT_DIR', '/tmp/new');

    const rewritten = await readFile(join(slotDir, 'overrides.env'), 'utf-8');
    assert.ok(rewritten.includes('ZB_SLOT_DIR=/tmp/new'));
    assert.ok(!rewritten.includes('AWS_ACCESS_KEY_ID'), 'polluted var should not survive writeOverrides');
  });

  it('loading a polluted file succeeds without throwing', async () => {
    // Just verify backward-compat: reading an old slot doesn't blow up,
    // the non-zbb entries are simply ignored on reads.
    await writeFile(
      join(slotDir, '.env'),
      'ZB_SLOT=local\nAWS_ACCESS_KEY_ID=wrong\nPGHOST=x\n',
      'utf-8',
    );
    const env = new SlotEnvironment(slotDir);
    await env.load(); // should not throw
    assert.equal(env.getAll().ZB_SLOT, 'local');
  });
});

describe('prepareSlot-style composition (integration)', () => {
  /**
   * These tests exercise the exact composition logic `prepareSlot` in
   * cli.ts performs — SlotEnvironment.getAll() (filtered) + Stack.load()
   * (recursive) + merge. They catch the class of bug that bit us: a
   * polluted slot .env overriding a stack-imported value, or a missing
   * stack import causing the composed env to be silently empty.
   *
   * prepareSlot itself is private to cli.ts (because it mutates
   * process.env and handles vault refresh), so we test the building
   * blocks end-to-end in isolation.
   */
  let tmpDir: string;
  let slotDir: string;
  let stacksDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'zbb-compose-'));
    slotDir = join(tmpDir, 'slot');
    stacksDir = join(slotDir, 'stacks');
    await mkdir(stacksDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Replicates what `cli.ts prepareSlot` does with slot + stack:
   *   1. Load slot env, filtering to ZBB_SLOT_VARS
   *   2. Load stack (recursive dep walk + import resolve)
   *   3. Overlay stack env on top
   *   4. Inject ZB_STACK (current stack short name)
   */
  async function composeLikePrepareSlot(
    slotDir: string,
    stack: import('../../lib/stack/Stack.js').Stack | null,
  ): Promise<Record<string, string>> {
    const slotEnv = new SlotEnvironment(slotDir);
    await slotEnv.load();
    const composed: Record<string, string> = { ...slotEnv.getAll() };
    if (stack) {
      await stack.load();
      const stackEnv = stack.env.getAll();
      for (const [k, v] of Object.entries(stackEnv)) {
        composed[k] = v;
      }
      composed.ZB_STACK = stack.name;
    }
    return composed;
  }

  /** Create a stack under stacksDir with a source zbb.yaml + .env + stack.yaml. */
  async function makeStack(
    name: string,
    opts: {
      env?: Record<string, string>;
      schema?: Record<string, { type: string; default?: string }>;
      imports?: Record<string, unknown>;
    } = {},
  ): Promise<string> {
    const { stringify: yamlStringify } = await import('yaml');
    const stackDir = join(stacksDir, name);
    const sourceDir = join(stacksDir, `_src-${name}`);
    await mkdir(stackDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, 'zbb.yaml'),
      yamlStringify({
        name: `@zerobias-com/${name}`,
        version: '1.0.0',
        env: opts.schema ?? { _PLACEHOLDER: { type: 'string', default: 'x' } },
        imports: opts.imports,
      }),
      'utf-8',
    );
    await writeFile(
      join(stackDir, 'stack.yaml'),
      yamlStringify({
        name: `@zerobias-com/${name}`,
        version: '1.0.0',
        mode: 'dev',
        source: sourceDir,
        added: new Date().toISOString(),
      }),
      'utf-8',
    );
    const envLines = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`);
    await writeFile(join(stackDir, '.env'), envLines.join('\n') + '\n', 'utf-8');
    await writeFile(join(stackDir, 'manifest.yaml'), '{}', 'utf-8');
    return stackDir;
  }

  it('composes slot ZB_* + stack env + ZB_STACK', async () => {
    // Slot .env: has ZB_* vars, clean.
    await writeFile(
      join(slotDir, '.env'),
      'ZB_SLOT=local\nZB_SLOT_DIR=/home/x/.zbb/slots/local\n',
      'utf-8',
    );

    // minio stack provides AWS_* vars
    await makeStack('minio', {
      env: {
        AWS_ACCESS_KEY_ID: 'minioadmin',
        AWS_SECRET_ACCESS_KEY: 'minioadmin',
        AWS_ENDPOINT: 'http://localhost:15016',
      },
      schema: {
        AWS_ACCESS_KEY_ID: { type: 'string' },
        AWS_SECRET_ACCESS_KEY: { type: 'string' },
        AWS_ENDPOINT: { type: 'string' },
      },
    });

    // fileservice stack imports AWS_* from minio
    await makeStack('file-service', {
      imports: {
        minio: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ENDPOINT'],
      },
    });

    const { Stack } = await import('../../lib/stack/Stack.js');
    const fs = new Stack('file-service', stacksDir);
    const composed = await composeLikePrepareSlot(slotDir, fs);

    // Slot-level ZB_* present
    assert.equal(composed.ZB_SLOT, 'local');
    assert.equal(composed.ZB_SLOT_DIR, '/home/x/.zbb/slots/local');
    // Imported stack vars present
    assert.equal(composed.AWS_ACCESS_KEY_ID, 'minioadmin');
    assert.equal(composed.AWS_ENDPOINT, 'http://localhost:15016');
    // Injected ZB_STACK
    assert.equal(composed.ZB_STACK, 'file-service');
    assert.equal(composed.STACK_NAME, undefined, 'STACK_NAME must not be produced anywhere');
  });

  it('stack import value overrides a polluted slot .env (the original bug)', async () => {
    // Slot .env contains leftover AWS_ACCESS_KEY_ID from an old polluted
    // state. After lockdown + stack composition, the minio stack's fresh
    // value should win.
    await writeFile(
      join(slotDir, '.env'),
      'ZB_SLOT=local\nAWS_ACCESS_KEY_ID=AKIA_LEGACY_LEAK\n',
      'utf-8',
    );

    await makeStack('minio', {
      env: { AWS_ACCESS_KEY_ID: 'minioadmin' },
      schema: { AWS_ACCESS_KEY_ID: { type: 'string' } },
    });
    await makeStack('consumer', {
      imports: { minio: ['AWS_ACCESS_KEY_ID'] },
    });

    const { Stack } = await import('../../lib/stack/Stack.js');
    const consumer = new Stack('consumer', stacksDir);
    const composed = await composeLikePrepareSlot(slotDir, consumer);

    assert.equal(
      composed.AWS_ACCESS_KEY_ID,
      'minioadmin',
      'slot-level polluted AWS key must be filtered out, stack import wins',
    );
  });

  it('without a stack, only slot ZB_* vars reach composed env', async () => {
    await writeFile(
      join(slotDir, '.env'),
      'ZB_SLOT=local\nAWS_ACCESS_KEY_ID=polluted\nPGHOST=polluted\n',
      'utf-8',
    );

    const composed = await composeLikePrepareSlot(slotDir, null);
    assert.equal(composed.ZB_SLOT, 'local');
    assert.equal(composed.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(composed.PGHOST, undefined);
    assert.equal(composed.ZB_STACK, undefined, 'no stack context → no ZB_STACK injected');
  });

  it('recursive dep chain: fileservice imports via minio (which has own stack)', async () => {
    await writeFile(join(slotDir, '.env'), 'ZB_SLOT=local\n', 'utf-8');

    // postgres (leaf)
    await makeStack('postgres', {
      env: { PGHOST: 'localhost', PGPORT: '15000' },
      schema: { PGHOST: { type: 'string' }, PGPORT: { type: 'string' } },
    });

    // dana depends on postgres + imports PGHOST
    await makeStack('dana', {
      env: { DANA_PORT: '15002' },
      schema: { DANA_PORT: { type: 'string' } },
      imports: { postgres: ['PGHOST', 'PGPORT'] },
    });

    // file-service imports DANA_PORT + PGHOST from dana (which imported
    // it from postgres). The recursive Stack.load() chain is what makes
    // this work: dana must be resolved (which resolves postgres first)
    // before fileservice reads dana's .env.
    await makeStack('file-service', {
      imports: { dana: ['DANA_PORT', 'PGHOST'] },
    });

    const { Stack } = await import('../../lib/stack/Stack.js');
    const fs = new Stack('file-service', stacksDir);
    const composed = await composeLikePrepareSlot(slotDir, fs);

    assert.equal(composed.DANA_PORT, '15002');
    assert.equal(composed.PGHOST, 'localhost', 'PGHOST should chain postgres → dana → file-service');
  });

  it('fails loudly when a stack import is missing and not optional', async () => {
    await writeFile(join(slotDir, '.env'), 'ZB_SLOT=local\n', 'utf-8');

    await makeStack('provider', {
      env: { FOO: 'foo-val' },
      schema: { FOO: { type: 'string' } },
    });
    await makeStack('consumer', {
      imports: { provider: ['FOO', 'MISSING'] },
    });

    const { Stack } = await import('../../lib/stack/Stack.js');
    const consumer = new Stack('consumer', stacksDir);

    await assert.rejects(
      () => composeLikePrepareSlot(slotDir, consumer),
      (e: Error) => /MISSING/.test(e.message),
    );
  });
});
