import { LoggerEngine } from './LoggerEngine.js';

/**
 * This is the logger access point. Creation of a new Logger should be done in one place, considering that the
 * request ID (HTTP request ID) and chain of custody IDs where appropriate.
 */
export class Logger {
  public requestId: string;

  private loggerInstances: LoggerEngine[] = [];

  constructor(requestId: string) {
    this.requestId = requestId;
  }

  /**
   * Gets a new logger object for the specified module name. Chain of custody ID can be supplied if one applies.
   *
   * @param moduleName The name of the module for which the logging is being used.
   * @param chainOfCustodyId The chain of custody ID to assign.
   */
  public getLogger(moduleName: string, chainOfCustodyId?: string): LoggerEngine {
    const newLogger = new LoggerEngine(this.requestId, moduleName, chainOfCustodyId);
    this.loggerInstances.push(newLogger);
    return newLogger;
  }

  /**
   * This public function goes through each instantiated logger engine instance and updates its transports log levels to current env var
   */
  public updateLoggerTransportLevels(): void {
    for (const loggerEngine of this.loggerInstances) {
      loggerEngine.updateTransportLevels();
    }
  }
}
