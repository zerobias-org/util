import Transport from 'winston-transport';
import { LOG_LEVEL_METADATA, LogLevel } from '../LogLevel.js';
import type { TransportOptions } from '../types.js';

export type { TransportOptions };

/**
 * Base transport class with template-based formatting
 */
export abstract class LoggerTransport extends Transport {
  protected readonly timestampMode: 'NONE' | 'FULL' | 'TIME' | 'CUSTOM';
  protected readonly timezone: string;
  protected readonly logLevelMode: 'NONE' | 'SYMBOL' | 'NAME';
  protected readonly loggerNameMode: 'NONE' | 'NAME' | 'PATH';
  protected readonly exceptionsMode: 'BASIC' | 'FULL';
  protected readonly maxLineLength: number;
  protected readonly template: string;
  protected readonly customTimestampFormatter?: (date: Date) => string;

  private lastDateMarker: string | null = null;

  // Performance optimizations: Pre-computed lookups
  private readonly levelSymbolLookup: Map<string, string> = new Map();
  private readonly levelNameLookup: Map<string, string> = new Map();
  private readonly standardFieldsSet: Set<string> = new Set(['level', 'message', 'name', 'path', 'error', 'timestamp']);
  private readonly timezoneFormatter?: Intl.DateTimeFormat;

  // Performance: Pre-compiled regex patterns
  private readonly placeholderRegexes: Map<string, RegExp> = new Map();

  constructor(options?: TransportOptions) {
    super();

    // Set defaults
    this.timestampMode = options?.timestamp || 'TIME';
    this.timezone = options?.timezone || 'GMT';
    this.logLevelMode = options?.logLevel || 'SYMBOL';
    this.loggerNameMode = options?.loggerName || 'NAME';
    this.exceptionsMode = options?.exceptions || 'BASIC';
    this.maxLineLength = options?.maxLineLength || 100;
    this.template = options?.template || '%{timestamp} %{name} [%{level}] %{message}\n%{metadata}\n%{exception}';
    this.customTimestampFormatter = options?.customTimestampFormatter;

    // Pre-compute log level lookups (O(1) instead of O(n))
    Object.entries(LOG_LEVEL_METADATA).forEach(([_, meta]) => {
      this.levelSymbolLookup.set(meta.name, meta.symbol);
      this.levelNameLookup.set(meta.name, meta.name);
    });

    // Pre-compile placeholder regexes
    const placeholders = ['timestamp', 'level', 'name', 'message', 'metadata', 'exception'];
    placeholders.forEach(ph => {
      this.placeholderRegexes.set(ph, new RegExp(`%\\{${ph}\\}`, 'g'));
    });

    // Pre-create timezone formatter for TIME mode (cached by V8)
    if (this.timestampMode === 'TIME') {
      this.timezoneFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: this.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
    }
  }

  /**
   * Format a log event using the template
   */
  protected formatLog(info: any): string {
    let output = this.template;

    // Format timestamp
    const timestamp = this.formatTimestamp(new Date());
    output = output.replace(this.placeholderRegexes.get('timestamp')!, timestamp);

    // Format log level
    const level = this.formatLogLevel(info.level);
    output = output.replace(this.placeholderRegexes.get('level')!, level);

    // Format logger name
    const name = this.formatLoggerName(info.name, info.path);
    output = output.replace(this.placeholderRegexes.get('name')!, name);

    // Format message
    output = output.replace(this.placeholderRegexes.get('message')!, info.message || '');

    // Format metadata (exclude standard fields)
    const metadata = this.formatMetadata(info);
    output = output.replace(this.placeholderRegexes.get('metadata')!, metadata);

    // Format exception
    const exception = this.formatException(info.error);
    output = output.replace(this.placeholderRegexes.get('exception')!, exception);

    // Remove empty brackets (simplified - done after all replacements)
    output = output.replace(/\[\s*\]/g, '');

    // Clean up multiple spaces
    output = output.replace(/\s+/g, ' ').trim();

    // Clean up extra newlines
    output = output.replace(/\n+/g, '\n').replace(/\n$/, '');

    return output;
  }

