import { describe, it, expect } from 'vitest';
import { Expression } from '../src';

describe('Expression Matching', () => {
  describe('Type Coercion', () => {
    it('should coerce string to number for equality', () => {
      const expr = Expression.equals('age', 18);
      expect(expr.matches({ age: '18' })).toBe(true);
      expect(expr.matches({ age: 18 })).toBe(true);
    });

    it('should coerce string to boolean for equality', () => {
      const expr = Expression.equals('active', true);
      expect(expr.matches({ active: 'true' })).toBe(true);
      expect(expr.matches({ active: true })).toBe(true);
    });

    it('should coerce for comparison operators', () => {
      const expr = Expression.greaterThanOrEqual('age', 18);
      expect(expr.matches({ age: '18' })).toBe(true);
      expect(expr.matches({ age: '20' })).toBe(true);
      expect(expr.matches({ age: 20 })).toBe(true);
    });
  });

  describe('Case Sensitivity', () => {
    it('should match case-insensitively by default', () => {
      const expr = Expression.equals('name', 'john');
      expect(expr.matches({ name: 'John' })).toBe(true);
      expect(expr.matches({ name: 'JOHN' })).toBe(true);
      expect(expr.matches({ name: 'john' })).toBe(true);
    });

    it('should match case-sensitively when option is set', () => {
      const expr = Expression.equals('name', 'John');
      expect(expr.matches({ name: 'John' }, { caseSensitive: true })).toBe(true);
      expect(expr.matches({ name: 'john' }, { caseSensitive: true })).toBe(false);
      expect(expr.matches({ name: 'JOHN' }, { caseSensitive: true })).toBe(false);
    });

    it('should apply case sensitivity to contains', () => {
      const expr = Expression.contains('email', '@Example.com');
      expect(expr.matches({ email: 'user@example.com' })).toBe(true);
      expect(expr.matches({ email: 'user@EXAMPLE.COM' })).toBe(true);
      expect(expr.matches({ email: 'user@example.com' }, { caseSensitive: true })).toBe(false);
    });
  });

  describe('Property Access', () => {
    it('should access nested properties with dot notation', () => {
      const expr = Expression.equals('user.email', 'test@example.com');
      expect(expr.matches({ user: { email: 'test@example.com' } })).toBe(true);
      expect(expr.matches({ user: { email: 'other@example.com' } })).toBe(false);
    });

    it('should access deeply nested properties', () => {
      const expr = Expression.equals('user.address.city', 'NYC');
      expect(expr.matches({ user: { address: { city: 'NYC' } } })).toBe(true);
    });

    it('should handle missing properties as undefined', () => {
      const expr = Expression.isNull('missing');
      expect(expr.matches({})).toBe(true);
      expect(expr.matches({ other: 'value' })).toBe(true);
    });
  });

  describe('Null/Undefined Handling', () => {
    it('should match undefined properties with isNull', () => {
      const expr = Expression.isNull('age');
      expect(expr.matches({})).toBe(true);
      expect(expr.matches({ name: 'John' })).toBe(true);
    });

    it('should match null values with isNull', () => {
      const expr = Expression.isNull('age');
      expect(expr.matches({ age: null })).toBe(true);
      expect(expr.matches({ age: undefined })).toBe(true);
    });

    it('should not match defined values with isNull', () => {
      const expr = Expression.isNull('age');
      expect(expr.matches({ age: 0 })).toBe(false);
      expect(expr.matches({ age: '' })).toBe(false);
    });

    it('should match empty arrays with isEmpty', () => {
      const expr = Expression.isEmpty('tags');
      expect(expr.matches({ tags: [] })).toBe(true);
      expect(expr.matches({ tags: null })).toBe(true);
      expect(expr.matches({ tags: undefined })).toBe(true);
      expect(expr.matches({})).toBe(true);
    });

    it('should not match non-empty arrays with isEmpty', () => {
      const expr = Expression.isEmpty('tags');
      expect(expr.matches({ tags: ['a'] })).toBe(false);
      expect(expr.matches({ tags: [1, 2, 3] })).toBe(false);
    });
  });

  describe('Comparison Operations', () => {
    it('should match equals', () => {
      const expr = Expression.equals('status', 'active');
      expect(expr.matches({ status: 'active' })).toBe(true);
      expect(expr.matches({ status: 'inactive' })).toBe(false);
    });

    it('should match notEquals', () => {
      const expr = Expression.notEquals('status', 'deleted');
      expect(expr.matches({ status: 'active' })).toBe(true);
      expect(expr.matches({ status: 'deleted' })).toBe(false);
    });

    it('should match greaterThan', () => {
      const expr = Expression.greaterThan('age', 18);
      expect(expr.matches({ age: 20 })).toBe(true);
      expect(expr.matches({ age: 18 })).toBe(false);
      expect(expr.matches({ age: 15 })).toBe(false);
    });

    it('should match lessThanOrEqual', () => {
      const expr = Expression.lessThanOrEqual('price', 100);
      expect(expr.matches({ price: 50 })).toBe(true);
      expect(expr.matches({ price: 100 })).toBe(true);
      expect(expr.matches({ price: 150 })).toBe(false);
    });

    it('should match between (inclusive)', () => {
      const expr = Expression.between('age', 18, 65);
      expect(expr.matches({ age: 18 })).toBe(true);
      expect(expr.matches({ age: 65 })).toBe(true);
      expect(expr.matches({ age: 30 })).toBe(true);
      expect(expr.matches({ age: 17 })).toBe(false);
      expect(expr.matches({ age: 66 })).toBe(false);
    });
  });

  describe('String Operations', () => {
    it('should match contains', () => {
      const expr = Expression.contains('email', '@example.com');
      expect(expr.matches({ email: 'user@example.com' })).toBe(true);
      expect(expr.matches({ email: 'user@other.com' })).toBe(false);
    });

    it('should match startsWith', () => {
      const expr = Expression.startsWith('name', 'John');
      expect(expr.matches({ name: 'John Doe' })).toBe(true);
      expect(expr.matches({ name: 'Jane Doe' })).toBe(false);
    });

    it('should match endsWith', () => {
      const expr = Expression.endsWith('file', '.txt');
      expect(expr.matches({ file: 'document.txt' })).toBe(true);
      expect(expr.matches({ file: 'document.pdf' })).toBe(false);
    });

    it('should match regex', () => {
      const expr = Expression.matches('path', '^/home/.*/documents$');
      expect(expr.matches({ path: '/home/user/documents' })).toBe(true);
      expect(expr.matches({ path: '/home/admin/documents' })).toBe(true);
      expect(expr.matches({ path: '/var/documents' })).toBe(false);
    });

    it('should match wildcards', () => {
      const expr = Expression.equals('name', 'J*n');
      expect(expr.matches({ name: 'John' })).toBe(true);
      expect(expr.matches({ name: 'Jean' })).toBe(true);
      expect(expr.matches({ name: 'Joan' })).toBe(true);
      expect(expr.matches({ name: 'Jane' })).toBe(false);
    });
  });

  describe('Date Operations', () => {
    it('should parse ISO 8601 dates', () => {
      const expr = Expression.year('created', 2025);
      expect(expr.matches({ created: '2025-01-15' })).toBe(true);
      expect(expr.matches({ created: '2025-12-31T23:59:59Z' })).toBe(true);
      expect(expr.matches({ created: '2024-01-15' })).toBe(false);
    });

    it('should extract year and compare', () => {
      const expr = Expression.year('modified', 2025);
      expect(expr.matches({ modified: '2025-03-15T10:30:00Z' })).toBe(true);
      expect(expr.matches({ modified: '2024-03-15T10:30:00Z' })).toBe(false);
    });

    it('should match withinDays relative to now', () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const lastMonth = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);

      const expr = Expression.withinDays('created', 30);
      expect(expr.matches({ created: yesterday.toISOString() })).toBe(true);
      expect(expr.matches({ created: lastWeek.toISOString() })).toBe(true);
      expect(expr.matches({ created: lastMonth.toISOString() })).toBe(false);
    });
  });

  describe('Array Operations', () => {
    it('should match array includes', () => {
      const expr = Expression.includes('tags', 'premium');
      expect(expr.matches({ tags: ['premium', 'gold'] })).toBe(true);
      expect(expr.matches({ tags: ['basic'] })).toBe(false);
      expect(expr.matches({ tags: [] })).toBe(false);
    });

    it('should match array includesAny with OR logic', () => {
      const expr = Expression.includesAny('permissions', ['read', 'write']);
      expect(expr.matches({ permissions: ['read', 'execute'] })).toBe(true);
      expect(expr.matches({ permissions: ['write', 'delete'] })).toBe(true);
      expect(expr.matches({ permissions: ['execute', 'delete'] })).toBe(false);
    });

    it('should return false for non-array values', () => {
      const expr = Expression.includes('tags', 'premium');
      expect(expr.matches({ tags: 'premium' })).toBe(false);
      expect(expr.matches({ tags: null })).toBe(false);
    });
  });

  describe('Logical Operations', () => {
    it('should match AND expressions', () => {
      const expr = Expression.and(
        Expression.equals('status', 'active'),
        Expression.greaterThanOrEqual('age', 18)
      );
      expect(expr.matches({ status: 'active', age: 20 })).toBe(true);
      expect(expr.matches({ status: 'active', age: 15 })).toBe(false);
      expect(expr.matches({ status: 'inactive', age: 20 })).toBe(false);
    });

    it('should match OR expressions', () => {
      const expr = Expression.or(
        Expression.equals('role', 'admin'),
        Expression.equals('role', 'moderator')
      );
      expect(expr.matches({ role: 'admin' })).toBe(true);
      expect(expr.matches({ role: 'moderator' })).toBe(true);
      expect(expr.matches({ role: 'user' })).toBe(false);
    });

    it('should match NOT expressions', () => {
      const expr = Expression.not(Expression.equals('deleted', true));
      expect(expr.matches({ deleted: false })).toBe(true);
      expect(expr.matches({ deleted: true })).toBe(false);
    });
  });

  describe('Stream Filtering', () => {
    it('should filter array of objects efficiently', () => {
      const users = [
        { name: 'Alice', age: 25, status: 'active' },
        { name: 'Bob', age: 17, status: 'active' },
        { name: 'Charlie', age: 30, status: 'inactive' },
        { name: 'David', age: 22, status: 'active' },
      ];

      const activeAdults = Expression.and(
        Expression.equals('status', 'active'),
        Expression.greaterThanOrEqual('age', 18)
      );

      const results = users.filter(user => activeAdults.matches(user));
      expect(results).toHaveLength(2);
      expect(results.map(u => u.name)).toEqual(['Alice', 'David']);
    });

    it('should support chaining with map/filter', () => {
      const users = [
        { name: 'Alice', age: 25, email: 'alice@example.com' },
        { name: 'Bob', age: 17, email: 'bob@example.com' },
        { name: 'Charlie', age: 30, email: 'charlie@other.com' },
      ];

      const filter = Expression.and(
        Expression.greaterThanOrEqual('age', 18),
        Expression.contains('email', '@example.com')
      );

      const emails = users
        .filter(u => filter.matches(u))
        .map(u => u.email);

      expect(emails).toEqual(['alice@example.com']);
    });

    it('should handle complex nested filters', () => {
      const filter = Expression.and(
        Expression.equals('status', 'active'),
        Expression.or(
          Expression.contains('email', '@company.com'),
          Expression.equals('verified', true)
        )
      );

      expect(
        filter.matches({
          status: 'active',
          email: 'user@company.com',
          verified: false,
        })
      ).toBe(true);

      expect(
        filter.matches({
          status: 'active',
          email: 'user@other.com',
          verified: true,
        })
      ).toBe(true);

      expect(
        filter.matches({
          status: 'active',
          email: 'user@other.com',
          verified: false,
        })
      ).toBe(false);
    });
  });

  describe('Present Operator', () => {
    it('should match present for non-null scalars', () => {
      const expr = Expression.present('email');
      expect(expr.matches({ email: 'test@example.com' })).toBe(true);
      expect(expr.matches({ email: '' })).toBe(true);
      expect(expr.matches({ email: 0 })).toBe(true);
    });

    it('should not match present for null/undefined', () => {
      const expr = Expression.present('email');
      expect(expr.matches({ email: null })).toBe(false);
      expect(expr.matches({ email: undefined })).toBe(false);
      expect(expr.matches({})).toBe(false);
    });

    it('should match present for non-empty arrays', () => {
      const expr = Expression.present('tags');
      expect(expr.matches({ tags: ['a'] })).toBe(true);
      expect(expr.matches({ tags: [] })).toBe(false);
      expect(expr.matches({ tags: null })).toBe(false);
    });
  });

  describe('Approximate Matching', () => {
    it('should match approximately similar strings', () => {
      const expr = Expression.approxMatch('name', 'Jon');
      expect(expr.matches({ name: 'John' })).toBe(true);
      expect(expr.matches({ name: 'Jon' })).toBe(true);
    });
  });
});
