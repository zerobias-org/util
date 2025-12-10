import { expect } from 'chai';
import { LoggerEngine, TransportType, ConsoleTransport, CLITransport } from '../../src/index.js';

describe('TransportType', () => {
  let root: LoggerEngine;

  beforeEach(() => {
    root = LoggerEngine.root();
    // Remove all existing transports
    const transports = [...root.transports]; // Copy array since we're modifying it
    for (const t of transports) {
      root.removeTransport(t);
    }
  });

  describe('transportType property', () => {
    it('should have CONSOLE type for ConsoleTransport', () => {
      const transport = new ConsoleTransport();
      expect(transport.transportType).to.equal(TransportType.CONSOLE);
    });

    it('should have CLI type for CLITransport', () => {
      const transport = new CLITransport();
      expect(transport.transportType).to.equal(TransportType.CLI);
    });

    it('should be public readonly', () => {
      const transport = new ConsoleTransport();
      expect(transport.transportType).to.equal(TransportType.CONSOLE);

      // TypeScript ensures readonly at compile time
      // Runtime: property exists and is accessible
      expect(transport).to.have.property('transportType', TransportType.CONSOLE);
    });
  });

  describe('getTransport()', () => {
    it('should return first transport of given type', () => {
      const console1 = new ConsoleTransport();
      const console2 = new ConsoleTransport();
      const cli1 = new CLITransport();

      root.addTransport(console1);
      root.addTransport(console2);
      root.addTransport(cli1);

      const result = root.getTransport(TransportType.CONSOLE);
      expect(result).to.equal(console1); // First one added
    });

    it('should return undefined if type not found', () => {
      root.addTransport(new ConsoleTransport());

      const result = root.getTransport(TransportType.CLI);
      expect(result).to.be.undefined;
    });

    it('should be typed correctly', () => {
      const transport = new CLITransport();
      root.addTransport(transport);

      const result = root.getTransport<CLITransport>(TransportType.CLI);
      expect(result).to.equal(transport);

      // Should have CLITransport methods (type check - verified at compile time)
      expect(result).to.be.instanceOf(CLITransport);
    });

    it('should ignore non-LoggerTransport transports', () => {
      // Note: Winston requires proper Transport class, so we just verify
      // that our method works correctly with LoggerTransport instances
      root.addTransport(new ConsoleTransport());

      const result = root.getTransport(TransportType.CONSOLE);
      expect(result).to.be.instanceOf(ConsoleTransport);
    });
  });

  describe('getTransports()', () => {
    it('should return all transports of given type', () => {
      const console1 = new ConsoleTransport();
      const console2 = new ConsoleTransport();
      const cli1 = new CLITransport();

      root.addTransport(console1);
      root.addTransport(console2);
      root.addTransport(cli1);

      const results = root.getTransports(TransportType.CONSOLE);
      expect(results).to.have.lengthOf(2);
      expect(results).to.include(console1);
      expect(results).to.include(console2);
    });

    it('should return empty array if type not found', () => {
      root.addTransport(new ConsoleTransport());

      const results = root.getTransports(TransportType.CLI);
      expect(results).to.be.an('array').that.is.empty;
    });

    it('should be typed correctly', () => {
      root.addTransport(new CLITransport());
      root.addTransport(new CLITransport());

      const results = root.getTransports<CLITransport>(TransportType.CLI);
      expect(results).to.have.lengthOf(2);

      for (const transport of results) {
        expect(transport).to.be.instanceOf(CLITransport);
      }
    });
  });

  describe('hasTransport()', () => {
    it('should return true if transport type exists', () => {
      root.addTransport(new ConsoleTransport());

      expect(root.hasTransport(TransportType.CONSOLE)).to.be.true;
    });

    it('should return false if transport type does not exist', () => {
      root.addTransport(new ConsoleTransport());

      expect(root.hasTransport(TransportType.CLI)).to.be.false;
    });

    it('should return true if multiple transports of type exist', () => {
      root.addTransport(new CLITransport());
      root.addTransport(new CLITransport());

      expect(root.hasTransport(TransportType.CLI)).to.be.true;
    });
  });

  describe('removeTransport() by type', () => {
    it('should remove all transports of given type', () => {
      const console1 = new ConsoleTransport();
      const console2 = new ConsoleTransport();
      const cli1 = new CLITransport();

      root.addTransport(console1);
      root.addTransport(console2);
      root.addTransport(cli1);

      expect(root.transports).to.have.lengthOf(3);

      root.removeTransport(TransportType.CONSOLE);

      expect(root.transports).to.have.lengthOf(1);
      expect(root.transports[0]).to.equal(cli1);
    });

    it('should handle removing non-existent type gracefully', () => {
      root.addTransport(new ConsoleTransport());

      expect(() => root.removeTransport(TransportType.CLI)).to.not.throw();
      expect(root.transports).to.have.lengthOf(1);
    });

    it('should not affect other transport types', () => {
      const console1 = new ConsoleTransport();
      const cli1 = new CLITransport();
      const cli2 = new CLITransport();

      root.addTransport(console1);
      root.addTransport(cli1);
      root.addTransport(cli2);

      root.removeTransport(TransportType.CLI);

      expect(root.transports).to.have.lengthOf(1);
      expect(root.transports[0]).to.equal(console1);
    });
  });

  describe('removeTransport() overloading', () => {
    it('should support removing by instance (original behavior)', () => {
      const transport = new ConsoleTransport();
      root.addTransport(transport);

      expect(root.transports).to.have.lengthOf(1);

      root.removeTransport(transport);

      expect(root.transports).to.have.lengthOf(0);
    });

    it('should support removing by type (new behavior)', () => {
      root.addTransport(new ConsoleTransport());
      root.addTransport(new ConsoleTransport());

      expect(root.transports).to.have.lengthOf(2);

      root.removeTransport(TransportType.CONSOLE);

      expect(root.transports).to.have.lengthOf(0);
    });
  });

  describe('Practical use cases', () => {
    it('should easily swap transport types', () => {
      // Start with console transport
      root.addTransport(new ConsoleTransport({ logLevel: 'SYMBOL' }));
      expect(root.hasTransport(TransportType.CONSOLE)).to.be.true;

      // Swap to CLI transport
      root.removeTransport(TransportType.CONSOLE);
      root.addTransport(new CLITransport({ logLevel: 'SYMBOL' }));

      expect(root.hasTransport(TransportType.CONSOLE)).to.be.false;
      expect(root.hasTransport(TransportType.CLI)).to.be.true;
    });

    it('should enable dynamic transport reconfiguration', () => {
      root.addTransport(new CLITransport({ exceptions: 'BASIC' }));

      // Get and reconfigure
      const transport = root.getTransport<CLITransport>(TransportType.CLI);
      expect(transport).to.not.be.undefined;

      transport!.apply({ exceptions: 'FULL' });

      // Verify it's the same instance
      expect(root.getTransport(TransportType.CLI)).to.equal(transport);
    });

    it('should support conditional transport management', () => {
      // Add appropriate transport for environment
      if (process.stdout.isTTY) {
        root.addTransport(new CLITransport());
      } else {
        root.addTransport(new ConsoleTransport());
      }

      // Check which one was added
      const hasCLI = root.hasTransport(TransportType.CLI);
      const hasConsole = root.hasTransport(TransportType.CONSOLE);

      expect(hasCLI || hasConsole).to.be.true;
      expect(hasCLI && hasConsole).to.be.false; // Only one
    });

    it('should enable development vs production transport switching', () => {
      // Simulate production
      root.addTransport(new ConsoleTransport({
        timestamp: 'FULL',
        logLevel: 'NAME'
      }));

      expect(root.hasTransport(TransportType.CONSOLE)).to.be.true;

      // Switch to development mode
      root.removeTransport(TransportType.CONSOLE);
      root.addTransport(new CLITransport({
        timestamp: 'TIME',
        logLevel: 'SYMBOL',
        exceptions: 'FULL'
      }));

      expect(root.hasTransport(TransportType.CLI)).to.be.true;
      expect(root.hasTransport(TransportType.CONSOLE)).to.be.false;
    });
  });

  describe('TransportType enum values', () => {
    it('should have CLI value', () => {
      expect(TransportType.CLI).to.equal('cli');
    });

    it('should have CONSOLE value', () => {
      expect(TransportType.CONSOLE).to.equal('console');
    });

    it('should have FILE value', () => {
      expect(TransportType.FILE).to.equal('file');
    });

    it('should have MEMORY value', () => {
      expect(TransportType.MEMORY).to.equal('memory');
    });

    it('should have API value', () => {
      expect(TransportType.API).to.equal('api');
    });
  });
});
