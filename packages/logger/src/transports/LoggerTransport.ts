import Transport from 'winston-transport';
import { LOG_LEVEL_METADATA, LogLevel } from '../LogLevel.js';
import type { TransportOptions } from '../types.js';
import { TransportType } from '../TransportType.js';



/**
 * Base transport class with template-based formatting
 */
export abstract class LoggerTransport extends Transport {
  /** Well-known transport type for programmatic identification */
  public readonly transportType: TransportType;

  protected timestampMode!: 'NONE' | 'FULL' | 'TIME' | 'CUSTOM';
  protected timezone!: string;
  protected logLevelMode!: 'NONE' | 'SYMBOL' | 'NAME';
  protected loggerNameMode!: 'NONE' | 'NAME' | 'PATH';
  protected exceptionsMode!: 'BASIC' | 'FULL';
  protected maxLineLength!: number;
  protected template!: string;
  protected customTimestampFormatter?: (date: Date) => string;

  private lastDateMarker: string | null = null;

  // Performance optimizations: Pre-computed lookups
  private readonly levelSymbolLookup: Map<string, string> = new Map();
  private readonly levelNameLookup: Map<string, string> = new Map();
  private readonly standardFieldsSet: Set<string> = new Set(['level', 'message', 'name', 'path', 'error', 'timestamp']);
  private timezoneFormatter?: Intl.DateTimeFormat;

  // Performance: Pre-compiled regex patterns
  private placeholderRegexes: Map<string, RegExp> = new Map();

  constructor(transportType: TransportType, options?: TransportOptions) {
    super();
    this.transportType = transportType;

    // Initialize level lookups (these never change)
    for (const [_, meta] of Object.entries(LOG_LEVEL_METADATA)) {
      this.levelSymbolLookup.set(meta.name, meta.symbol);
      this.levelNameLookup.set(meta.name, meta.name);
    }

    // Apply initial configuration
    this.apply(options || {});
  }

  /**
   * Apply configuration options (partial or full)
   * Can be called at construction or runtime to reconfigure the transport
   */
  apply(options: Partial<TransportOptions>): void {
    // Track what changed to minimize downstream recomputation
    const timestampChanged = options.timestamp !== undefined && options.timestamp !== this.timestampMode;
    const timezoneChanged = options.timezone !== undefined && options.timezone !== this.timezone;
    const templateChanged = options.template !== undefined && options.template !== this.template;

    // Update configuration
    if (options.timestamp !== undefined) {
      this.timestampMode = options.timestamp;
    } else if (!this.timestampMode) {
      this.timestampMode = 'TIME';
    }

    if (options.timezone !== undefined) {
      this.timezone = options.timezone;
    } else if (!this.timezone) {
      this.timezone = 'GMT';
    }

    if (options.logLevel !== undefined) {
      this.logLevelMode = options.logLevel;
    } else if (!this.logLevelMode) {
      this.logLevelMode = 'NAME';
    }

    if (options.loggerName !== undefined) {
      this.loggerNameMode = options.loggerName;
    } else if (!this.loggerNameMode) {
      this.loggerNameMode = 'PATH';
    }

    if (options.exceptions !== undefined) {
      this.exceptionsMode = options.exceptions;
    } else if (!this.exceptionsMode) {
      this.exceptionsMode = 'BASIC';
    }

    if (options.maxLineLength !== undefined) {
      this.maxLineLength = options.maxLineLength;
    } else if (!this.maxLineLength) {
      this.maxLineLength = 100;
    }

    if (options.template !== undefined) {
      this.template = options.template;
    } else if (!this.template) {
      this.template = '%{timestamp} %{name} [%{level}] %{message}\n%{metadata}\n%{exception}';
    }

    if (options.customTimestampFormatter !== undefined) {
      this.customTimestampFormatter = options.customTimestampFormatter;
    }

    // Recompute downstream state if needed

    // Reset date marker if timezone changed
    if (timezoneChanged) {
      this.lastDateMarker = null;
    }

    // Re-create timezone formatter if timestamp mode or timezone changed (cached for performance)
    // Also create if we need one but don't have it yet (handles default initialization)
    const needsFormatter = (this.timestampMode === 'TIME' || this.timestampMode === 'FULL');
    const shouldCreateFormatter = timestampChanged || timezoneChanged || (needsFormatter && !this.timezoneFormatter);

    if (shouldCreateFormatter) {
      this.timezoneFormatter = needsFormatter ? new Intl.DateTimeFormat('en-CA', {
          timeZone: this.timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }) : undefined;
    }

    // Re-compile placeholder regexes if template changed
    if (templateChanged || this.placeholderRegexes.size === 0) {
      this.placeholderRegexes.clear();
      const placeholders = ['timestamp', 'level', 'name', 'message', 'metadata', 'exception'];
      for (const ph of placeholders) {
        this.placeholderRegexes.set(ph, new RegExp(String.raw`%\{${ph}\}`, 'g'));
      }
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

    // Remove empty brackets from template structure BEFORE inserting user content
    // This prevents stripping valid [] from JSON in message/metadata/exception
    output = output.replaceAll(/\[\s*]/g, '');

    // Format message (after bracket cleanup to preserve JSON arrays)
    output = output.replace(this.placeholderRegexes.get('message')!, info.message || '');

    // Format metadata (exclude standard fields)
    const metadata = this.formatMetadata(info);
    output = output.replace(this.placeholderRegexes.get('metadata')!, metadata);

    // Format exception
    const exception = this.formatException(info.error);
    output = output.replace(this.placeholderRegexes.get('exception')!, exception);

    // Clean up multiple spaces (use [^\S\n]+ to match spaces/tabs but NOT newlines)
    output = output.replaceAll(/[^\S\n]+/g, ' ').trim();

    // Clean up extra newlines
    output = output.replaceAll(/\n+/g, '\n').replace(/\n$/, '');

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
      // Format full timestamp: YYYY-MM-DDTHH:mm:ss.SSS (timezone)
      // Uses cached formatter for performance
      if (this.timezoneFormatter) {
        const formatted = this.timezoneFormatter.format(date).replace(', ', 'T');
        const ms = date.getMilliseconds().toString().padStart(3, '0');
        return `${formatted}.${ms} (${this.timezone})`;
      }
      return date.toISOString();
    }

    if (this.timestampMode === 'TIME') {
      // Format time only: HH:mm:ss.SSS with date marker on day change
      // Uses cached formatter for performance
      if (this.timezoneFormatter) {
        const fullDate = this.timezoneFormatter.format(date);
        const [dateStr, timeStr] = fullDate.split(', ');
        const ms = date.getMilliseconds().toString().padStart(3, '0');

        let marker = '';
        if (this.lastDateMarker !== dateStr) {
          this.lastDateMarker = dateStr;
          marker = `--- ${dateStr} (${this.timezone}) ---\n`;
        }

        return marker + `${timeStr}.${ms}`;
      }
      return '';
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

    for (const key of Object.keys(info)) {
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

export {type TransportOptions} from '../types.js';
