import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

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
 * StackWatcher watches only explicitly subscribed paths. No subscription
 * means zero fs.watch overhead.
 *
 * Scopes:
 * - 'state' — watches substacks/ directory (recursive) and stack-level state.yaml
 * - 'env'   — watches stack-level .env file
 *
 * Each scope creates narrow, targeted watchers — never the whole stack tree.
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
  private scopeWatchers: Map<WatchScope, FSWatcher[]> = new Map();
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
   *   - state.yaml file for state:change events
   *   Two narrow watchers, NOT the whole stack tree.
   *
   * 'env' — starts watching:
   *   - .env file for env:change events
   */
  watch(scope: WatchScope): void {
    if (this.scopeWatchers.has(scope)) return;

    if (scope === 'state') {
      this.startStateWatchers();
    } else if (scope === 'env') {
      this.startEnvWatcher();
    }
  }

  /**
   * Stop watching a specific scope. Closes just that scope's watchers.
   * Other scopes remain active.
   */
  unwatch(scope: WatchScope): void {
    const watchers = this.scopeWatchers.get(scope);
    if (watchers) {
      for (const w of watchers) {
        w.close();
      }
      this.scopeWatchers.delete(scope);
    }
  }

  /**
   * Stop all watchers, clear debouncers, remove all listeners.
   */
  async close(): Promise<void> {
    for (const watchers of this.scopeWatchers.values()) {
      for (const w of watchers) {
        w.close();
      }
    }
    this.scopeWatchers.clear();
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
      return this.scopeWatchers.has(scope);
    }
    return this.scopeWatchers.size > 0;
  }

  // ── Private ─────────────────────────────────────────────────

  /**
   * Start watchers for the 'state' scope.
   *
   * Creates TWO narrow watchers:
   * 1. substacks/ directory (recursive) — catches substack state changes
   * 2. state.yaml file — catches stack-level state changes
   *
   * If substacks/ doesn't exist yet, the watcher is deferred until
   * it's created. The stack directory (non-recursive) is watched to
   * detect substacks/ creation, then replaced with the narrow watcher.
   */
  private startStateWatchers(): void {
    const watchers: FSWatcher[] = [];

    // Watcher 1: substacks/ directory (recursive)
    const substacksDir = join(this.stackPath, 'substacks');
    if (existsSync(substacksDir)) {
      watchers.push(this.watchSubstacksDir(substacksDir));
    } else {
      // substacks/ doesn't exist yet — watch stack dir (non-recursive)
      // to detect when substacks/ is created, then switch to narrow watcher
      const bootstrapWatcher = watch(this.stackPath, { recursive: false, persistent: false }, (_eventType, filename) => {
        if (filename && filename.replace(/\\/g, '/') === 'substacks' && existsSync(substacksDir)) {
          // substacks/ just appeared — close bootstrap watcher, start narrow one
          bootstrapWatcher.close();
          const idx = watchers.indexOf(bootstrapWatcher);
          if (idx !== -1) {
            watchers[idx] = this.watchSubstacksDir(substacksDir);
          }
        }
      });
      bootstrapWatcher.on('error', (err) => this.emit('error', err));
      watchers.push(bootstrapWatcher);
    }

    // Watcher 2: state.yaml at stack root
    const stateFile = join(this.stackPath, 'state.yaml');
    if (existsSync(stateFile)) {
      const stateWatcher = watch(stateFile, { persistent: false }, () => {
        this.getDebouncedDispatch('state.yaml')('state.yaml');
      });
      stateWatcher.on('error', (err) => this.emit('error', err));
      watchers.push(stateWatcher);
    } else {
      // state.yaml doesn't exist yet — watch stack dir (non-recursive) for it
      // Reuse the bootstrap watcher if we already have one, otherwise create
      const hasBootstrap = !existsSync(substacksDir);
      if (!hasBootstrap) {
        const stateBootstrap = watch(this.stackPath, { recursive: false, persistent: false }, (_eventType, filename) => {
          if (filename && filename.replace(/\\/g, '/') === 'state.yaml' && existsSync(stateFile)) {
            stateBootstrap.close();
            const idx = watchers.indexOf(stateBootstrap);
            const narrowWatcher = watch(stateFile, { persistent: false }, () => {
              this.getDebouncedDispatch('state.yaml')('state.yaml');
            });
            narrowWatcher.on('error', (err) => this.emit('error', err));
            if (idx !== -1) {
              watchers[idx] = narrowWatcher;
            } else {
              watchers.push(narrowWatcher);
            }
          }
        });
        stateBootstrap.on('error', (err) => this.emit('error', err));
        watchers.push(stateBootstrap);
      }
    }

    this.scopeWatchers.set('state', watchers);
  }

  /**
   * Watch the substacks/ directory recursively.
   * Dispatches substack:change events for state files and collection items.
   */
  private watchSubstacksDir(substacksDir: string): FSWatcher {
    const watcher = watch(substacksDir, { recursive: true, persistent: false }, (_eventType, filename) => {
      if (!filename) return;
      this.getDebouncedDispatch(`substacks/${filename}`)(filename);
    });

    watcher.on('error', (err) => this.emit('error', err));
    return watcher;
  }

  /**
   * Start watcher for the 'env' scope.
   *
   * Watches the .env file directly. If .env doesn't exist yet,
   * watches the stack directory (non-recursive) to detect creation.
   */
  private startEnvWatcher(): void {
    const envFile = join(this.stackPath, '.env');
    const watchers: FSWatcher[] = [];

    const debouncedEmit = debounce(() => {
      if (this.scopeWatchers.has('env')) {
        this.emit('env:change');
      }
    }, 100);

    if (existsSync(envFile)) {
      const watcher = watch(envFile, { persistent: false }, () => {
        debouncedEmit();
      });
      watcher.on('error', (err) => this.emit('error', err));
      watchers.push(watcher);
    } else {
      // .env doesn't exist yet — watch stack dir to detect creation
      const bootstrap = watch(this.stackPath, { recursive: false, persistent: false }, (_eventType, filename) => {
        if (filename && filename.replace(/\\/g, '/') === '.env' && existsSync(envFile)) {
          bootstrap.close();
          const narrow = watch(envFile, { persistent: false }, () => {
            debouncedEmit();
          });
          narrow.on('error', (err) => this.emit('error', err));
          const idx = watchers.indexOf(bootstrap);
          if (idx !== -1) {
            watchers[idx] = narrow;
          }
        }
      });
      bootstrap.on('error', (err) => this.emit('error', err));
      watchers.push(bootstrap);
    }

    this.scopeWatchers.set('env', watchers);
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
   * Dispatch events for state scope changes.
   */
  private dispatchState(filename: string): void {
    const normalized = filename.replace(/\\/g, '/');

    // Stack-level state.yaml (from the file watcher)
    if (normalized === 'state.yaml') {
      this.emit('state:change');
      return;
    }

    // Substack file (from the substacks/ recursive watcher)
    // filename is relative to substacks/ dir
    const slashIdx = normalized.indexOf('/');
    if (slashIdx === -1) return; // directory creation event, no file

    const substackName = normalized.slice(0, slashIdx);
    this.emit('substack:change', substackName, normalized);
  }
}
