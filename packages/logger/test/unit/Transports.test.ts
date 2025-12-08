import { expect } from 'chai';
import { LoggerEngine, LogLevel, ConsoleTransport, CLITransport } from '../../src/index.js';
import Transport from 'winston-transport';

// Custom test transport to capture output
class TestTransport extends Transport {
  public logs: string[] = [];

  log(info: any, callback: () => void): void {
    // Just capture the raw info for inspection
    this.logs.push(JSON.stringify(info));
    callback();
  }

  clear(): void {
    this.logs = [];
  }
}

describe('Transports', () => {
  let root: LoggerEngine;

  beforeEach(() => {
    root = LoggerEngine.root();

    // Remove all transports
    root.transports.forEach(t => root.removeTransport(t));

    // Reset level
    root.setLevel(LogLevel.INFO);
  });

  describe('ConsoleTransport', () => {
    it('should create with default options', () => {
      const transport = new ConsoleTransport();
      expect(transport).to.be.instanceOf(ConsoleTransport);
    });

    it('should create with custom options', () => {
      const transport = new ConsoleTransport({
        timestamp: 'FULL',
        logLevel: 'NAME',
        loggerName: 'PATH',
        exceptions: 'FULL'
      });
      expect(transport).to.be.instanceOf(ConsoleTransport);
    });

    it('should be added to logger', () => {
      const transport = new ConsoleTransport();
      root.addTransport(transport);

      expect(root.transports).to.include(transport);
    });

    it('should format and output logs', () => {
      const transport = new ConsoleTransport({
        timestamp: 'NONE',
        logLevel: 'SYMBOL',
        loggerName: 'NAME'
      });
      root.addTransport(transport);

      // This should output to console
      // We can't easily test console output, but we verify no errors
      root.info('Test message');
    });
  });

  describe('CLITransport', () => {
    it('should create with default options', () => {
      const transport = new CLITransport();
      expect(transport).to.be.instanceOf(CLITransport);
    });

    it('should create with custom options', () => {
      const transport = new CLITransport({
        timestamp: 'TIME',
        timezone: 'America/New_York',
        logLevel: 'NAME',
        loggerName: 'PATH',
        exceptions: 'FULL',
        maxLineLength: 120,
        template: '%{timestamp} [%{level}] %{message}'
      });
      expect(transport).to.be.instanceOf(CLITransport);
    });

    it('should install as default transport', () => {
      const initialCount = root.transports.length;

      CLITransport.install();

      // Should have replaced transports with CLITransport
      expect(root.transports).to.have.lengthOf(1);
      expect(root.transports[0]).to.be.instanceOf(CLITransport);
    });

    it('should install with custom options', () => {
      CLITransport.install({
        timestamp: 'FULL',
        logLevel: 'NAME'
      });

      expect(root.transports).to.have.lengthOf(1);
      expect(root.transports[0]).to.be.instanceOf(CLITransport);
    });
  });

  describe('Transport Formatting', () => {
    it('should support NONE timestamp mode', () => {
      const transport = new ConsoleTransport({
        timestamp: 'NONE'
      });
      root.addTransport(transport);

      // Log should work without timestamp
      root.info('Test');
    });

    it('should support FULL timestamp mode', () => {
      const transport = new ConsoleTransport({
        timestamp: 'FULL'
      });
      root.addTransport(transport);

      root.info('Test');
    });

    it('should support TIME timestamp mode', () => {
      const transport = new ConsoleTransport({
        timestamp: 'TIME'
      });
      root.addTransport(transport);

      root.info('Test');
    });

    it('should support CUSTOM timestamp mode', () => {
      const transport = new ConsoleTransport({
        timestamp: 'CUSTOM',
        customTimestampFormatter: (date) => date.getTime().toString()
      });
      root.addTransport(transport);

      root.info('Test');
    });

    it('should support NONE log level mode', () => {
      const transport = new ConsoleTransport({
        logLevel: 'NONE'
      });
      root.addTransport(transport);

      root.info('Test');
    });

    it('should support SYMBOL log level mode', () => {
      const transport = new ConsoleTransport({
        logLevel: 'SYMBOL'
      });
      root.addTransport(transport);

      root.error('Test'); // Should show '!!'
    });

    it('should support NAME log level mode', () => {
      const transport = new ConsoleTransport({
        logLevel: 'NAME'
      });
      root.addTransport(transport);

      root.info('Test'); // Should show 'info'
    });

    it('should support NONE logger name mode', () => {
      const transport = new ConsoleTransport({
        loggerName: 'NONE'
      });
      root.addTransport(transport);

      const child = root.get('test-logger');
      child.info('Test');
    });

    it('should support NAME logger name mode', () => {
      const transport = new ConsoleTransport({
        loggerName: 'NAME'
      });
      root.addTransport(transport);

      const child = root.get('test-logger-name');
      child.info('Test');
    });

    it('should support PATH logger name mode', () => {
      const transport = new ConsoleTransport({
        loggerName: 'PATH'
      });
      root.addTransport(transport);

      const api = root.get('test-api');
      const auth = api.get('test-auth');
      auth.info('Test'); // Should show [root:test-api:test-auth]
    });

    it('should support BASIC exception mode', () => {
      const transport = new ConsoleTransport({
        exceptions: 'BASIC'
      });
      root.addTransport(transport);

      const error = new Error('Test error');
      root.error('Operation failed', error);
    });

    it('should support FULL exception mode', () => {
      const transport = new ConsoleTransport({
        exceptions: 'FULL'
      });
      root.addTransport(transport);

      const error = new Error('Test error');
      root.error('Operation failed', error);
    });

    it('should support custom templates', () => {
      const transport = new ConsoleTransport({
        template: '[%{level}] %{message}',
        timestamp: 'NONE',
        logLevel: 'NAME'
      });
      root.addTransport(transport);

      root.info('Custom format');
    });

    it('should support metadata in templates', () => {
      const transport = new ConsoleTransport({
        template: '%{message} %{metadata}',
        timestamp: 'NONE'
      });
      root.addTransport(transport);

      root.info('User action', { userId: 123, action: 'login' });
    });

    it('should support timezone configuration', () => {
      const transport = new ConsoleTransport({
        timestamp: 'TIME',
        timezone: 'America/Los_Angeles'
      });
      root.addTransport(transport);

      root.info('Timezone test');
    });

    it('should support maxLineLength configuration', () => {
      const transport = new ConsoleTransport({
        maxLineLength: 50
      });
      root.addTransport(transport);

      root.info('This is a very long message that should be handled according to maxLineLength');
    });
  });

  describe('Transport Hierarchy', () => {
    it('should forward child logs to parent transports', () => {
      const testTransport = new TestTransport();
      root.addTransport(testTransport);

      const child = root.get('hierarchy-test-child');
      child.info('Child message');

      // Message should reach root transport
      expect(testTransport.logs).to.have.lengthOf(1);
      expect(testTransport.logs[0]).to.include('Child message');
    });

    it('should support child-specific transports', () => {
      const rootTransport = new TestTransport();
      const childTransport = new TestTransport();

      root.addTransport(rootTransport);

      const child = root.get('child-transport-test', {
        transports: [childTransport]
      });

      child.info('Test message');

      // Both root and child transports should receive the message
      expect(rootTransport.logs).to.have.lengthOf(1);
      expect(childTransport.logs).to.have.lengthOf(1);
    });

    it('should allow different formatting on different loggers', () => {
      const rootTransport = new ConsoleTransport({
        logLevel: 'NAME'
      });

      const childTransport = new ConsoleTransport({
        logLevel: 'SYMBOL'
      });

      root.addTransport(rootTransport);

      const child = root.get('format-test-child', {
        transports: [childTransport]
      });

      child.info('Test');
      // Should work with different formats
    });
  });
});
