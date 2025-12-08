import type { LogLevel } from './LogLevel.js';
import type Transport from 'winston-transport';

/**
 * Options for creating a logger
 */
export interface LoggerOptions {
  /** Optional log level (undefined = inherit from parent) */
  level?: LogLevel;
  /** Optional custom transports */
  transports?: Transport[];
}

/**
 * Log event structure passed to transports
 */
export interface LogEvent {
  /** Log level name */
  level: string;
  /** Log message */
  message: string;
  /** ISO timestamp */
  timestamp: string;
  /** Logger name */
  name: string;
  /** Logger path (e.g., 'root:api:auth') */
  path: string;
  /** Optional error object */
  error?: {
    /** Error type (e.g., 'TypeError') */
    name: string;
    /** Error message */
    message: string;
    /** Stack trace */
    stack: string;
  };
  /** Additional metadata fields */
  [key: string]: any;
}

/**
 * Transport formatting options
 */
export interface TransportOptions {
  /** Timestamp display mode */
  timestamp?: 'NONE' | 'FULL' | 'TIME' | 'CUSTOM';
  /** IANA timezone name */
  timezone?: string;
  /** How to display log level */
  logLevel?: 'NONE' | 'SYMBOL' | 'NAME';
  /** Logger identification display */
  loggerName?: 'NONE' | 'NAME' | 'PATH';
  /** Exception detail level */
  exceptions?: 'BASIC' | 'FULL';
  /** Max characters before wrapping */
  maxLineLength?: number;
  /** Output format template */
  template?: string;
  /** Custom timestamp formatter */
  customTimestampFormatter?: (date: Date) => string;
}
