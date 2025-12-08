import { expect } from 'chai';
import { LoggerEngine, LogLevel, ConsoleTransport, CLITransport, LoggerTransport } from '../../src/index.js';
import Transport from 'winston-transport';

describe('Transports', () => {
  let root: LoggerEngine;

  beforeEach(() => {
    root = LoggerEngine.root();

    // Remove all transports for clean slate
    for (const t of root.transports) root.removeTransport(t);

    // Reset level
    root.setLevel(LogLevel.INFO);
  });

  describe('ConsoleTransport - Actual Output', () => {
    it('should output with default formatting', () => {
      console.log('\n--- ConsoleTransport: Default formatting ---');
      const transport = new ConsoleTransport();
      root.addTransport(transport);

      root.info('ConsoleTransport test with default options');
      root.error('Error message test');
      root.warn('Warning message test');
    });

    it('should output with FULL timestamp', () => {
      console.log('\n--- ConsoleTransport: FULL timestamp ---');
      const transport = new ConsoleTransport({
        timestamp: 'FULL'
      });
      root.addTransport(transport);

      root.info('Message with full ISO timestamp');
    });

    it('should output with NAME log level', () => {
      console.log('\n--- ConsoleTransport: NAME log level ---');
      const transport = new ConsoleTransport({
        logLevel: 'NAME'
      });
      root.addTransport(transport);

      root.setLevel(LogLevel.TRACE);
      root.crit('Critical with NAME');
      root.error('Error with NAME');
      root.warn('Warning with NAME');
      root.info('Info with NAME');
      root.verbose('Verbose with NAME');
      root.debug('Debug with NAME');
      root.trace('Trace with NAME');
    });

    it('should output with PATH logger name', () => {
      console.log('\n--- ConsoleTransport: PATH logger name ---');
      const transport = new ConsoleTransport({
        loggerName: 'PATH'
      });
      root.addTransport(transport);

      const api = root.get('api');
      const auth = api.get('auth');
      auth.info('Message showing full path');
    });

    it('should output with error and metadata', () => {
      console.log('\n--- ConsoleTransport: Error + Metadata ---');
      const transport = new ConsoleTransport({
        exceptions: 'FULL'
      });
      root.addTransport(transport);

      const testError = new Error('Test exception');
      root.error('Operation failed with context', testError, {
        userId: 12_345,
        operation: 'database_query',
        retryCount: 3
      });
    });

    it('should output with custom template', () => {
      console.log('\n--- ConsoleTransport: Custom template ---');
      const transport = new ConsoleTransport({
        template: '[%{level}] %{name} %{message} %{metadata}',
        timestamp: 'NONE',
        logLevel: 'NAME',
        loggerName: 'NAME'
      });
      root.addTransport(transport);

      const api = root.get('custom-api');
      api.info('Custom format message', { status: 'success' });
    });

    it('should output with different timezone', () => {
      console.log('\n--- ConsoleTransport: America/New_York timezone ---');
      const transport = new ConsoleTransport({
        timestamp: 'TIME',
        timezone: 'America/New_York'
      });
      root.addTransport(transport);

      root.info('Message in NY timezone');
    });
  });

  describe('CLITransport - Actual Output with Colors', () => {
    it('should output with colors (default)', () => {
      console.log('\n--- CLITransport: Default with colors ---');
      const transport = new CLITransport();
      root.addTransport(transport);

      root.setLevel(LogLevel.TRACE);
      root.crit('CRIT message - should be RED');
      root.error('ERROR message - should be BOLD RED');
      root.warn('WARN message - should be YELLOW');
      root.info('INFO message - terminal default (no color)');
      root.verbose('VERBOSE message - should be BLUE');
      root.debug('DEBUG message - should be BLUE');
      root.trace('TRACE message - should be MAGENTA');
    });

    it('should output with NAME level and PATH logger', () => {
      console.log('\n--- CLITransport: NAME + PATH with colors ---');
      const transport = new CLITransport({
        logLevel: 'NAME',
        loggerName: 'PATH'
      });
      root.addTransport(transport);

      const api = root.get('api');
      const auth = api.get('auth');
      const session = auth.get('session');

      root.setLevel(LogLevel.TRACE);
      session.crit('Critical in deep hierarchy');
      session.error('Error in deep hierarchy');
      session.warn('Warning in deep hierarchy');
      session.info('Info in deep hierarchy');
    });

    it('should output error with FULL stack trace', () => {
      console.log('\n--- CLITransport: FULL exception with colors ---');
      const transport = new CLITransport({
        exceptions: 'FULL',
        logLevel: 'NAME'
      });
      root.addTransport(transport);

      const error = new Error('Database connection failed');
      root.error('Failed to connect to database', error, {
        host: 'localhost',
        port: 5432,
        database: 'testdb'
      });
    });

    it('should output with FULL timestamp and custom template', () => {
      console.log('\n--- CLITransport: Custom template with colors ---');
      const transport = new CLITransport({
        timestamp: 'FULL',
        template: '%{timestamp} | %{level} | %{name} | %{message}',
        logLevel: 'NAME',
        loggerName: 'NAME'
      });
      root.addTransport(transport);

      const service = root.get('payment-service');
      service.info('Payment processed successfully', {
        transactionId: 'TXN-123456',
        amount: 99.99,
        currency: 'USD'
      });
    });

    it('should install as default transport', () => {
      console.log('\n--- CLITransport.install() ---');

      // Install replaces all transports
      CLITransport.install({
        logLevel: 'SYMBOL',
        loggerName: 'NAME'
      });

      // Should now use CLI transport
      expect(root.transports).to.have.lengthOf(1);
      expect(root.transports[0]).to.be.instanceOf(CLITransport);

      root.info('After CLITransport.install() - colored output');
      root.error('Error after install - colored output');
    });

    it('should show millisecond precision in TIME mode', () => {
      console.log('\n--- CLITransport: TIME with milliseconds ---');
      const transport = new CLITransport({
        timestamp: 'TIME',
        logLevel: 'NAME'
      });
      root.addTransport(transport);

      // Log multiple times quickly to show millisecond differences
      for (let i = 0; i < 5; i++) {
        root.info(`Message ${i} - note millisecond precision`);
      }
    });
  });

  describe('Transport Comparison - Side by Side', () => {
    it('should show Console vs CLI output difference', () => {
      console.log('\n--- Comparison: ConsoleTransport (no color) ---');
      const consoleTransport = new ConsoleTransport({
        logLevel: 'SYMBOL'
      });
      root.addTransport(consoleTransport);

      root.error('Console: Error message');
      root.warn('Console: Warning message');
      root.info('Console: Info message');

      // Switch to CLI
      root.removeTransport(consoleTransport);

      console.log('\n--- Comparison: CLITransport (with color) ---');
      const cliTransport = new CLITransport({
        logLevel: 'SYMBOL'
      });
      root.addTransport(cliTransport);

      root.error('CLI: Error message (should be colored)');
      root.warn('CLI: Warning message (should be colored)');
      root.info('CLI: Info message (should be colored)');
    });
  });

  describe('Transport Hierarchy', () => {
    it('should forward child logs to parent transports', () => {
      console.log('\n--- Hierarchy: Child logs forwarded to parent ---');
      const transport = new CLITransport({
        loggerName: 'PATH'
      });
      root.addTransport(transport);

      const api = root.get('api');
      const database = api.get('database');
      const query = database.get('query');

      query.info('Deep child logger - should reach root transport');
    });

    it('should support multiple transports on same logger', () => {
      console.log('\n--- Multiple transports on same logger ---');

      const consoleTransport = new ConsoleTransport({
        template: '[Console] %{message}',
        timestamp: 'NONE'
      });

      const cliTransport = new CLITransport({
        template: '[CLI-Colored] %{message}',
        timestamp: 'NONE'
      });

      root.addTransport(consoleTransport);
      root.addTransport(cliTransport);

      root.info('Message going to both Console and CLI transports');
    });
  });

  describe('Format Options Verification', () => {
    it('should respect NONE timestamp mode', () => {
      console.log('\n--- NONE timestamp ---');
      const transport = new CLITransport({
        timestamp: 'NONE'
      });
      root.addTransport(transport);

      root.info('No timestamp on this message');
    });

    it('should respect NONE log level mode', () => {
      console.log('\n--- NONE log level ---');
      const transport = new CLITransport({
        logLevel: 'NONE'
      });
      root.addTransport(transport);

      root.error('No level indicator on this message');
    });

    it('should respect NONE logger name mode', () => {
      console.log('\n--- NONE logger name ---');
      const transport = new CLITransport({
        loggerName: 'NONE'
      });
      root.addTransport(transport);

      const api = root.get('api');
      api.info('No logger name on this message');
    });

    it('should show BASIC exception format', () => {
      console.log('\n--- BASIC exception (first line only) ---');
      const transport = new CLITransport({
        exceptions: 'BASIC'
      });
      root.addTransport(transport);

      const error = new Error('Test error');
      root.error('Error with BASIC format', error);
    });

    it('should show CUSTOM timestamp format', () => {
      console.log('\n--- CUSTOM timestamp formatter ---');
      const transport = new CLITransport({
        timestamp: 'CUSTOM',
        customTimestampFormatter: (date) => `[${date.getTime()}]`
      });
      root.addTransport(transport);

      root.info('Custom timestamp shows epoch milliseconds');
    });
  });

  describe('Transport Creation Tests', () => {
    it('should create ConsoleTransport with options', () => {
      const transport = new ConsoleTransport({
        timestamp: 'FULL',
        logLevel: 'NAME',
        loggerName: 'PATH',
        exceptions: 'FULL'
      });
      expect(transport).to.be.instanceOf(ConsoleTransport);
      expect(transport).to.be.instanceOf(LoggerTransport);
    });

    it('should create CLITransport with options', () => {
      const transport = new CLITransport({
        timestamp: 'TIME',
        timezone: 'America/Los_Angeles',
        logLevel: 'SYMBOL',
        loggerName: 'NAME',
        exceptions: 'BASIC',
        maxLineLength: 120,
        template: '%{timestamp} [%{level}] %{message}'
      });
      expect(transport).to.be.instanceOf(CLITransport);
      expect(transport).to.be.instanceOf(LoggerTransport);
    });

    it('should add and remove transports', () => {
      const transport = new ConsoleTransport();

      root.addTransport(transport);
      expect(root.transports).to.include(transport);

      root.removeTransport(transport);
      expect(root.transports).to.not.include(transport);
    });
  });
});
