import chalk from 'chalk';
import { LoggerTransport, TransportOptions } from './LoggerTransport.js';
import { LOG_LEVEL_METADATA, LogLevel } from '../LogLevel.js';
import { LoggerEngine } from '../LoggerEngine.js';

/**
 * CLI Transport - ANSI color support for terminals
 *
 * Enhanced terminal output with:
 * - ANSI color codes for log levels
 * - Color-aware formatting
 * - Optimized for CLI usage
 *
 * To install as default transport:
 *   CLITransport.install()
 */
export class CLITransport extends LoggerTransport {
  constructor(options?: TransportOptions) {
    super(options);
  }

  /**
   * Install CLITransport as the root logger's default transport
   * Removes ConsoleTransport and adds CLITransport
   */
  static install(options?: TransportOptions): void {
    const root = LoggerEngine.root();

    // Remove all existing transports
    const existingTransports = [...root.transports];
    for (const t of existingTransports) root.removeTransport(t);

    // Add CLI transport
    root.addTransport(new CLITransport(options));
  }

  /**
   * Apply color to text using chalk
   */
  protected applyColor(text: string, color: string): string {
    switch (color) {
      case 'red': {
        return chalk.red(text);
      }
      case 'bold red': {
        return chalk.bold.red(text);
      }
      case 'yellow': {
        return chalk.yellow(text);
      }
      case 'green': {
        return chalk.green(text);
      }
      case 'blue': {
        return chalk.blue(text);
      }
      case 'magenta': {
        return chalk.magenta(text);
      }
      case 'cyan': {
        return chalk.cyan(text);
      }
      case 'bold': {
        return chalk.bold(text);
      }
      default: {
        return text;
      }
    }
  }

  /**
   * Format log with colors
   */
  protected formatLog(info: any): string {
    // Get base formatted output
    let output = super.formatLog(info);

    // Apply color based on log level
    const level = info.level?.toLowerCase() || 'info';
    const logLevelEntry = Object.entries(LOG_LEVEL_METADATA).find(
      ([_, meta]) => meta.name === level
    );

    if (logLevelEntry) {
      const [_, metadata] = logLevelEntry;
      const color = metadata.color;

      // Color the entire output
      output = this.applyColor(output, color);
    }

    return output;
  }

  log(info: any, callback: () => void): void {
    const formatted = this.formatLog(info);

    // All output goes to stdout for CLI
    // (stderr is reserved for actual errors from the process)
    process.stdout.write(formatted + '\n');

    callback();
  }
}
