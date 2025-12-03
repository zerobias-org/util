import winston, { transports } from 'winston';

const { combine, timestamp, label, printf, colorize } = winston.format;

const EXEMPT_LOGGER_ID = '12345678-ABCD-1234-5678-ABCDEFABCDEF';

function getMyFormat(requestId: string, chainOfCustodyId?: string) {
  return printf(({
    level, message, label: labelValue, timestamp: ts,
  }) => {
    const { logMessage, jsonDetails } = message as { logMessage: string; jsonDetails?: object };
    if (chainOfCustodyId) {
      if (jsonDetails) {
        if (requestId === EXEMPT_LOGGER_ID) {
          return `${chainOfCustodyId} [${labelValue}] ${level} ${logMessage} `
                  + `${JSON.stringify(jsonDetails)}`;
        }
        if (process.env.LOCAL) {
          return `${requestId}|${chainOfCustodyId} [${labelValue}] ${level} ${logMessage} `
                  + `${JSON.stringify(jsonDetails)}`;
        }
        return `${ts} ${requestId}|${chainOfCustodyId} [${labelValue}] ${level} `
                + `${logMessage} ${JSON.stringify(jsonDetails)}`;
      }
      if (requestId === EXEMPT_LOGGER_ID) {
        return `${chainOfCustodyId} [${labelValue}] ${level} ${logMessage}`;
      }
      if (process.env.LOCAL) {
        return `${requestId}|${chainOfCustodyId} [${labelValue}] ${level} ${logMessage}`;
      }
      return `${ts} ${requestId}|${chainOfCustodyId} [${labelValue}] ${level} `
          + `${logMessage}`;
    }
    if (jsonDetails) {
      if (requestId === EXEMPT_LOGGER_ID) {
        return `[${labelValue}] ${level} ${logMessage} ${JSON.stringify(jsonDetails)}`;
      }
      if (process.env.LOCAL) {
        return `${requestId} [${labelValue}] ${level} ${logMessage} `
                + `${JSON.stringify(jsonDetails)}`;
      }
      return `${ts} ${requestId} [${labelValue}] ${level} ${logMessage} `
              + `${JSON.stringify(jsonDetails)}`;
    }
    if (requestId === EXEMPT_LOGGER_ID) {
      return `[${labelValue}] ${level} ${logMessage}`;
    }
    if (process.env.LOCAL) {
      return `${requestId} [${labelValue}] ${level} ${logMessage}`;
    }
    return `${ts} ${requestId} [${labelValue}] ${level} ${logMessage}`;
  });
}

/**
 * The platform logger engine. This is responsible for logging all messages in the platform.
 */
export class LoggerEngine {
  public requestId: string;

  private readonly moduleName: string;

  private readonly chainOfCustodyId?: string;

  private sumologicTransport: { type: string; config: object; level?: string } | undefined;

  private consoleTransport: winston.transports.ConsoleTransportInstance;

  private readonly logger: winston.Logger;

  private readonly LEVEL_ALL: number = 0;

  private readonly LEVEL_TRACE: number = 1;

  private readonly LEVEL_DEBUG: number = 2;

  private readonly LEVEL_INFO: number = 3;

  private readonly LEVEL_WARN: number = 4;

  private readonly LEVEL_ERROR: number = 5;

  private readonly LEVEL_CRIT: number = 6;

