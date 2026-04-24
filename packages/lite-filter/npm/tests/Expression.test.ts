import { describe, it, expect } from 'vitest';
import { Expression } from '../src';

describe('Expression Factory Methods', () => {
  describe('Comparison Operations', () => {
    it('should create equals expression', () => {
      const expr = Expression.equals('name', 'John');
      expect(expr).toBeDefined();
    });

    it('should create notEquals expression', () => {
      const expr = Expression.notEquals('status', 'inactive');
      expect(expr).toBeDefined();
    });

    it('should create greaterThan expression', () => {
      const expr = Expression.greaterThan('age', 18);
      expect(expr).toBeDefined();
    });

    it('should create lessThanOrEqual expression', () => {
      const expr = Expression.lessThanOrEqual('price', 100);
      expect(expr).toBeDefined();
    });
  });

  describe('String Operations', () => {
    it('should create contains expression', () => {
      const expr = Expression.contains('email', '@example.com');
      expect(expr).toBeDefined();
    });

    it('should create startsWith expression', () => {
      const expr = Expression.startsWith('name', 'John');
      expect(expr).toBeDefined();
    });

    it('should create endsWith expression', () => {
      const expr = Expression.endsWith('file', '.txt');
      expect(expr).toBeDefined();
    });
  });

  describe('Logical Operations', () => {
    it('should create AND expression', () => {
      const expr = Expression.and(
        Expression.equals('status', 'active'),
        Expression.greaterThan('age', 18)
      );
      expect(expr).toBeDefined();
    });

    it('should create OR expression', () => {
      const expr = Expression.or(
        Expression.equals('role', 'admin'),
        Expression.equals('role', 'moderator')
      );
      expect(expr).toBeDefined();
    });

    it('should create NOT expression', () => {
      const expr = Expression.not(Expression.equals('deleted', true));
      expect(expr).toBeDefined();
    });
  });
});

describe('Expression Composition', () => {
  it('should compose complex nested expressions', () => {
    const expr = Expression.and(
      Expression.or(
        Expression.equals('zip', '90210'),
        Expression.startsWith('name', 'Rob')
      ),
      Expression.equals('status', 'Active')
    );
    expect(expr).toBeDefined();
  });
});

describe('Adapter Management', () => {
  it('should register and list adapters', () => {
    Expression.addAdapter('TEST', 'Test Adapter', {
      fromExpression: () => 'test output',
    });

    const adapters = Expression.adapters();
    expect(adapters).toContainEqual({
      key: 'TEST',
      description: 'Test Adapter',
    });
  });

  it('should allow adapter replacement', () => {
    Expression.addAdapter('REPLACE', 'First', {
      fromExpression: () => 'first',
    });
    Expression.addAdapter('REPLACE', 'Second', {
      fromExpression: () => 'second',
    });

    const adapters = Expression.adapters();
    const replaceAdapters = adapters.filter(a => a.key === 'REPLACE');
    expect(replaceAdapters).toHaveLength(1);
    expect(replaceAdapters[0]?.description).toBe('Second');
  });
});
