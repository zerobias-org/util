import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SlotEnvironment } from './SlotEnvironment.ts';

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
