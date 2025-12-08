/**
 * Log severity levels
 * Lower numeric value = higher severity (matches Winston convention)
 */
export enum LogLevel {
  CRIT = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  VERBOSE = 4,
  DEBUG = 5,
  TRACE = 6
}

/**
 * Metadata associated with each log level
 */
export interface LogLevelMetadata {
  /** Level name (e.g., 'crit', 'error') */
  name: string;
  /** Numeric value (0-6) */
  value: number;
  /** Symbol for CLI output (e.g., '!!!', '!!') */
  symbol: string;
  /** ANSI color name */
  color: string;
}

/**
 * Metadata for each log level
 */
export const LOG_LEVEL_METADATA: Record<LogLevel, LogLevelMetadata> = {
  [LogLevel.CRIT]: {
    name: 'crit',
    value: 0,
    symbol: '!!!',
    color: 'red'
  },
  [LogLevel.ERROR]: {
    name: 'error',
    value: 1,
    symbol: '!!',
    color: 'bold red'
  },
  [LogLevel.WARN]: {
    name: 'warn',
    value: 2,
    symbol: '!',
    color: 'yellow'
  },
  [LogLevel.INFO]: {
    name: 'info',
    value: 3,
    symbol: '',
    color: 'green'
  },
  [LogLevel.VERBOSE]: {
    name: 'verbose',
    value: 4,
    symbol: '*',
    color: 'blue'
  },
  [LogLevel.DEBUG]: {
    name: 'debug',
    value: 5,
    symbol: '**',
    color: 'blue'
  },
  [LogLevel.TRACE]: {
    name: 'trace',
    value: 6,
    symbol: '***',
    color: 'magenta'
  }
};
