import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { EventEmitter } from 'node:events';
import { relative } from 'node:path';

/**
 * Create a debounced version of a function.
 * Subsequent calls within `delayMs` reset the timer; the function
 * fires only after the last call plus `delayMs` of silence.
 */
function debounce<T extends (...args: Array<any>) => void>(fn: T, delayMs: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: Array<any>) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delayMs);
  };
  return debounced as unknown as T;
}

/**
 * Slot-specific file watcher with path-based event dispatch.
 *
 * Watches the entire slot directory (recursive) using node:fs.watch.
 * Emits typed events based on file paths:
 * - 'env:change'              - .env or overrides.env at slot root
 * - 'state:change'            - state/hub/state.yml modified
 * - 'deployment:change'       - state/deployments/*.yml modified
 * - 'command:change'          - state/cmd/*.yml modified
 * - 'stack:env:change'        - stacks/<name>/.env modified (with stack name)
 * - 'stack:state:change'      - stacks/<name>/state.yaml modified (with stack name)
 * - 'stack:manifest:change'   - stacks/<name>/manifest.yaml modified (with stack name)
 * - 'file:change'             - any file change (always emitted with relative filename)
 *
 * Uses 100ms debounce per-filename to coalesce rapid writes.
 * No external dependencies -- uses only node:fs.watch (inotify on Linux).
 */
export class SlotWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private readonly slotPath: string;
  private readonly slotName: string;
  private debouncers: Map<string, (filename: string) => void> = new Map();

  /**
   * Create slot watcher.
   *
   * @param slotPath - Absolute path to slot directory
   * @param slotName - Name of slot (for logging/error messages)
   */
  constructor(slotPath: string, slotName: string) {
    super();
    this.slotPath = slotPath;
    this.slotName = slotName;
  }

  /**
   * Start watching the slot directory recursively.
   * Throws if already started.
   */
  start(): void {
    if (this.watcher) {
      throw new Error(`SlotWatcher already started for slot ${this.slotName}`);
    }

    this.watcher = watch(this.slotPath, { recursive: true, persistent: true }, (_eventType, filename) => {
      if (!filename) return;
      this.getDebouncedDispatch(filename)(filename);
    });

    this.watcher.on('error', (err) => {
      this.emit('error', err);
    });
  }

  /**
   * Get or create a debounced dispatch function for a given filename.
   * Each unique filename gets its own 100ms debounce timer so that
   * rapid writes to the same file coalesce but writes to different
   * files dispatch independently.
   */
  private getDebouncedDispatch(filename: string): (filename: string) => void {
    let debounced = this.debouncers.get(filename);
    if (!debounced) {
      debounced = debounce((fn: string) => this.dispatch(fn), 100);
      this.debouncers.set(filename, debounced);
    }
    return debounced;
  }

  /**
   * Dispatch typed events based on relative file path within the slot directory.
   */
  private dispatch(filename: string): void {
    // Normalize: on some platforms filename may be absolute
    const rel = filename.startsWith(this.slotPath)
      ? relative(this.slotPath, filename)
      : filename;

    // Skip noisy paths — logs are on-demand only, heartbeat alerts handled by shell hook
    if (rel.includes('/logs/') || rel.endsWith('-alerts.log')) return;

    // Always emit generic file:change with relative filename
    this.emit('file:change', rel);

    // .env or overrides.env at slot root
    if (rel === '.env' || rel === 'overrides.env') {
      this.emit('env:change', rel);
      return;
    }

    // ── Stack-level events ──────────────────────────────────
    // stacks/<name>/.env
    const stackEnvMatch = rel.match(/^stacks\/([^/]+)\/.env$/);
    if (stackEnvMatch) {
      this.emit('stack:env:change', stackEnvMatch[1], rel);
      return;
    }

    // stacks/<name>/state.yaml
    const stackStateMatch = rel.match(/^stacks\/([^/]+)\/state\.yaml$/);
    if (stackStateMatch) {
      this.emit('stack:state:change', stackStateMatch[1], rel);
      return;
    }

    // stacks/<name>/manifest.yaml
    const stackManifestMatch = rel.match(/^stacks\/([^/]+)\/manifest\.yaml$/);
    if (stackManifestMatch) {
      this.emit('stack:manifest:change', stackManifestMatch[1], rel);
      return;
    }

    // ── Legacy slot-level events ────────────────────────────
    // state/hub/state.yml
    if (rel === 'state/hub/state.yml') {
      this.emit('state:change', rel);
      return;
    }

    // state/deployments/*.yml
    if (rel.startsWith('state/deployments/') && rel.endsWith('.yml')) {
      this.emit('deployment:change', rel);
      return;
    }

    // state/cmd/*.yml
    if (rel.startsWith('state/cmd/') && rel.endsWith('.yml')) {
      this.emit('command:change', rel);
      return;
    }
  }

  /**
   * Stop watching and clean up all listeners.
   */
  async close(): Promise<void> {
    if (!this.watcher) return;
    this.watcher.close();
    this.watcher = null;
    this.debouncers.clear();
    this.removeAllListeners();
  }

  /**
   * Check if watcher is currently running.
   */
  isWatching(): boolean {
    return this.watcher !== null;
  }
}
