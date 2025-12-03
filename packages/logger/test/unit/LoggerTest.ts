import { expect } from 'chai';
import { getLogger } from '../../src/Logger.js';

describe('Logger', () => {
  describe('test if no transport logging works without error', () => {
    const logger = getLogger('console');

    it('should log to console', async () => {
      try {
        logger.log({
          level: 'info',
          message: 'Test',
        });

        const data = 'Test';
        logger.info('%s', data);
        expect(logger).to.be.ok;
      } catch (error: any) {
        expect.fail(`Error unexpected, ${error.stack}`);
      }
    });
  });

  describe('test logger retrieval', () => {
    it('should return existing logger when called with same label', () => {
      const logger1 = getLogger('test-label');
      const logger2 = getLogger('test-label');
      expect(logger1).to.equal(logger2);
    });

    it('should create different loggers for different labels', () => {
      const logger1 = getLogger('label-a');
      const logger2 = getLogger('label-b');
      expect(logger1).to.not.equal(logger2);
    });
  });

  describe('test log levels', () => {
    it('should support different log levels', () => {
      const logger = getLogger('levels-test', {}, 'debug');
      expect(logger).to.be.ok;

      // These should not throw
      logger.debug('debug message');
      logger.info('info message');
      logger.notice('notice message');
      logger.warning('warning message');
      logger.error('error message');
    });
  });
});
