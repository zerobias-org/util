import { LogLevel, LOG_LEVEL_METADATA } from './LogLevel.js';

/** Symbol used to store root logger on globalThis for cross-package singleton */
const GLOBAL_ROOT_KEY = Symbol.for('@zerobias-org/logger:root');

/**
 * Browser-compatible logger options (no winston transports)
 */
export interface BrowserLoggerOptions {
  /** Optional log level (undefined = inherit from parent) */
  level?: LogLevel;
  /**
   * If true, logger is not cached in parent's children map and can be garbage collected.
   */
  ephemeral?: boolean;
}

/**
 * Browser-compatible hierarchical logger engine
 *
 * Drop-in replacement for LoggerEngine that uses console.* instead of winston.
 * Provides the same public API (root(), get(), destroy(), log methods, hierarchy)
 * without any Node.js dependencies.
 *
 *
 * Uses globalThis to ensure a single root logger instance across all copies
 * of the package, so libraries sharing the logger get unified configuration.
 */
export class LoggerEngine {
  private readonly _name: string;
  private _parent: LoggerEngine | undefined;
  private readonly _children: Map<string, LoggerEngine>;
  private _level: LogLevel | undefined;
  private _destroyed: boolean = false;
  private readonly _ephemeral: boolean;

  /**
   * Private constructor - use LoggerEngine.root() or parent.get(name)
   */
  private constructor(name: string, parent?: LoggerEngine, options?: BrowserLoggerOptions) {
    this._name = name;
    this._parent = parent;
    this._children = new Map();
    this._level = options?.level;
    this._ephemeral = options?.ephemeral ?? false;
  }

  /**
   * Get the singleton root logger
   * Uses globalThis to ensure a single root instance across all copies of the package
   */
  static root(): LoggerEngine {
    const g = globalThis as any;
    if (!g[GLOBAL_ROOT_KEY]) {
      g[GLOBAL_ROOT_KEY] = new LoggerEngine('', undefined, {
        level: LogLevel.INFO,
      });
    }
    return g[GLOBAL_ROOT_KEY];
  }

  /**
   * Get or create a child logger
   */
  get(childName: string, options?: BrowserLoggerOptions): LoggerEngine {
    if (this._destroyed) {
      throw new Error(`Cannot get child logger from destroyed logger: ${this.path}`);
    }

    if (options?.ephemeral) {
      return new LoggerEngine(childName, this, options);
    }

    let child = this._children.get(childName);
    if (!child) {
      child = new LoggerEngine(childName, this, options);
      this._children.set(childName, child);
    }
    return child;
  }

  /**
   * Destroy this logger and all children
   */
  destroy(): void {
    if (this._destroyed) {
      return;
    }

    if (!this._parent) {
      throw new Error('Cannot destroy root logger');
    }

    this._destroyed = true;

    for (const child of this._children.values()) {
      child.destroy();
    }
    this._children.clear();

    if (!this._ephemeral) {
      this._parent._children.delete(this._name);
    }

    this._parent = undefined;
  }

  /**
   * Get effective log level (inherited from parent if not set)
   */
  getEffectiveLevel(): LogLevel {
    if (this._level !== undefined) {
      return this._level;
    }
    if (this._parent) {
      return this._parent.getEffectiveLevel();
    }
    return LogLevel.INFO;
  }

  /**
   * Set log level for this logger
   * Pass null to clear explicit level and inherit from parent
   */
  setLevel(level: LogLevel | null): void {
    if (this._destroyed) {
      throw new Error(`Cannot set level on destroyed logger: ${this.path}`);
    }
    this._level = level === null ? undefined : level;
  }

  get name(): string {
    return this._name;
  }

  get parent(): LoggerEngine | undefined {
    return this._parent;
  }

  get children(): Map<string, LoggerEngine> {
    return this._children;
  }

  get level(): LogLevel | undefined {
    return this._level;
  }

  get path(): string {
    if (!this._parent) {
      return this._name;
    }
    return `${this._parent.path}:${this._name}`;
  }

  get ephemeral(): boolean {
    return this._ephemeral;
  }

  /**
   * No-op transports for API compatibility
   */
  get transports(): any[] {
    return [];
  }

  addTransport(_transport: any): void {
    // No-op in browser
  }

  removeTransport(_transportOrType: any): void {
    // No-op in browser
  }

  getTransport<T>(_transportType: any): T | undefined {
    return undefined;
  }

  getTransports<T>(_transportType: any): T[] {
    return [];
  }

  hasTransport(_transportType: any): boolean {
    return false;
  }

  /**
   * Internal log method
   */
  private log(
    level: LogLevel,
    levelName: string,
    message: string,
    errorOrMetadata?: Error | object,
    metadata?: object
  ): void {
    if (this._destroyed) {
      throw new Error(`Cannot log to destroyed logger: ${this.path}`);
    }

    const effectiveLevel = this.getEffectiveLevel();
    if (level > effectiveLevel) {
      return;
    }

    let error: Error | undefined;
    let meta: object | undefined;

    if (errorOrMetadata instanceof Error) {
      error = errorOrMetadata;
      meta = metadata;
    } else {
      meta = errorOrMetadata;
    }

    // Build formatted message
    const prefix = this.path ? `[${this.path}] [${levelName}]` : `[${levelName}]`;
    const parts: string[] = [`${prefix} ${message}`];

    if (meta && Object.keys(meta).length > 0) {
      parts.push(JSON.stringify(meta));
    }

    const formatted = parts.join(' ');

    // Route to appropriate console method
    switch (levelName) {
      case 'crit':
      case 'error':
        if (error) {
          console.error(formatted, error);
        } else {
          console.error(formatted);
        }
        break;
      case 'warn':
        if (error) {
          console.warn(formatted, error);
        } else {
          console.warn(formatted);
        }
        break;
      case 'info':
        console.info(formatted);
        break;
      default:
        // verbose, debug, trace
        if (error) {
          console.log(formatted, error);
        } else {
          console.log(formatted);
        }
        break;
    }
  }

  crit(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
    this.log(LogLevel.CRIT, 'crit', message, errorOrMetadata, metadata);
  }

  critical(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
    this.crit(message, errorOrMetadata, metadata);
  }

  error(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
    this.log(LogLevel.ERROR, 'error', message, errorOrMetadata, metadata);
  }

  warn(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
    this.log(LogLevel.WARN, 'warn', message, errorOrMetadata, metadata);
  }

  warning(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
    this.warn(message, errorOrMetadata, metadata);
  }

  info(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
    this.log(LogLevel.INFO, 'info', message, errorOrMetadata, metadata);
  }

  verbose(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
    this.log(LogLevel.VERBOSE, 'verbose', message, errorOrMetadata, metadata);
  }

  debug(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
    this.log(LogLevel.DEBUG, 'debug', message, errorOrMetadata, metadata);
  }

  trace(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
    this.log(LogLevel.TRACE, 'trace', message, errorOrMetadata, metadata);
  }
}
