import { EventEmitter } from 'node:events';
/**
 * Slot-specific file watcher with path-based event dispatch.
 *
 * Watches the entire slot directory (recursive) using node:fs.watch.
 * Emits typed events based on file paths:
 * - 'env:change'        - .env or overrides.env modified
 * - 'state:change'      - state/hub/state.yml modified
 * - 'deployment:change' - state/deployments/*.yml modified
 * - 'command:change'    - state/cmd/*.yml modified
 * - 'file:change'       - any file change (always emitted with relative filename)
 *
 * Uses 100ms debounce per-filename to coalesce rapid writes.
 * No external dependencies -- uses only node:fs.watch (inotify on Linux).
 */
export declare class SlotWatcher extends EventEmitter {
    private watcher;
    private readonly slotPath;
    private readonly slotName;
    private debouncers;
    /**
     * Create slot watcher.
     *
     * @param slotPath - Absolute path to slot directory
     * @param slotName - Name of slot (for logging/error messages)
     */
    constructor(slotPath: string, slotName: string);
    /**
     * Start watching the slot directory recursively.
     * Throws if already started.
     */
    start(): void;
    /**
     * Get or create a debounced dispatch function for a given filename.
     * Each unique filename gets its own 100ms debounce timer so that
     * rapid writes to the same file coalesce but writes to different
     * files dispatch independently.
     */
    private getDebouncedDispatch;
    /**
     * Dispatch typed events based on relative file path within the slot directory.
     */
    private dispatch;
    /**
     * Stop watching and clean up all listeners.
     */
    close(): Promise<void>;
    /**
     * Check if watcher is currently running.
     */
    isWatching(): boolean;
}
