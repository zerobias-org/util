import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StackWatcher } from './StackWatcher.js';

/** Helper: wait for a specific event with timeout */
function waitForEvent(emitter: StackWatcher, event: string, timeoutMs: number = 2000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeoutMs);
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

/** Helper: wait a fixed amount of time */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('StackWatcher', () => {
  let tmpDir: string;
  let stackPath: string;
  let watcher: StackWatcher | null;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'zbb-stackwatcher-test-'));
    stackPath = join(tmpDir, 'test-stack');
    await mkdir(stackPath, { recursive: true });
    await mkdir(join(stackPath, 'substacks'), { recursive: true });
    watcher = null;
  });

  afterEach(async () => {
    if (watcher) {
      await watcher.close();
      watcher = null;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('no watchers active initially', () => {
    watcher = new StackWatcher(stackPath);
    assert.equal(watcher.isWatching(), false);
    assert.equal(watcher.isWatching('state'), false);
    assert.equal(watcher.isWatching('env'), false);
  });

  it('watch("state") detects substack state.yaml write', async () => {
    watcher = new StackWatcher(stackPath);
    watcher.watch('state');
    await delay(100);

    await mkdir(join(stackPath, 'substacks', 'node'), { recursive: true });
    await delay(50);

    const eventPromise = waitForEvent(watcher, 'substack:change');
    await writeFile(join(stackPath, 'substacks', 'node', 'state.yaml'), 'status: running\n', 'utf-8');
    const [substackName, relPath] = await eventPromise;
    assert.equal(substackName, 'node');
    assert.equal(relPath, 'node/state.yaml');
  });

  it('watch("state") detects collection item write', async () => {
    watcher = new StackWatcher(stackPath);
    watcher.watch('state');
    await delay(100);

    await mkdir(join(stackPath, 'substacks', 'alerts'), { recursive: true });
    await delay(50);

    const eventPromise = waitForEvent(watcher, 'substack:change');
    await writeFile(join(stackPath, 'substacks', 'alerts', 'disk-full.yml'), 'severity: error\n', 'utf-8');
    const [substackName, relPath] = await eventPromise;
    assert.equal(substackName, 'alerts');
    assert.equal(relPath, 'alerts/disk-full.yml');
  });

  it('watch("state") detects stack-level state.yaml write', async () => {
    watcher = new StackWatcher(stackPath);
    watcher.watch('state');
    await delay(100);

    const eventPromise = waitForEvent(watcher, 'state:change');
    await writeFile(join(stackPath, 'state.yaml'), 'status: healthy\n', 'utf-8');
    await eventPromise;
  });

  it('watch("env") detects .env write', async () => {
    watcher = new StackWatcher(stackPath);
    watcher.watch('env');
    await delay(100);

    const eventPromise = waitForEvent(watcher, 'env:change');
    await writeFile(join(stackPath, '.env'), 'FOO=bar\n', 'utf-8');
    await eventPromise;
  });

  it('no events without watch() call', async () => {
    watcher = new StackWatcher(stackPath);
    // Do NOT call watch()

    let eventCount = 0;
    watcher.on('substack:change', () => { eventCount += 1; });
    watcher.on('state:change', () => { eventCount += 1; });
    watcher.on('env:change', () => { eventCount += 1; });

    await mkdir(join(stackPath, 'substacks', 'node'), { recursive: true });
    await writeFile(join(stackPath, 'substacks', 'node', 'state.yaml'), 'status: running\n', 'utf-8');
    await writeFile(join(stackPath, 'state.yaml'), 'status: healthy\n', 'utf-8');
    await writeFile(join(stackPath, '.env'), 'FOO=bar\n', 'utf-8');
    await delay(300);

    assert.equal(eventCount, 0, `Expected 0 events, got ${eventCount}`);
  });

  it('watch("state") twice is idempotent', async () => {
    watcher = new StackWatcher(stackPath);
    watcher.watch('state');
    watcher.watch('state'); // second call should be no-op
    await delay(100);

    let eventCount = 0;
    watcher.on('substack:change', () => { eventCount += 1; });

    await mkdir(join(stackPath, 'substacks', 'node'), { recursive: true });
    await delay(50);
    await writeFile(join(stackPath, 'substacks', 'node', 'state.yaml'), 'status: running\n', 'utf-8');

    await delay(400);
    assert.equal(eventCount, 1, `Expected 1 event (not doubled), got ${eventCount}`);
  });

  it('close() stops all watchers', async () => {
    watcher = new StackWatcher(stackPath);
    watcher.watch('state');
    watcher.watch('env');
    await delay(100);

    assert.equal(watcher.isWatching(), true);
    await watcher.close();
    assert.equal(watcher.isWatching(), false);

    // Verify no events after close
    let eventCount = 0;
    watcher.on('substack:change', () => { eventCount += 1; });
    watcher.on('state:change', () => { eventCount += 1; });
    watcher.on('env:change', () => { eventCount += 1; });

    await mkdir(join(stackPath, 'substacks', 'node'), { recursive: true });
    await writeFile(join(stackPath, 'substacks', 'node', 'state.yaml'), 'status: running\n', 'utf-8');
    await writeFile(join(stackPath, '.env'), 'FOO=bar\n', 'utf-8');
    await delay(300);

    assert.equal(eventCount, 0, `Expected 0 events after close, got ${eventCount}`);
  });

  it('unwatch("state") stops state but not env', async () => {
    watcher = new StackWatcher(stackPath);
    watcher.watch('state');
    watcher.watch('env');
    await delay(100);

    watcher.unwatch('state');
    assert.equal(watcher.isWatching('state'), false);
    assert.equal(watcher.isWatching('env'), true);
    assert.equal(watcher.isWatching(), true); // still watching env

    // env:change should still work
    const eventPromise = waitForEvent(watcher, 'env:change');
    await writeFile(join(stackPath, '.env'), 'FOO=bar\n', 'utf-8');
    await eventPromise;
  });

  it('watch("state") detects both substacks/ and state.yaml when neither exists at start', async () => {
    // Create a stack path with NO substacks/ and NO state.yaml
    const emptyStackPath = join(tmpDir, 'empty-stack');
    await mkdir(emptyStackPath, { recursive: true });

    watcher = new StackWatcher(emptyStackPath);
    watcher.watch('state');
    await delay(100);

    // Create state.yaml — should be detected via bootstrap watcher
    const statePromise = waitForEvent(watcher, 'state:change');
    await writeFile(join(emptyStackPath, 'state.yaml'), 'status: healthy\n', 'utf-8');
    await statePromise;

    // Create substacks/ and a substack file — should be detected
    await mkdir(join(emptyStackPath, 'substacks', 'node'), { recursive: true });
    await delay(200); // allow bootstrap to swap in narrow watcher

    const substackPromise = waitForEvent(watcher, 'substack:change');
    await writeFile(join(emptyStackPath, 'substacks', 'node', 'state.yaml'), 'status: running\n', 'utf-8');
    const [substackName, relPath] = await substackPromise;
    assert.equal(substackName, 'node');
    assert.equal(relPath, 'node/state.yaml');
  });

  it('isWatching(scope) returns correct state per scope', () => {
    watcher = new StackWatcher(stackPath);
    assert.equal(watcher.isWatching('state'), false);
    assert.equal(watcher.isWatching('env'), false);
    assert.equal(watcher.isWatching(), false);

    watcher.watch('state');
    assert.equal(watcher.isWatching('state'), true);
    assert.equal(watcher.isWatching('env'), false);
    assert.equal(watcher.isWatching(), true);

    watcher.watch('env');
    assert.equal(watcher.isWatching('state'), true);
    assert.equal(watcher.isWatching('env'), true);
    assert.equal(watcher.isWatching(), true);
  });
});
