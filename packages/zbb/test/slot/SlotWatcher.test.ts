import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SlotWatcher } from '../../lib/slot/SlotWatcher.js';

/** Helper: wait for a specific event with timeout */
function waitForEvent(emitter: SlotWatcher, event: string, timeoutMs: number = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeoutMs);
    emitter.once(event, (filename: string) => {
      clearTimeout(timer);
      resolve(filename);
    });
  });
}

/** Helper: wait a fixed amount of time */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('SlotWatcher', () => {
  let tmpDir: string;
  let slotPath: string;
  let watcher: SlotWatcher | null;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'zbb-watcher-test-'));
    slotPath = join(tmpDir, 'test-slot');
    await mkdir(slotPath, { recursive: true });
    await mkdir(join(slotPath, 'state', 'hub'), { recursive: true });
    await mkdir(join(slotPath, 'state', 'deployments'), { recursive: true });
    await mkdir(join(slotPath, 'state', 'cmd'), { recursive: true });
    watcher = null;
  });

  afterEach(async () => {
    if (watcher && watcher.isWatching()) {
      await watcher.close();
    }
    watcher = null;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('constructor accepts (slotPath, slotName) and start() begins watching', async () => {
    watcher = new SlotWatcher(slotPath, 'test-slot');
    assert.equal(watcher.isWatching(), false);
    watcher.start();
    assert.equal(watcher.isWatching(), true);
  });

  it('writing to .env emits env:change event', async () => {
    watcher = new SlotWatcher(slotPath, 'test-slot');
    watcher.start();
    // Give watcher time to initialize
    await delay(300);

    const eventPromise = waitForEvent(watcher, 'env:change');
    await writeFile(join(slotPath, '.env'), 'FOO=bar\n', 'utf-8');
    const filename = await eventPromise;
    assert.equal(filename, '.env');
  });

  it('writing to overrides.env emits env:change event', async () => {
    watcher = new SlotWatcher(slotPath, 'test-slot');
    watcher.start();
    await delay(300);

    const eventPromise = waitForEvent(watcher, 'env:change');
    await writeFile(join(slotPath, 'overrides.env'), 'BAR=baz\n', 'utf-8');
    const filename = await eventPromise;
    assert.equal(filename, 'overrides.env');
  });

  it('writing to state/hub/state.yml emits state:change event', async () => {
    watcher = new SlotWatcher(slotPath, 'test-slot');
    watcher.start();
    await delay(300);

    const eventPromise = waitForEvent(watcher, 'state:change');
    await writeFile(join(slotPath, 'state', 'hub', 'state.yml'), 'status: running\n', 'utf-8');
    await eventPromise;
  });

  it('writing to state/deployments/deploy1.yml emits deployment:change event', async () => {
    watcher = new SlotWatcher(slotPath, 'test-slot');
    watcher.start();
    await delay(300);

    const eventPromise = waitForEvent(watcher, 'deployment:change');
    await writeFile(join(slotPath, 'state', 'deployments', 'deploy1.yml'), 'id: deploy1\n', 'utf-8');
    await eventPromise;
  });

  it('writing to state/cmd/cmd1.yml emits command:change event', async () => {
    watcher = new SlotWatcher(slotPath, 'test-slot');
    watcher.start();
    await delay(300);

    const eventPromise = waitForEvent(watcher, 'command:change');
    await writeFile(join(slotPath, 'state', 'cmd', 'cmd1.yml'), 'command: start\n', 'utf-8');
    await eventPromise;
  });

  it('all file changes emit generic file:change event with relative filename', async () => {
    watcher = new SlotWatcher(slotPath, 'test-slot');
    watcher.start();
    // Drain any stale FS events from beforeEach directory creation
    await delay(300);
    // Collect file:change events after this point
    const received: string[] = [];
    watcher.on('file:change', (f: string) => received.push(f));
    await writeFile(join(slotPath, '.env'), 'X=1\n', 'utf-8');
    await delay(300);
    assert.ok(received.includes('.env'), `Expected '.env' in events, got: [${received}]`);
  });

  it('rapid writes within debounce window produce single event', async () => {
    watcher = new SlotWatcher(slotPath, 'test-slot');
    watcher.start();
    await delay(300);

    let eventCount = 0;
    watcher.on('env:change', () => { eventCount += 1; });

    // Rapid writes within 100ms
    await writeFile(join(slotPath, '.env'), 'A=1\n', 'utf-8');
    await writeFile(join(slotPath, '.env'), 'A=2\n', 'utf-8');
    await writeFile(join(slotPath, '.env'), 'A=3\n', 'utf-8');

    // Wait longer than debounce window
    await delay(400);
    assert.equal(eventCount, 1, `Expected 1 debounced event, got ${eventCount}`);
  });

  it('close() stops watching and removes all listeners', async () => {
    watcher = new SlotWatcher(slotPath, 'test-slot');
    watcher.start();
    await delay(300);

    await watcher.close();
    assert.equal(watcher.isWatching(), false);
    assert.equal(watcher.listenerCount('env:change'), 0);
    assert.equal(watcher.listenerCount('state:change'), 0);
  });

  it('isWatching() returns true after start(), false after close()', async () => {
    watcher = new SlotWatcher(slotPath, 'test-slot');
    assert.equal(watcher.isWatching(), false);

    watcher.start();
    assert.equal(watcher.isWatching(), true);

    await watcher.close();
    assert.equal(watcher.isWatching(), false);
  });

  it('start() called twice throws Error', () => {
    watcher = new SlotWatcher(slotPath, 'test-slot');
    watcher.start();
    assert.throws(() => watcher!.start(), /already started/i);
  });

  // ── Stack-level events ──────────────────────────────────────

  it('writing to stacks/<name>/.env emits stack:env:change with stack name', async () => {
    const stackDir = join(slotPath, 'stacks', 'dana');
    await mkdir(stackDir, { recursive: true });

    watcher = new SlotWatcher(slotPath, 'test-slot');
    watcher.start();
    await delay(300);

    const eventPromise = new Promise<{ stackName: string; relPath: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for stack:env:change')), 2000);
      watcher!.once('stack:env:change', (stackName: string, relPath: string) => {
        clearTimeout(timer);
        resolve({ stackName, relPath });
      });
    });

    await writeFile(join(stackDir, '.env'), 'FOO=bar\n', 'utf-8');
    const result = await eventPromise;
    assert.equal(result.stackName, 'dana');
    assert.ok(result.relPath.includes('stacks/dana/.env'));
  });

  it('writing to stacks/<name>/state.yaml emits stack:state:change with stack name', async () => {
    const stackDir = join(slotPath, 'stacks', 'hub');
    await mkdir(stackDir, { recursive: true });

    watcher = new SlotWatcher(slotPath, 'test-slot');
    watcher.start();
    await delay(300);

    const eventPromise = new Promise<{ stackName: string; relPath: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for stack:state:change')), 2000);
      watcher!.once('stack:state:change', (stackName: string, relPath: string) => {
        clearTimeout(timer);
        resolve({ stackName, relPath });
      });
    });

    await writeFile(join(stackDir, 'state.yaml'), 'status: healthy\n', 'utf-8');
    const result = await eventPromise;
    assert.equal(result.stackName, 'hub');
    assert.ok(result.relPath.includes('stacks/hub/state.yaml'));
  });

  it('writing to stacks/<name>/manifest.yaml emits stack:manifest:change with stack name', async () => {
    const stackDir = join(slotPath, 'stacks', 'postgres');
    await mkdir(stackDir, { recursive: true });

    watcher = new SlotWatcher(slotPath, 'test-slot');
    watcher.start();
    await delay(300);

    const eventPromise = new Promise<{ stackName: string; relPath: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for stack:manifest:change')), 2000);
      watcher!.once('stack:manifest:change', (stackName: string, relPath: string) => {
        clearTimeout(timer);
        resolve({ stackName, relPath });
      });
    });

    await writeFile(join(stackDir, 'manifest.yaml'), 'PGPORT: {resolution: allocated}\n', 'utf-8');
    const result = await eventPromise;
    assert.equal(result.stackName, 'postgres');
    assert.ok(result.relPath.includes('stacks/postgres/manifest.yaml'));
  });
});
