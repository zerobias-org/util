import winston from 'winston';
import Transport from 'winston-transport';
import { LogLevel } from './LogLevel.js';
import type { LoggerOptions } from './types.js';
import { ParentTransport } from './ParentTransport.js';
import { ConsoleTransport } from './transports/ConsoleTransport.js';

/**
 * Hierarchical logger engine
 */
export class LoggerEngine {
  private static _root: LoggerEngine | undefined;

  private readonly _name: string;
  private _parent: LoggerEngine | undefined;
  private readonly _children: Map<string, LoggerEngine>;
  private _level: LogLevel | undefined;
  private readonly _logger: winston.Logger;
  private _destroyed: boolean = false;

  /**
   * Private constructor - use LoggerEngine.root() or parent.get(name)
   */
  private constructor(name: string, parent?: LoggerEngine, options?: LoggerOptions) {
    this._name = name;
    this._parent = parent;
    this._children = new Map();
    this._level = options?.level;

    // Create Winston logger with transports
    const transports: Transport[] = [];

    // Add ParentTransport if not root
    if (parent) {
      transports.push(new ParentTransport((info: any) => parent._forwardLog(info)));
    }

    // Add custom transports from options
    if (options?.transports) {
      transports.push(...options.transports);
    }

    // Define our custom log levels matching LogLevel enum
    // Winston convention: lower number = higher priority
    const customLevels = {
      crit: 0,
      error: 1,
      warn: 2,
      info: 3,
      verbose: 4,
      debug: 5,
      trace: 6
    };

    this._logger = winston.createLogger({
      levels: customLevels,
      level: 'trace', // Allow all levels, we filter in our log() method
      transports
    });
  }

  /**
   * Get the singleton root logger
   */
  static root(): LoggerEngine {
    if (!LoggerEngine._root) {
      LoggerEngine._root = new LoggerEngine('root', undefined, {
        level: LogLevel.INFO,
        transports: [new ConsoleTransport()]
      });
    }
    return LoggerEngine._root;
  }

  /**
   * Get or create a child logger
   */
  get(childName: string, options?: LoggerOptions): LoggerEngine {
    if (this._destroyed) {
      throw new Error(`Cannot get child logger from destroyed logger: ${this.path}`);
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
    // Idempotent - ignore if already destroyed
    if (this._destroyed) {
      return;
    }

    // Prevent destroying root
    if (!this._parent) {
      throw new Error('Cannot destroy root logger');
    }

    // Mark as destroyed
    this._destroyed = true;

    // 1. Recursively destroy all children
    for (const child of this._children.values()) {
      child.destroy();
    }
    this._children.clear();

    // 2. Remove from parent's children map
    this._parent._children.delete(this._name);

    // 3. Close Winston logger
    this._logger.close();

    // 4. Clear parent reference
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

    // Root with no explicit level
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

  /**
   * Get logger name
   */
  get name(): string {
    return this._name;
  }

  /**
   * Get parent logger (undefined for root)
   */
  get parent(): LoggerEngine | undefined {
    return this._parent;
  }

  /**
   * Get children map
   */
  get children(): Map<string, LoggerEngine> {
    return this._children;
  }

  /**
   * Get current log level (may be undefined = inherit)
   */
  get level(): LogLevel | undefined {
    return this._level;
  }

  /**
   * Get logger path (e.g., 'root:api:auth')
   */
  get path(): string {
    if (!this._parent) {
      return this._name;
    }
    return `${this._parent.path}:${this._name}`;
  }

  /**
   * Get transports
   */
  get transports(): Transport[] {
    return this._logger.transports;
  }

  /**
   * Internal method for ParentTransport to forward logs
   * @internal
   */
  _forwardLog(info: any): void {
    this._logger.log(info);
  }

  /**
   * Add a transport
   */
  addTransport(transport: Transport): void {
    if (this._destroyed) {
      throw new Error(`Cannot add transport to destroyed logger: ${this.path}`);
    }
    this._logger.add(transport);
  }

  /**
   * Remove a transport
   */
  removeTransport(transport: Transport): void {
    if (this._destroyed) {
      throw new Error(`Cannot remove transport from destroyed logger: ${this.path}`);
    }
    this._logger.remove(transport);
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

    // Check if we should log at this level
    const effectiveLevel = this.getEffectiveLevel();
    if (level > effectiveLevel) {
      return; // Skip - below threshold
    }

    // Detect error vs metadata
    let error: Error | undefined;
    let meta: object | undefined;

    if (errorOrMetadata instanceof Error) {
      error = errorOrMetadata;
      meta = metadata;
    } else {
      meta = errorOrMetadata;
    }

    // Build log event
    const logEvent: any = {
      level: levelName,
      message,
      name: this._name,
      path: this.path
    };

    // Add error if present
    if (error) {
      logEvent.error = {
        name: error.name,
        message: error.message,
        stack: error.stack
      };
    }

    // Add metadata if present
    if (meta) {
      Object.assign(logEvent, meta);
    }

    // Log to Winston
    this._logger.log(logEvent);
  }

  /**
   * Log critical message
   */
  crit(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
    this.log(LogLevel.CRIT, 'crit', message, errorOrMetadata, metadata);
  }

  /**
   * Log critical message (alias)
   */
  critical(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
    this.crit(message, errorOrMetadata, metadata);
  }

  /**
   * Log error message
   */
  error(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
    this.log(LogLevel.ERROR, 'error', message, errorOrMetadata, metadata);
  }

  /**
   * Log warning message
   */
  warn(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
    this.log(LogLevel.WARN, 'warn', message, errorOrMetadata, metadata);
  }

  /**
   * Log warning message (alias)
   */
  warning(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
    this.warn(message, errorOrMetadata, metadata);
  }

  /**
   * Log info message
   */
  info(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
    this.log(LogLevel.INFO, 'info', message, errorOrMetadata, metadata);
  }

  /**
   * Log verbose message
   */
  verbose(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
    this.log(LogLevel.VERBOSE, 'verbose', message, errorOrMetadata, metadata);
  }

  /**
   * Log debug message
   */
  debug(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
    this.log(LogLevel.DEBUG, 'debug', message, errorOrMetadata, metadata);
  }

  /**
   * Log trace message
   */
  trace(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
    this.log(LogLevel.TRACE, 'trace', message, errorOrMetadata, metadata);
  }
}