  /**
   * Format timestamp according to mode
   */
  protected formatTimestamp(date: Date): string {
    if (this.timestampMode === 'NONE') {
      return '';
    }

    if (this.timestampMode === 'CUSTOM' && this.customTimestampFormatter) {
      return this.customTimestampFormatter(date);
    }

    if (this.timestampMode === 'FULL') {
      return date.toISOString();
    }

    if (this.timestampMode === 'TIME' && this.timezoneFormatter) {
      // Use pre-created Intl.DateTimeFormat for efficient timezone handling
      const parts = this.timezoneFormatter.formatToParts(date);

      // Extract time components from formatter parts
      const hours = parts.find(p => p.type === 'hour')?.value || '00';
      const minutes = parts.find(p => p.type === 'minute')?.value || '00';
      const seconds = parts.find(p => p.type === 'second')?.value || '00';

      // Get milliseconds with padding (preserves precision from original Date)
      const ms = date.getMilliseconds();
      const milliseconds = ms < 10 ? `00${ms}` : ms < 100 ? `0${ms}` : `${ms}`;

      // Check if we need a date marker (when day changes)
      const year = parts.find(p => p.type === 'year')?.value || '';
      const month = parts.find(p => p.type === 'month')?.value || '';
      const day = parts.find(p => p.type === 'day')?.value || '';
      const currentDateMarker = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;

      let marker = '';
      if (this.lastDateMarker !== currentDateMarker) {
        this.lastDateMarker = currentDateMarker;
        marker = `--- ${currentDateMarker} (${this.timezone}) ---\n`;
      }

      return marker + `${hours}:${minutes}:${seconds}.${milliseconds}`;
    }

    return '';
  }

  /**
   * Format log level according to mode
   */
  protected formatLogLevel(level: string): string {
    if (this.logLevelMode === 'NONE') {
      return '';
    }

    if (this.logLevelMode === 'SYMBOL') {
      return this.levelSymbolLookup.get(level) || level;
    }

    if (this.logLevelMode === 'NAME') {
      return this.levelNameLookup.get(level) || level;
    }

    return '';
  }

  /**
   * Format logger name according to mode
   */
  protected formatLoggerName(name: string, path: string): string {
    if (this.loggerNameMode === 'NONE') {
      return '';
    }

    // Omit root logger name/path to reduce noise
    if (name === 'root' || path === 'root') {
      return '';
    }

    if (this.loggerNameMode === 'NAME') {
      return name ? `[${name}]` : '';
    }

    if (this.loggerNameMode === 'PATH') {
      return path ? `[${path}]` : '';
    }

    return '';
  }

  /**
   * Format metadata (exclude standard fields)
   */
  protected formatMetadata(info: any): string {
    const metadata: Record<string, any> = {};
    let hasMetadata = false;

    for (const key in info) {
      if (!this.standardFieldsSet.has(key) && info[key] !== undefined) {
        metadata[key] = info[key];
        hasMetadata = true;
      }
    }

    if (!hasMetadata) {
      return '';
    }

    return JSON.stringify(metadata);
  }

  /**
   * Format exception according to mode
   */
  protected formatException(error?: { name: string; message: string; stack?: string }): string {
    if (!error) {
      return '';
    }

    if (this.exceptionsMode === 'BASIC') {
      // Error message and first line of stack
      const firstLine = error.stack?.split('\n')[1]?.trim() || '';
      return `${error.name}: ${error.message}\n  at ${firstLine}`;
    }

    if (this.exceptionsMode === 'FULL') {
      // Complete stack trace
      return error.stack || `${error.name}: ${error.message}`;
    }

    return '';
  }

  /**
   * Apply color to text (override in subclasses for ANSI support)
   */
  protected applyColor(text: string, color: string): string {
    // Base class doesn't apply color
    return text;
  }

  /**
   * Abstract method for output - subclasses implement this
   */
  abstract log(info: any, callback: () => void): void;
}
