import { expect } from 'chai';
import { LoggerEngine, LogLevel } from '../../src/index.js';
import Transport from 'winston-transport';

// Custom in-memory transport for testing
class MemoryTransport extends Transport {
  public logs: any[] = [];

  log(info: any, callback: () => void): void {
    this.logs.push(info);
    callback();
  }
}

describe('Logging Methods', () => {
  let root: LoggerEngine;
  let memoryTransport: MemoryTransport;

  beforeEach(() => {
    root = LoggerEngine.root();

    // Remove all existing transports
    root.transports.forEach(t => root.removeTransport(t));

    // Add memory transport
    memoryTransport = new MemoryTransport();
    root.addTransport(memoryTransport);

    // Reset root level to default
    root.setLevel(LogLevel.INFO);
  });

  afterEach(() => {
    // Clear logs between tests
    if (memoryTransport) {
      memoryTransport.logs = [];
    }
  });

  // Helper to get captured logs
  function getCapturedLogs(): any[] {
    return memoryTransport.logs;
  }

  describe('All Log Levels', () => {
    it('should log crit message', () => {
      root.crit('Critical message');
      const logs = getCapturedLogs();
      expect(logs).to.have.lengthOf(1);
      expect(logs[0].level).to.equal('crit');
      expect(logs[0].message).to.equal('Critical message');
    });

    it('should log critical message (alias)', () => {
      root.critical('Critical message');
      expect(getCapturedLogs()).to.have.lengthOf(1);
      expect(getCapturedLogs()[0].level).to.equal('crit');
    });

    it('should log error message', () => {
      root.error('Error message');
      expect(getCapturedLogs()).to.have.lengthOf(1);
      expect(getCapturedLogs()[0].level).to.equal('error');
      expect(getCapturedLogs()[0].message).to.equal('Error message');
    });

    it('should log warn message', () => {
      root.warn('Warning message');
      expect(getCapturedLogs()).to.have.lengthOf(1);
      expect(getCapturedLogs()[0].level).to.equal('warning');
      expect(getCapturedLogs()[0].message).to.equal('Warning message');
    });

    it('should log warning message (alias)', () => {
      root.warning('Warning message');
      expect(getCapturedLogs()).to.have.lengthOf(1);
      expect(getCapturedLogs()[0].level).to.equal('warning');
    });

    it('should log info message', () => {
      root.info('Info message');
      expect(getCapturedLogs()).to.have.lengthOf(1);
      expect(getCapturedLogs()[0].level).to.equal('info');
      expect(getCapturedLogs()[0].message).to.equal('Info message');
    });

    it('should log verbose message', () => {
      root.setLevel(LogLevel.VERBOSE);
      root.verbose('Verbose message');
      expect(getCapturedLogs()).to.have.lengthOf(1);
      expect(getCapturedLogs()[0].level).to.equal('verbose');
      expect(getCapturedLogs()[0].message).to.equal('Verbose message');
    });

    it('should log debug message', () => {
      root.setLevel(LogLevel.DEBUG);
      root.debug('Debug message');
      expect(getCapturedLogs()).to.have.lengthOf(1);
      expect(getCapturedLogs()[0].level).to.equal('debug');
      expect(getCapturedLogs()[0].message).to.equal('Debug message');
    });

    it('should log trace message', () => {
      root.setLevel(LogLevel.TRACE);
      root.trace('Trace message');
      expect(getCapturedLogs()).to.have.lengthOf(1);
      expect(getCapturedLogs()[0].level).to.equal('trace');
      expect(getCapturedLogs()[0].message).to.equal('Trace message');
    });
  });

  describe('Metadata Parameter', () => {
    it('should log with metadata', () => {
      root.info('Test message', { userId: 123, action: 'login' });
      expect(getCapturedLogs()).to.have.lengthOf(1);
      expect(getCapturedLogs()[0].message).to.equal('Test message');
      expect(getCapturedLogs()[0].userId).to.equal(123);
      expect(getCapturedLogs()[0].action).to.equal('login');
    });

    it('should log without metadata', () => {
      root.info('Test message');
      expect(getCapturedLogs()).to.have.lengthOf(1);
      expect(getCapturedLogs()[0].message).to.equal('Test message');
    });
  });

  describe('Error Parameter', () => {
    it('should log with error only', () => {
      const testError = new Error('Test error');
      root.error('Operation failed', testError);

      expect(getCapturedLogs()).to.have.lengthOf(1);
      expect(getCapturedLogs()[0].message).to.equal('Operation failed');
      expect(getCapturedLogs()[0].error).to.exist;
      expect(getCapturedLogs()[0].error.name).to.equal('Error');
      expect(getCapturedLogs()[0].error.message).to.equal('Test error');
      expect(getCapturedLogs()[0].error.stack).to.contain('Error: Test error');
    });

    it('should log with error and metadata', () => {
      const testError = new Error('Test error');
      root.error('Operation failed', testError, { operation: 'test', userId: 456 });

      expect(getCapturedLogs()).to.have.lengthOf(1);
      expect(getCapturedLogs()[0].message).to.equal('Operation failed');
      expect(getCapturedLogs()[0].error).to.exist;
      expect(getCapturedLogs()[0].error.name).to.equal('Error');
      expect(getCapturedLogs()[0].error.message).to.equal('Test error');
      expect(getCapturedLogs()[0].operation).to.equal('test');
      expect(getCapturedLogs()[0].userId).to.equal(456);
    });

    it('should support error on any log level', () => {
      root.setLevel(LogLevel.TRACE);
      const testError = new Error('Test error');

      root.crit('Crit', testError);
      root.error('Error', testError);
      root.warn('Warn', testError);
      root.info('Info', testError);
      root.verbose('Verbose', testError);
      root.debug('Debug', testError);
      root.trace('Trace', testError);

      expect(getCapturedLogs()).to.have.lengthOf(7);
      getCapturedLogs().forEach(log => {
        expect(log.error).to.exist;
        expect(log.error.message).to.equal('Test error');
      });
    });
  });

  describe('Level Filtering', () => {
    it('should filter out logs below threshold', () => {
      root.setLevel(LogLevel.WARN);

      root.crit('Should log');
      root.error('Should log');
      root.warn('Should log');
      root.info('Should NOT log');
      root.verbose('Should NOT log');
      root.debug('Should NOT log');
      root.trace('Should NOT log');

      expect(getCapturedLogs()).to.have.lengthOf(3);
      expect(getCapturedLogs()[0].level).to.equal('crit');
      expect(getCapturedLogs()[1].level).to.equal('error');
      expect(getCapturedLogs()[2].level).to.equal('warning');
    });

    it('should respect level inheritance for filtering', () => {
      root.setLevel(LogLevel.ERROR);
      const child = root.get('filter-inherit-child');

      child.crit('Should log');
      child.error('Should log');
      child.warn('Should NOT log');
      child.info('Should NOT log');

      expect(getCapturedLogs()).to.have.lengthOf(2);
    });

    it('should respect overridden child level', () => {
      root.setLevel(LogLevel.ERROR);
      const child = root.get('filter-override-child');
      child.setLevel(LogLevel.DEBUG);

      child.debug('Should log');
      expect(getCapturedLogs()).to.have.lengthOf(1);
    });
  });

  describe('Logger Context', () => {
    it('should include logger name in log event', () => {
      const child = root.get('context-name-logger');
      child.info('Test message');

      expect(getCapturedLogs()).to.have.lengthOf(1);
      expect(getCapturedLogs()[0].name).to.equal('context-name-logger');
    });

    it('should include logger path in log event', () => {
      const api = root.get('context-api');
      const auth = api.get('context-auth');

      auth.info('Test message');

      expect(getCapturedLogs()).to.have.lengthOf(1);
      expect(getCapturedLogs()[0].path).to.equal('root:context-api:context-auth');
    });
  });
});
