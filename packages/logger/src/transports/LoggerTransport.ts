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
  }

  /**
   * Format a log event using the template
   */
  protected formatLog(info: any): string {
    let output = this.template;

    // Format timestamp
    const timestamp = this.formatTimestamp(new Date());
    output = output.replace(/%\{timestamp\}/g, timestamp);

    // Format log level
    const level = this.formatLogLevel(info.level);
    output = output.replace(/%\{level\}/g, level);

    // Format logger name
    const name = this.formatLoggerName(info.name, info.path);
    output = output.replace(/%\{name\}/g, name);

    // Format message
    output = output.replace(/%\{message\}/g, info.message || '');

    // Format metadata (exclude standard fields)
    const metadata = this.formatMetadata(info);
    output = output.replace(/%\{metadata\}/g, metadata);

    // Format exception
    const exception = this.formatException(info.error);
    output = output.replace(/%\{exception\}/g, exception);

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

    // Convert to specified timezone
    const dateString = date.toLocaleString('en-US', {
      timeZone: this.timezone
    });
    const localDate = new Date(dateString);

    if (this.timestampMode === 'FULL') {
      return date.toISOString();
    }

    if (this.timestampMode === 'TIME') {
      // Check if we need a date marker (hourly)
      const currentDateMarker = this.getDateMarker(localDate);
      let marker = '';

      if (this.lastDateMarker !== currentDateMarker) {
        this.lastDateMarker = currentDateMarker;
        marker = `--- ${currentDateMarker} ---\n`;
      }

      const hours = String(localDate.getHours()).padStart(2, '0');
      const minutes = String(localDate.getMinutes()).padStart(2, '0');
      const seconds = String(localDate.getSeconds()).padStart(2, '0');
      const milliseconds = String(localDate.getMilliseconds()).padStart(3, '0');

      return marker + `${hours}:${minutes}:${seconds}.${milliseconds}`;
    }

    return '';
  }

  /**
   * Get date marker for TIME mode (YYYY-MM-DD)
   */
  protected getDateMarker(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Format log level according to mode
   */
  protected formatLogLevel(level: string): string {
    if (this.logLevelMode === 'NONE') {
      return '';
    }

    // Find matching log level
    const logLevelEntry = Object.entries(LOG_LEVEL_METADATA).find(
      ([_, meta]) => meta.name === level
    );

    if (!logLevelEntry) {
      return level; // Fallback to raw level
    }

    const [_, metadata] = logLevelEntry;

    if (this.logLevelMode === 'SYMBOL') {
      return metadata.symbol;
    }

    if (this.logLevelMode === 'NAME') {
      return metadata.name;
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
    const standardFields = ['level', 'message', 'name', 'path', 'error', 'timestamp'];
    const metadata: Record<string, any> = {};

    for (const key in info) {
      if (!standardFields.includes(key) && info[key] !== undefined) {
        metadata[key] = info[key];
      }
    }

    if (Object.keys(metadata).length === 0) {
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
