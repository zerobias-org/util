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

describe('Ephemeral Loggers', () => {
  let root: LoggerEngine;

  beforeEach(() => {
    root = LoggerEngine.root();
  });

  it('should not cache ephemeral loggers', () => {
    const parent = root.get('parent');
    const ephemeral1 = parent.get('ephemeral', { ephemeral: true });
    const ephemeral2 = parent.get('ephemeral', { ephemeral: true });

    // Each call creates new instance
    expect(ephemeral1).to.not.equal(ephemeral2);

    // Not cached in parent
    expect(parent.children.has('ephemeral')).to.be.false;
  });

  it('should have ephemeral flag set to true', () => {
    const ephemeral = root.get('temp', { ephemeral: true });
    expect(ephemeral.ephemeral).to.be.true;
  });

  it('should have ephemeral flag set to false for cached loggers', () => {
    const cached = root.get('cached');
    expect(cached.ephemeral).to.be.false;
  });

  it('should allow ephemeral loggers to have children', () => {
    const ephemeral = root.get('ephemeral-parent', { ephemeral: true });
    const child = ephemeral.get('child');

    expect(child.parent).to.equal(ephemeral);
    expect(child.name).to.equal('child');
    expect(child.path).to.equal(':ephemeral-parent:child');
  });

  it('should not remove ephemeral logger from parent on destroy', () => {
    const parent = root.get('parent');
    const ephemeral = parent.get('ephemeral', { ephemeral: true });

    // Ephemeral not in parent's children
    expect(parent.children.has('ephemeral')).to.be.false;

    // Destroy should work without error
    expect(() => ephemeral.destroy()).to.not.throw();

    // Still not in parent's children (no-op)
    expect(parent.children.has('ephemeral')).to.be.false;
  });

  it('should allow same name for multiple ephemeral loggers', () => {
    const parent = root.get('parent');
    const ephemeral1 = parent.get('request', { ephemeral: true });
    const ephemeral2 = parent.get('request', { ephemeral: true });
    const ephemeral3 = parent.get('request', { ephemeral: true });

    // All different instances
    expect(ephemeral1).to.not.equal(ephemeral2);
    expect(ephemeral2).to.not.equal(ephemeral3);
    expect(ephemeral1).to.not.equal(ephemeral3);

    // None cached
    expect(parent.children.has('request')).to.be.false;
  });

  it('should inherit log level from parent', () => {
    const parent = root.get('parent');
    parent.setLevel(LogLevel.DEBUG);

    const ephemeral = parent.get('ephemeral', { ephemeral: true });
    expect(ephemeral.getEffectiveLevel()).to.equal(LogLevel.DEBUG);
  });

  it('should allow ephemeral logger to have explicit level', () => {
    const ephemeral = root.get('ephemeral', {
      ephemeral: true,
      level: LogLevel.TRACE
    });

    expect(ephemeral.level).to.equal(LogLevel.TRACE);
    expect(ephemeral.getEffectiveLevel()).to.equal(LogLevel.TRACE);
  });

  it('should forward logs to parent transports', () => {
    const parent = root.get('test-parent');

    // Add memory transport to parent
    const memoryTransport = new MemoryTransport();
    parent.addTransport(memoryTransport);

    // Create ephemeral child and log
    const ephemeral = parent.get('ephemeral-child', { ephemeral: true });
    ephemeral.info('Test message from ephemeral');

    // Should reach parent transport
    expect(memoryTransport.logs).to.have.lengthOf(1);
    expect(memoryTransport.logs[0].message).to.equal('Test message from ephemeral');
    expect(memoryTransport.logs[0].name).to.equal('ephemeral-child');
    expect(memoryTransport.logs[0].path).to.equal(':test-parent:ephemeral-child');
  });

  it('should recursively destroy ephemeral children', () => {
    const ephemeralParent = root.get('ephemeral-parent', { ephemeral: true });
    const child1 = ephemeralParent.get('child1');
    const grandchild = child1.get('grandchild');

    // All should have parent references
    expect(child1.parent).to.equal(ephemeralParent);
    expect(grandchild.parent).to.equal(child1);

    // Destroy parent
    ephemeralParent.destroy();

    // All should be destroyed
    expect(ephemeralParent.parent).to.be.undefined;
    expect(child1.parent).to.be.undefined;
    expect(grandchild.parent).to.be.undefined;
  });
});
