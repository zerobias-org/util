import { expect } from 'chai';
import { LoggerEngine, ConsoleTransport, CLITransport } from '../../src/index.js';

describe('Transport Reconfiguration', () => {
  describe('apply() method', () => {
    it('should reconfigure timestamp mode at runtime', () => {
      const root = LoggerEngine.root();

      // Remove default transport
      for (const t of root.transports) root.removeTransport(t);

      // Add console transport with default TIME mode
      const transport = new ConsoleTransport();
      root.addTransport(transport);

      // Reconfigure to FULL mode
      transport.apply({ timestamp: 'FULL' });

      // Verify by logging (visual verification in test output)
      root.info('After changing to FULL timestamp');
    });

    it('should reconfigure timezone at runtime', () => {
      const root = LoggerEngine.root();
      for (const t of root.transports) root.removeTransport(t);

      const transport = new ConsoleTransport({ timezone: 'GMT' });
      root.addTransport(transport);

      // Change timezone
      transport.apply({ timezone: 'America/New_York' });

      root.info('After changing timezone to America/New_York');
    });

    it('should reconfigure log level display at runtime', () => {
      const root = LoggerEngine.root();
      for (const t of root.transports) root.removeTransport(t);

      const transport = new ConsoleTransport({ logLevel: 'SYMBOL' });
      root.addTransport(transport);

      // Change to NAME
      transport.apply({ logLevel: 'NAME' });

      root.info('Log level should show as NAME now');
      root.error('Error should show as NAME');
    });

    it('should reconfigure logger name display at runtime', () => {
      const root = LoggerEngine.root();
      const child = root.get('test-child');

      for (const t of root.transports) root.removeTransport(t);

      const transport = new ConsoleTransport({ loggerName: 'NAME' });
      root.addTransport(transport);

      child.info('Logger name showing as NAME');

      // Change to PATH
      transport.apply({ loggerName: 'PATH' });

      child.info('Logger name should show full PATH now');
    });

    it('should reconfigure exception detail at runtime', () => {
      const root = LoggerEngine.root();
      for (const t of root.transports) root.removeTransport(t);

      const transport = new ConsoleTransport({ exceptions: 'BASIC' });
      root.addTransport(transport);

      const error = new Error('Test error with BASIC mode');
      root.error('Error with BASIC exception format', error);

      // Change to FULL
      transport.apply({ exceptions: 'FULL' });

      const error2 = new Error('Test error with FULL mode');
      root.error('Error with FULL exception format', error2);
    });

    it('should reconfigure template at runtime', () => {
      const root = LoggerEngine.root();
      for (const t of root.transports) root.removeTransport(t);

      const transport = new ConsoleTransport({
        template: '%{timestamp} [%{level}] %{message}'
      });
      root.addTransport(transport);

      root.info('Original template format');

      // Change template
      transport.apply({
        template: '[%{level}] %{message} at %{timestamp}'
      });

      root.info('New template format - level first');
    });

    it('should reconfigure multiple options at once', () => {
      const root = LoggerEngine.root();
      for (const t of root.transports) root.removeTransport(t);

      const transport = new ConsoleTransport();
      root.addTransport(transport);

      root.info('Before bulk reconfiguration');

      // Bulk reconfiguration
      transport.apply({
        timestamp: 'NONE',
        logLevel: 'NAME',
        loggerName: 'NONE',
        exceptions: 'FULL'
      });

      root.info('After bulk reconfiguration');
      root.error('Error after bulk reconfiguration', new Error('Test'));
    });

    it('should handle partial updates without affecting other options', () => {
      const root = LoggerEngine.root();
      for (const t of root.transports) root.removeTransport(t);

      const transport = new ConsoleTransport({
        timestamp: 'TIME',
        timezone: 'GMT',
        logLevel: 'SYMBOL',
        loggerName: 'NAME'
      });
      root.addTransport(transport);

      // Only change timezone, other options should remain
      transport.apply({ timezone: 'Europe/London' });

      root.info('Only timezone changed, other options preserved');
    });

    it('should work with CLITransport', () => {
      const root = LoggerEngine.root();
      for (const t of root.transports) root.removeTransport(t);

      const transport = new CLITransport({ logLevel: 'SYMBOL' });
      root.addTransport(transport);

      root.info('CLITransport with SYMBOL');
      root.error('Error with SYMBOL');

      // Reconfigure
      transport.apply({ logLevel: 'NAME', exceptions: 'FULL' });

      root.info('CLITransport with NAME');
      root.error('Error with NAME and FULL exceptions', new Error('Test error'));
    });

    it('should reconfigure custom timestamp formatter', () => {
      const root = LoggerEngine.root();
      for (const t of root.transports) root.removeTransport(t);

      const transport = new ConsoleTransport({
        timestamp: 'CUSTOM',
        customTimestampFormatter: (date) => `[${date.getTime()}]`
      });
      root.addTransport(transport);

      root.info('Using epoch milliseconds');

      // Change formatter
      transport.apply({
        customTimestampFormatter: (date) => `<${date.toISOString()}>`
      });

      root.info('Using ISO string in angle brackets');
    });

    it('should handle switching between timestamp modes', () => {
      const root = LoggerEngine.root();
      for (const t of root.transports) root.removeTransport(t);

      const transport = new ConsoleTransport({ timestamp: 'TIME' });
      root.addTransport(transport);

      root.info('TIME mode');

      transport.apply({ timestamp: 'FULL' });
      root.info('FULL mode');

      transport.apply({ timestamp: 'NONE' });
      root.info('NONE mode');

      transport.apply({ timestamp: 'TIME', timezone: 'America/Los_Angeles' });
      root.info('Back to TIME mode with LA timezone');
    });
  });
});
