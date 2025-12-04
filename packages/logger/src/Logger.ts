import * as winston from 'winston';
import { format as utilFormat } from 'node:util';
import TransportStream from 'winston-transport';

const { format } = winston;

function transform(info: any): any {
  const args = info[Symbol.for('splat')];
  const tempInfo = info;

  if (args) {
    tempInfo.message = utilFormat(tempInfo.message, ...args);
  }

  return tempInfo;
}

function utilFormatter() {
  return { transform };
}

function getTransportsFromConfig(config: any, defaultLogLevel: string = 'info'): {
  transports: TransportStream[];
  logMessage: string;
  warnings: string;
} {
  let logMessage = '';
  const warnings = '';
  const transports: TransportStream[] = [
    new winston.transports.Console({
      level: defaultLogLevel,
      format: format.combine(
        format.colorize(),
        format.printf(({ level, message, timestamp }) => {
          let newMessage = message;
          if (typeof message === 'object' || Array.isArray(message)) {
            newMessage = JSON.stringify(newMessage);
          }

          return `${timestamp} ${level}: ${newMessage}`;
        }),
      ),
      handleExceptions: true,
    }),
  ];

  logMessage += 'Console';

  return { transports, logMessage, warnings };
}

/**
 * Retrieves or creates an instance of winston logger based off tags and given options
 * @param labelName - Label to give the created winston logger
 * @param config - Object containing array of transports to add to logger
 * @param defaultLogLevel - Default log level (defaults to 'info')
 * @returns A winston Logger instance
 */
export function getLogger(labelName: string, config: any = {}, defaultLogLevel: string = 'info'): winston.Logger {
  let loggerStatus = 'existed';
  let logMessage = '';
  let warnings = '';
  let logger: winston.Logger;

  if (!winston.loggers.has(labelName)) {
    loggerStatus = 'created';
    const response = getTransportsFromConfig(config, defaultLogLevel);
    logMessage += response.logMessage;
    warnings += response.warnings;

    winston.loggers.add(labelName, {
      format: format.combine(
        format.label({ label: labelName }),
        format.json(),
        format.timestamp({ format: 'MM-DD-YYYY HH:mm:ss.SSS' }),
        utilFormatter(),
      ),
      transports: response.transports,
      levels: winston.config.syslog.levels,
      exitOnError: true,
    });

    logger = winston.loggers.get(labelName);
  } else if (Object.prototype.hasOwnProperty.call(config, 'transports')) {
    loggerStatus = 'modified';
    logger = winston.loggers.get(labelName);
    logger.clear();
    const response = getTransportsFromConfig(config);
    logMessage += response.logMessage;
    warnings += response.warnings;
    for (const transport of response.transports) {
      logger.add(transport);
    }
  } else {
    logger = winston.loggers.get(labelName);
  }

  if (loggerStatus === 'created') {
    logger.debug(`Successfully created new logger with transports: ${logMessage}.`);
  } else if (loggerStatus === 'modified') {
    logger.debug(`Successfully found logger but modified with new transports: ${logMessage}.`);
  } else {
    logger.debug(`Logger with label '${labelName}' already exists, successfully got and just returning it.`);
  }

  if (warnings !== '') {
    logger.warning(`The following warnings occured when added transports: ${warnings}`);
  }

  return logger;
}
