import { LoggerTransport, TransportOptions } from './LoggerTransport.js';

/**
 * Console transport - outputs to console object methods
 *
 * Maps log levels to console methods:
 * - crit/error -> console.error()
 * - warn -> console.warn()
 * - info -> console.info()
 * - verbose/debug/trace -> console.log()
 *
 * Works in both Node.js and browser environments.
 * No color support (use CLITransport for ANSI colors).
 */
export class ConsoleTransport extends LoggerTransport {
  constructor(options?: TransportOptions) {
    super(options);
  }

  log(info: any, callback: () => void): void {
    const formatted = this.formatLog(info);

    // Map log levels to console methods
    const level = info.level?.toLowerCase() || 'info';

    switch (level) {
      case 'crit':
      case 'error':
        console.error(formatted);
        break;
      case 'warning':
      case 'warn':
        console.warn(formatted);
        break;
      case 'info':
        console.info(formatted);
        break;
      case 'verbose':
      case 'debug':
      case 'trace':
      default:
        console.log(formatted);
        break;
    }

    callback();
  }
}