  constructor(requestId: string, moduleName: string, chainOfCustodyId?: string) {
    this.requestId = requestId;
    this.moduleName = moduleName;
    this.chainOfCustodyId = chainOfCustodyId;

    const myFormat = getMyFormat(this.requestId, this.chainOfCustodyId);
    const transportsList: winston.transport[] = [];

    // If we have a SumoLogic endpoint set, that will be added here as a transport layer.
    if (process.env.SUMOLOGIC_ENDPOINT != null) {
      this.sumologicTransport = {
        type: 'SumoLogic',
        config: {
          url: process.env.SUMOLOGIC_ENDPOINT,
          level: process.env.LOG_LEVEL ?? 'info',
          meta: {
            requestId: this.requestId,
            moduleName: this.moduleName,
            chainOfCustodyId: this.chainOfCustodyId ?? '',
          },
        },
      };
      // Note: SumoLogic transport would need to be added separately if needed
    }

    // Console is ALWAYS pushed as a transport layer.
    this.consoleTransport = new transports.Console({
      level: process.env.LOG_LEVEL ?? 'info',
      format: combine(
        colorize({
          colors: {
            debug: 'blue',
            info: 'green',
            warning: 'yellow',
            error: 'bold red',
            crit: 'red',
          },
        }),
        label({ label: this.moduleName }),
        timestamp(),
        myFormat
      ),
    });
    transportsList.push(this.consoleTransport);

    this.logger = winston.createLogger({
      levels: winston.config.syslog.levels,
      transports: transportsList,
    });
  }

  updateTransportLevels(): void {
    if (this.sumologicTransport) {
      this.sumologicTransport.level = process.env.LOG_LEVEL ?? 'info';
    }

    this.consoleTransport.level = process.env.LOG_LEVEL ?? 'info';
  }

  private logLevel(level: string): number {
    if (level) {
      switch (level.toLowerCase()) {
        case 'trace': return this.LEVEL_TRACE;
        case 'debug': return this.LEVEL_DEBUG;
        case 'info': return this.LEVEL_INFO;
        case 'warn': return this.LEVEL_WARN;
        case 'error': return this.LEVEL_ERROR;
        case 'crit': return this.LEVEL_CRIT;
        default: return this.LEVEL_ALL;
      }
    }

    return this.LEVEL_ALL;
  }

  private canLog(level: string): boolean {
    const currentLevel: number = this.logLevel(process.env.LOG_LEVEL ?? '');
    const compareLevel: number = this.logLevel(level);
    return compareLevel >= currentLevel;
  }

  debug(msg: string, jsonDetails?: object): void {
    if (this.canLog('debug')) {
      if (jsonDetails != null) {
        this.logger.log({ level: 'debug', message: { logMessage: msg, jsonDetails } as unknown as string });
      } else {
        this.logger.log({ level: 'debug', message: { logMessage: msg } as unknown as string });
      }
    }
  }

  info(msg: string, jsonDetails?: object): void {
    if (this.canLog('info')) {
      if (jsonDetails != null) {
        this.logger.log({ level: 'info', message: { logMessage: msg, jsonDetails } as unknown as string });
      } else {
        this.logger.log({ level: 'info', message: { logMessage: msg } as unknown as string });
      }
    }
  }

  warn(msg: string, jsonDetails?: object): void {
    if (this.canLog('warn')) {
      if (jsonDetails != null) {
        this.logger.log({ level: 'warning', message: { logMessage: msg, jsonDetails } as unknown as string });
      } else {
        this.logger.log({ level: 'warning', message: { logMessage: msg } as unknown as string });
      }
    }
  }

  warning(msg: string, jsonDetails?: object): void {
    this.warn(msg, jsonDetails);
  }

  error(msg: string, jsonDetails?: object): void {
    if (this.canLog('error')) {
      if (jsonDetails != null) {
        this.logger.log({ level: 'error', message: { logMessage: msg, jsonDetails } as unknown as string });
      } else {
        this.logger.log({ level: 'error', message: { logMessage: msg } as unknown as string });
      }
    }
  }

  crit(msg: string, jsonDetails?: object): void {
    if (this.canLog('crit')) {
      if (jsonDetails != null) {
        this.logger.log({ level: 'crit', message: { logMessage: msg, jsonDetails } as unknown as string });
      } else {
        this.logger.log({ level: 'crit', message: { logMessage: msg } as unknown as string });
      }
    }
  }

  critical(msg: string, jsonDetails?: object): void {
    this.crit(msg, jsonDetails);
  }
}
