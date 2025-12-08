/**
 * @deprecated Use LoggerEngine.root() instead
 * This class will be removed in v3.0.0
 *
 * Migration:
 * ```typescript
 * // Before:
 * const logger = new Logger('request-123');
 * const moduleLogger = logger.getLogger('myModule');
 *
 * // After:
 * const rootLogger = LoggerEngine.root();
 * const moduleLogger = rootLogger.get('myModule');
 * moduleLogger.info('Message', { requestId: 'request-123' });
 * ```
 *
 * Note: The old implementation has been removed.
 * This is a stub to maintain import compatibility.
 * Please migrate to LoggerEngine as soon as possible.
 */
export class Logger {
  public requestId: string;

  private loggerInstances: any[] = [];

  constructor(requestId: string) {
    this.requestId = requestId;
  }

  /**
   * @deprecated
   * Gets a new logger object for the specified module name. Chain of custody ID can be supplied if one applies.
   *
   * @param moduleName The name of the module for which the logging is being used.
   * @param chainOfCustodyId The chain of custody ID to assign.
   */
  public getLogger(moduleName: string, chainOfCustodyId?: string): any {
    throw new Error('Logger class has been deprecated. Use LoggerEngine.root() instead. See migration guide in README.md');
  }

  /**
   * @deprecated
   * This public function goes through each instantiated logger engine instance and updates its transports log levels to current env var
   */
  public updateLoggerTransportLevels(): void {
    throw new Error('Logger class has been deprecated. Use LoggerEngine.root() instead. See migration guide in README.md');
  }
}
