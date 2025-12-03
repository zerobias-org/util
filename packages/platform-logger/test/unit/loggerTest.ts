import { expect } from 'chai';
import { Logger } from '../../src/index.js';

describe('#Logger', () => {
  const loggerInstance = new Logger('TestRequest1');
  const logger = loggerInstance.getLogger('testModuleNoCustody');
  const custodyLogger = loggerInstance.getLogger('testModuleWithCustody', 'chain2345');
  const loglessInstance = new Logger('12345678-ABCD-1234-5678-ABCDEFABCDEF').getLogger('testModuleWithoutRequestId');

  it('should log to debug', () => {
    logger.debug('Test debug message.');
  });

  it('should log to info', () => {
    logger.info('Test info message.', {
      test1: 'test1',
      test2: 'test2',
    });
  });

  it('should log to warn', () => {
    logger.warn('Test warn message.');
    logger.warning('Test warn message.');
  });

  it('should log to error', () => {
    logger.error('Test error message.');
  });

  it('should log to crit', () => {
    logger.crit('Test crit message.');
    logger.critical('Test crit message.');
  });

  it('should chain-of-custody log to debug', () => {
    custodyLogger.debug('Test debug message.');
  });

  it('should chain-of-custody log to info', () => {
    custodyLogger.info('Test info message.', {
      test1: 'test1',
      test2: 'test2',
    });
  });

  it('should chain-of-custody log to warn', () => {
    custodyLogger.warn('Test warn message.');
    custodyLogger.warning('Test warn message.');
  });

  it('should chain-of-custody log to error', () => {
    custodyLogger.error('Test error message.');
  });

  it('should log different request IDs', () => {
    custodyLogger.info('Default request ID');
    custodyLogger.requestId = '1';
    custodyLogger.info('Default request ID set to 1');
    custodyLogger.requestId = '2';
    custodyLogger.info('Default request ID set to 2');
    custodyLogger.requestId = '3';
    custodyLogger.info('Default request ID set to 3');
    custodyLogger.requestId = 'TestRequest1';
    custodyLogger.info('Default request ID set back to TestRequest1');
  });

  it('should chain-of-custody log to crit', () => {
    custodyLogger.crit('Test crit message.');
    custodyLogger.critical('Test crit message.');
  });

  it('should log extra data in a JSON object', () => {
    logger.info('Message with JSON', { 'value1': '1', 'value2': '2' });
  });

  it('should privately log to debug', () => {
    loglessInstance.debug('Test debug message.');
  });

  it('should privately log to info', () => {
    loglessInstance.info('Test info message.');
  });

  it('privately log to warn', () => {
    loglessInstance.warn('Test warn message.');
    loglessInstance.warning('Test warn message.');
  });

  it('should privately log to error', () => {
    loglessInstance.error('Test error message.');
  });

  it('should privately log to crit', () => {
    loglessInstance.crit('Test crit message.');
    loglessInstance.critical('Test crit message.');
  });

  it('should log all as debug', () => {
    process.env.LOG_LEVEL = 'debug';
    loggerInstance.updateLoggerTransportLevels();
    logger.debug('Test Debug');
    logger.info('Test Debug');
    logger.warn('Test Debug');
    logger.error('Test Debug');
    logger.crit('Test Debug');
  });

  it('should log only crit after reload', () => {
    process.env.LOG_LEVEL = 'crit';
    loggerInstance.updateLoggerTransportLevels();
    logger.debug('Test crit');
    logger.info('Test crit');
    logger.warn('Test crit');
    logger.error('Test crit');
    logger.crit('Test crit');
  });

  it('should log all as debug again', () => {
    process.env.LOG_LEVEL = 'debug';
    loggerInstance.updateLoggerTransportLevels();
    logger.debug('Test Debug');
    logger.info('Test Debug');
    logger.warn('Test Debug');
    logger.error('Test Debug');
    logger.crit('Test Debug');
  });

  it('should create logger with Logger class', () => {
    const testLogger = new Logger('test-request-id');
    expect(testLogger.requestId).to.equal('test-request-id');
    const engine = testLogger.getLogger('test-module');
    expect(engine).to.be.ok;
  });
});
