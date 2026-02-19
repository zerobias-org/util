// Browser-compatible entry point
// Exports a lightweight LoggerEngine backed by console.* instead of winston.
// No Node.js dependencies (no winston, winston-transport, chalk, or process).

export { LoggerEngine } from './BrowserLoggerEngine.js';
export type { BrowserLoggerOptions as LoggerOptions } from './BrowserLoggerEngine.js';
export { LogLevel, LOG_LEVEL_METADATA } from './LogLevel.js';
export { TransportType } from './TransportType.js';
export type { LogEvent, TransportOptions } from './types.js';

// Browser stubs for Node.js-only exports
export class ParentTransport {
  constructor(_forwardFn: any) {
    // No-op in browser
  }
}

export class LoggerTransport {
  constructor(_transportType: any, _options?: any) {
    // No-op in browser
  }
}

export class ConsoleTransport {
  constructor(_options?: any) {
    // No-op in browser - LoggerEngine uses console.* directly
  }
}

export class CLITransport {
  constructor(_options?: any) {
    // No-op in browser
  }
  static install(_options?: any): void {
    // No-op in browser
  }
}

// Deprecated stub
export class Logger {
  public requestId: string;
  constructor(requestId: string) {
    this.requestId = requestId;
  }
  public getLogger(_moduleName: string, _chainOfCustodyId?: string): any {
    throw new Error('Logger class has been deprecated. Use LoggerEngine.root() instead.');
  }
  public updateLoggerTransportLevels(): void {
    throw new Error('Logger class has been deprecated. Use LoggerEngine.root() instead.');
  }
}
