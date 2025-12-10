import { expect } from 'chai';
import { LoggerEngine, LogLevel } from '../../src/index.js';

describe('LoggerEngine', () => {
  describe('Root Logger', () => {
    it('should return singleton root logger', () => {
      const root1 = LoggerEngine.root();
      const root2 = LoggerEngine.root();

      expect(root1).to.equal(root2);
    });

    it('should have name empty string', () => {
      const root = LoggerEngine.root();
      expect(root.name).to.equal('');
    });

    it('should have no parent', () => {
      const root = LoggerEngine.root();
      expect(root.parent).to.be.undefined;
    });

    it('should have default level INFO', () => {
      const root = LoggerEngine.root();
      expect(root.getEffectiveLevel()).to.equal(LogLevel.INFO);
    });

    it('should have console transport', () => {
      const root = LoggerEngine.root();
      expect(root.transports).to.have.lengthOf.at.least(1);
    });

    it('should not be destroyable', () => {
      const root = LoggerEngine.root();
      expect(() => root.destroy()).to.throw('Cannot destroy root logger');
    });
  });

  describe('Child Logger Creation', () => {
    let root: LoggerEngine;

    beforeEach(() => {
      root = LoggerEngine.root();
    });

    it('should create child logger', () => {
      const child = root.get('test');
      expect(child.name).to.equal('test');
      expect(child.parent).to.equal(root);
    });

    it('should cache child loggers', () => {
      const child1 = root.get('test');
      const child2 = root.get('test');

      expect(child1).to.equal(child2);
    });

    it('should add child to parent children map', () => {
      const child = root.get('test');
      expect(root.children.has('test')).to.be.true;
      expect(root.children.get('test')).to.equal(child);
    });

    it('should create nested hierarchies', () => {
      const api = root.get('api');
      const auth = api.get('auth');
      const session = auth.get('session');

      expect(session.parent).to.equal(auth);
      expect(auth.parent).to.equal(api);
      expect(api.parent).to.equal(root);
    });
  });

  describe('Logger Path', () => {
    let root: LoggerEngine;

    beforeEach(() => {
      root = LoggerEngine.root();
    });

    it('should return "root" for root logger', () => {
      expect(root.path).to.equal('');
    });

    it('should construct path for single child', () => {
      const api = root.get('api');
      expect(api.path).to.equal(':api');
    });

    it('should construct path for nested children', () => {
      const api = root.get('api');
      const auth = api.get('auth');
      const session = auth.get('session');

      expect(session.path).to.equal(':api:auth:session');
    });
  });

  describe('Level Inheritance', () => {
    let root: LoggerEngine;

    beforeEach(() => {
      root = LoggerEngine.root();
    });

    it('should inherit level from parent', () => {
      root.setLevel(LogLevel.DEBUG);
      const child = root.get('inherit-test-1');

      expect(child.getEffectiveLevel()).to.equal(LogLevel.DEBUG);
    });

    it('should inherit level from grandparent', () => {
      root.setLevel(LogLevel.TRACE);
      const api = root.get('inherit-api');
      const auth = api.get('inherit-auth');

      expect(auth.getEffectiveLevel()).to.equal(LogLevel.TRACE);
    });

    it('should allow override of inherited level', () => {
      root.setLevel(LogLevel.INFO);
      const child = root.get('inherit-override');
      child.setLevel(LogLevel.DEBUG);

      expect(child.getEffectiveLevel()).to.equal(LogLevel.DEBUG);
      expect(root.getEffectiveLevel()).to.equal(LogLevel.INFO);
    });

    it('should return undefined for level when not explicitly set', () => {
      const child = root.get('inherit-undefined');
      // Child level is undefined (inherits from parent)
      expect(child.level).to.be.undefined;
      // But effective level comes from parent
      expect(child.getEffectiveLevel()).to.equal(LogLevel.INFO);
    });

    it('should return set level when explicitly set', () => {
      const child = root.get('inherit-explicit');
      child.setLevel(LogLevel.WARN);
      expect(child.level).to.equal(LogLevel.WARN);
    });

    it('should clear level and resume inheriting when set to null', () => {
      root.setLevel(LogLevel.DEBUG);
      const child = root.get('inherit-clear');

      // Set explicit level
      child.setLevel(LogLevel.ERROR);
      expect(child.level).to.equal(LogLevel.ERROR);
      expect(child.getEffectiveLevel()).to.equal(LogLevel.ERROR);

      // Clear level - should resume inheriting
      child.setLevel(null);
      expect(child.level).to.be.undefined;
      expect(child.getEffectiveLevel()).to.equal(LogLevel.DEBUG); // Inherited from root
    });
  });

  describe('Logger Destruction', () => {
    let root: LoggerEngine;

    beforeEach(() => {
      root = LoggerEngine.root();
    });

    it('should remove logger from parent children', () => {
      const child = root.get('test');
      child.destroy();

      expect(root.children.has('test')).to.be.false;
    });

    it('should clear parent reference', () => {
      const child = root.get('test');
      child.destroy();

      expect(child.parent).to.be.undefined;
    });

    it('should recursively destroy children', () => {
      const level1 = root.get('level1');
      const level2 = level1.get('level2');
      const level3 = level2.get('level3');

      level1.destroy();

      expect(root.children.has('level1')).to.be.false;
      expect(level1.parent).to.be.undefined;
      expect(level2.parent).to.be.undefined;
      expect(level3.parent).to.be.undefined;
    });

    it('should be idempotent', () => {
      const parent = root.get('destroy-parent');
      const child = parent.get('destroy-child');

      child.destroy();
      expect(() => child.destroy()).to.not.throw();
    });

    it('should throw when getting child from destroyed logger', () => {
      const child = root.get('test');
      child.destroy();

      expect(() => child.get('subchild')).to.throw('Cannot get child logger from destroyed logger');
    });

    it('should throw when setting level on destroyed logger', () => {
      const child = root.get('test');
      child.destroy();

      expect(() => child.setLevel(LogLevel.DEBUG)).to.throw('Cannot set level on destroyed logger');
    });

    it('should throw when logging to destroyed logger', () => {
      const child = root.get('test');
      child.destroy();

      expect(() => child.info('test')).to.throw('Cannot log to destroyed logger');
    });
  });

  describe('Transport Management', () => {
    let root: LoggerEngine;

    beforeEach(() => {
      root = LoggerEngine.root();
    });

    it('should return transports', () => {
      expect(root.transports).to.be.an('array');
    });

    it('should throw when adding transport to destroyed logger', () => {
      const child = root.get('test');
      child.destroy();

      expect(() => child.addTransport({} as any)).to.throw('Cannot add transport to destroyed logger');
    });

    it('should throw when removing transport from destroyed logger', () => {
      const child = root.get('test');
      child.destroy();

      expect(() => child.removeTransport({} as any)).to.throw('Cannot remove transport from destroyed logger');
    });
  });
});
