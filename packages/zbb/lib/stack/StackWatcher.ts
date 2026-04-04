import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join, relative } from 'node:path';

type WatchScope = 'state' | 'env';

/**
 * Create a debounced version of a function.
 * Subsequent calls within `delayMs` reset the timer; the function
 * fires only after the last call plus `delayMs` of silence.
 */
function debounce<T extends (...args: Parameters<T>) => void>(fn: T, delayMs: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: Parameters<T>) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delayMs);
  };
  return debounced as T;
}

/**
 * Stack-specific file watcher with on-demand scoped subscriptions.
 *
 * Unlike SlotWatcher (which watches the entire slot directory recursively),
 * StackWatcher watches only explicitly subscribed scopes. No subscription
 * means zero fs.watch overhead.
 *
 * Scopes:
 * - 'state' — watches substacks/ directory and stack-level state.yaml
 * - 'env'   — watches stack-level .env file
 *
 * Events emitted:
 * - 'substack:change' (substackName: string, relPath: string) — file under substacks/<name>/
 *   where relPath is relative to substacks/
 * - 'state:change'  — stack-level state.yaml modified
 * - 'env:change'    — stack-level .env modified
 *
 * Uses 100ms per-filename debounce (same as SlotWatcher).
 */
export class StackWatcher extends EventEmitter {
  private readonly stackPath: string;
  private watchers: Map<WatchScope, FSWatcher> = new Map();
  private debouncers: Map<string, (filename: string) => void> = new Map();

  /**
   * Create a StackWatcher.
   *
   * @param stackPath - Absolute path to stack directory
   */
  constructor(stackPath: string) {
    super();
    this.stackPath = stackPath;
  }

  /**
   * Subscribe to a watch scope.
   * Idempotent — calling watch() for an already-watched scope is a no-op.
   *
   * 'state' — starts watching:
   *   - substacks/ directory (recursive) for substack:change events
   *   - stack-level state.yaml for state:change events
   *
   * 'env' — starts watching:
   *   - stack-level .env file for env:change events
   */
  watch(scope: WatchScope): void {
    if (this.watchers.has(scope)) return;

    if (scope === 'state') {
      this.startStateWatcher();
    } else if (scope === 'env') {
      this.startEnvWatcher();
    }
  }

  /**
   * Stop watching a specific scope. Closes just that scope's watcher.
   * Other scopes remain active.
   */
  unwatch(scope: WatchScope): void {
    const w = this.watchers.get(scope);
    if (w) {
      w.close();
      this.watchers.delete(scope);
    }
  }

  /**
   * Stop all watchers, clear debouncers, remove all listeners.
   */
  async close(): Promise<void> {
    for (const w of this.watchers.values()) {
      w.close();
    }
    this.watchers.clear();
    this.debouncers.clear();
    this.removeAllListeners();
  }

  /**
   * Check if any scope (or a specific scope) is currently being watched.
   *
   * @param scope - Optional scope to check. If omitted, returns true if any scope is active.
   */
  isWatching(scope?: WatchScope): boolean {
    if (scope !== undefined) {
      return this.watchers.has(scope);
    }
    return this.watchers.size > 0;
  }

  // ── Private ─────────────────────────────────────────────────

  /**
   * Start watcher for the 'state' scope.
   *
   * Watches the entire stack directory recursively to catch both:
   * - substacks/<name>/<file> → substack:change(name, relPath)
   * - state.yaml at stack root → state:change
   *
   * This approach handles the case where substacks/ directory doesn't
   * exist when the watcher starts — the watcher will catch it when it's
   * created and files are written into it.
   */
  private startStateWatcher(): void {
    const watcher = watch(this.stackPath, { recursive: true, persistent: false }, (_eventType, filename) => {
      if (!filename) return;
      this.getDebouncedDispatch(filename)(filename);
    });

    watcher.on('error', (err) => {
      this.emit('error', err);
    });

    this.watchers.set('state', watcher);
  }

  /**
   * Start watcher for the 'env' scope.
   *
   * Watches the stack directory non-recursively to catch .env changes.
   * Using the directory (non-recursive) rather than the file directly
   * avoids issues where the file doesn't exist yet.
   */
  private startEnvWatcher(): void {
    const debouncedEmit = debounce(() => {
      if (this.watchers.has('env')) {
        this.emit('env:change');
      }
    }, 100);

    const watcher = watch(this.stackPath, { recursive: false, persistent: false }, (_eventType, filename) => {
      if (!filename) return;
      // Only dispatch .env changes in env scope
      const normalized = filename.replace(/\\/g, '/');
      if (normalized === '.env') {
        debouncedEmit();
      }
    });

    watcher.on('error', (err) => {
      this.emit('error', err);
    });

    this.watchers.set('env', watcher);
  }

  /**
   * Get or create a debounced dispatch function for a given key.
   * Each unique key gets its own 100ms debounce timer so that
   * rapid writes to the same file coalesce but writes to different
   * files dispatch independently.
   */
  private getDebouncedDispatch(key: string): (filename: string) => void {
    let debounced = this.debouncers.get(key);
    if (!debounced) {
      debounced = debounce((filename: string) => this.dispatchState(filename), 100);
      this.debouncers.set(key, debounced);
    }
    return debounced;
  }

  /**
   * Dispatch events for state scope changes (from the recursive stack directory watcher).
   */
  private dispatchState(filename: string): void {
    // Normalize path separators (Windows uses backslash)
    const normalized = filename.replace(/\\/g, '/');

    // Normalize absolute path to relative
    const rel = filename.startsWith(this.stackPath)
      ? relative(this.stackPath, filename).replace(/\\/g, '/')
      : normalized;

    // Skip files outside our interests (logs, secrets, state/cmd, etc.)
    if (
      rel.startsWith('logs/') ||
      rel.startsWith('state/secrets/') ||
      rel.startsWith('state/cmd/') ||
      rel === 'stack.yaml'
    ) {
      return;
    }

    // Stack-level state.yaml
    if (rel === 'state.yaml') {
      // Only emit if 'state' scope is active
      if (this.watchers.has('state')) {
        this.emit('state:change');
      }
      return;
    }

    // substacks/<name>/<rest...>
    if (rel.startsWith('substacks/')) {
      if (!this.watchers.has('state')) return;

      const withoutPrefix = rel.slice('substacks/'.length);
      // Must have at least one slash to identify substack name + file
      const slashIdx = withoutPrefix.indexOf('/');
      if (slashIdx === -1) return; // just a directory creation event

      const substackName = withoutPrefix.slice(0, slashIdx);
      const relPath = withoutPrefix; // relative to substacks/
      this.emit('substack:change', substackName, relPath);
      return;
    }

    // .env at stack root — but env scope has its own watcher, don't double-emit
    // The state scope watcher also sees .env but we should NOT emit env:change
    // from the state scope. The env scope watcher handles that.
  }
}
