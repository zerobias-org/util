import { describe, it, expect } from 'vitest';
import { Expression } from '../src';

describe('RFC4515 Parser', () => {
  describe('Basic Parsing', () => {
    it('should parse simple equality', () => {
      const expr = Expression.parse('(name=John)');
      expect(expr.matches({ name: 'John' })).toBe(true);
      expect(expr.matches({ name: 'Jane' })).toBe(false);
    });

    it('should parse with whitespace', () => {
      const expr = Expression.parse('( name = John )');
      expect(expr.matches({ name: 'John' })).toBe(true);
    });

    it('should parse comparison operators', () => {
      const expr1 = Expression.parse('(age>=18)');
      expect(expr1.matches({ age: 20 })).toBe(true);
      expect(expr1.matches({ age: 15 })).toBe(false);

      const expr2 = Expression.parse('(price<=100)');
      expect(expr2.matches({ price: 50 })).toBe(true);
      expect(expr2.matches({ price: 150 })).toBe(false);

      const expr3 = Expression.parse('(count>5)');
      expect(expr3.matches({ count: 10 })).toBe(true);

      const expr4 = Expression.parse('(score<50)');
      expect(expr4.matches({ score: 30 })).toBe(true);
    });

    it('should parse not equals', () => {
      const expr = Expression.parse('(status!=deleted)');
      expect(expr.matches({ status: 'active' })).toBe(true);
      expect(expr.matches({ status: 'deleted' })).toBe(false);
    });

    it('should parse approximate match', () => {
      const expr = Expression.parse('(name~=Jon)');
      expect(expr.matches({ name: 'John' })).toBe(true);
    });

    it('should parse presence check', () => {
      const expr = Expression.parse('(email=*)');
      expect(expr.matches({ email: 'test@example.com' })).toBe(true);
      expect(expr.matches({ email: null })).toBe(false);
      expect(expr.matches({})).toBe(false);
    });

    it('should parse extended function syntax', () => {
      const expr1 = Expression.parse('(email:contains:@example.com)');
      expect(expr1.matches({ email: 'user@example.com' })).toBe(true);

      const expr2 = Expression.parse('(name:startsWith:John)');
      expect(expr2.matches({ name: 'John Doe' })).toBe(true);

      const expr3 = Expression.parse('(file:endsWith:.txt)');
      expect(expr3.matches({ file: 'document.txt' })).toBe(true);
    });

    it('should parse regex match', () => {
      const expr = Expression.parse('(path:matches:^/home/.*/documents$)');
      expect(expr.matches({ path: '/home/user/documents' })).toBe(true);
      expect(expr.matches({ path: '/var/documents' })).toBe(false);
    });

    it('should parse null checks', () => {
      const expr1 = Expression.parse('(age:isnull:)');
      expect(expr1.matches({})).toBe(true);
      expect(expr1.matches({ age: null })).toBe(true);
      expect(expr1.matches({ age: 0 })).toBe(false);

      const expr2 = Expression.parse('(tags:isempty:)');
      expect(expr2.matches({ tags: [] })).toBe(true);
      expect(expr2.matches({ tags: ['a'] })).toBe(false);
    });

    it('should parse array operations', () => {
      const expr1 = Expression.parse('(tags:includes:premium)');
      expect(expr1.matches({ tags: ['premium', 'gold'] })).toBe(true);

      const expr2 = Expression.parse('(permissions:includesAny:read,write)');
      expect(expr2.matches({ permissions: ['read', 'execute'] })).toBe(true);
    });

    it('should parse between operation', () => {
      const expr = Expression.parse('(age:between:18,65)');
      expect(expr.matches({ age: 30 })).toBe(true);
      expect(expr.matches({ age: 17 })).toBe(false);
      expect(expr.matches({ age: 66 })).toBe(false);
    });

    it('should parse date operations', () => {
      const expr1 = Expression.parse('(created:year:2025)');
      expect(expr1.matches({ created: '2025-03-15' })).toBe(true);
      expect(expr1.matches({ created: '2024-03-15' })).toBe(false);
    });
  });

  describe('Logical Operators', () => {
    it('should parse AND expressions', () => {
      const expr = Expression.parse('(&(status=active)(age>=18))');
      expect(expr.matches({ status: 'active', age: 20 })).toBe(true);
      expect(expr.matches({ status: 'active', age: 15 })).toBe(false);
      expect(expr.matches({ status: 'inactive', age: 20 })).toBe(false);
    });

    it('should parse OR expressions', () => {
      const expr = Expression.parse('(|(role=admin)(role=moderator))');
      expect(expr.matches({ role: 'admin' })).toBe(true);
      expect(expr.matches({ role: 'moderator' })).toBe(true);
      expect(expr.matches({ role: 'user' })).toBe(false);
    });

    it('should parse NOT expressions', () => {
      const expr = Expression.parse('(!(deleted=true))');
      expect(expr.matches({ deleted: false })).toBe(true);
      expect(expr.matches({ deleted: true })).toBe(false);
    });

    it('should parse nested groupings', () => {
      const expr = Expression.parse('(&(|(zip=90210)(name:startsWith:Rob))(status=Active))');
      expect(expr.matches({ zip: '90210', status: 'Active' })).toBe(true);
      expect(expr.matches({ name: 'Robert', status: 'Active' })).toBe(true);
      expect(expr.matches({ zip: '90210', status: 'Inactive' })).toBe(false);
    });

    it('should parse complex nested expressions', () => {
      const expr = Expression.parse(
        '(&(status=active)(|(email:contains:@company.com)(verified=true)))'
      );
      expect(
        expr.matches({ status: 'active', email: 'user@company.com', verified: false })
      ).toBe(true);
      expect(expr.matches({ status: 'active', email: 'user@other.com', verified: true })).toBe(
        true
      );
      expect(expr.matches({ status: 'active', email: 'user@other.com', verified: false })).toBe(
        false
      );
    });

    it('should parse multiple AND conditions', () => {
      const expr = Expression.parse('(&(a=1)(b=2)(c=3))');
      expect(expr.matches({ a: 1, b: 2, c: 3 })).toBe(true);
      expect(expr.matches({ a: 1, b: 2, c: 4 })).toBe(false);
    });

    it('should parse multiple OR conditions', () => {
      const expr = Expression.parse('(|(status=active)(status=pending)(status=approved))');
      expect(expr.matches({ status: 'active' })).toBe(true);
      expect(expr.matches({ status: 'pending' })).toBe(true);
      expect(expr.matches({ status: 'approved' })).toBe(true);
      expect(expr.matches({ status: 'rejected' })).toBe(false);
    });
  });

  describe('Wildcards', () => {
    it('should parse wildcard patterns', () => {
      const expr1 = Expression.parse('(name=J*n)');
      expect(expr1.matches({ name: 'John' })).toBe(true);
      expect(expr1.matches({ name: 'Jean' })).toBe(true);

      const expr2 = Expression.parse('(email=*@example.com)');
      expect(expr2.matches({ email: 'user@example.com' })).toBe(true);
      expect(expr2.matches({ email: 'admin@example.com' })).toBe(true);

      const expr3 = Expression.parse('(name=John*)');
      expect(expr3.matches({ name: 'Johnson' })).toBe(true);
      expect(expr3.matches({ name: 'Johnny' })).toBe(true);
    });

    it('should convert wildcards to regex-like matching', () => {
      const expr = Expression.parse('(path=/home/*/documents)');
      expect(expr.matches({ path: '/home/user/documents' })).toBe(true);
      expect(expr.matches({ path: '/home/admin/documents' })).toBe(true);
      expect(expr.matches({ path: '/var/documents' })).toBe(false);
    });
  });

  describe('Property Paths', () => {
    it('should parse nested property paths', () => {
      const expr = Expression.parse('(user.email=test@example.com)');
      expect(expr.matches({ user: { email: 'test@example.com' } })).toBe(true);
      expect(expr.matches({ user: { email: 'other@example.com' } })).toBe(false);
    });

    it('should parse deeply nested paths', () => {
      const expr = Expression.parse('(user.address.city=NYC)');
      expect(expr.matches({ user: { address: { city: 'NYC' } } })).toBe(true);
    });
  });

  describe('Value Types', () => {
    it('should parse boolean values', () => {
      const expr = Expression.parse('(active=true)');
      expect(expr.matches({ active: true })).toBe(true);
      expect(expr.matches({ active: 'true' })).toBe(true);
      expect(expr.matches({ active: false })).toBe(false);
    });

    it('should parse numeric values', () => {
      const expr = Expression.parse('(age>=18)');
      expect(expr.matches({ age: 18 })).toBe(true);
      expect(expr.matches({ age: '18' })).toBe(true);
    });

    it('should parse string values with special characters', () => {
      const expr = Expression.parse('(email:contains:@example.com)');
      expect(expr.matches({ email: 'user@example.com' })).toBe(true);
    });
  });

  describe('Validation', () => {
    it('should throw on invalid syntax - missing opening paren', () => {
      expect(() => Expression.parse('name=John)')).toThrow();
    });

    it('should throw on invalid syntax - missing closing paren', () => {
      expect(() => Expression.parse('(name=John')).toThrow();
    });

    it('should throw on invalid syntax - empty expression', () => {
      expect(() => Expression.parse('()')).toThrow();
    });

    it('should throw on invalid syntax - missing operator', () => {
      expect(() => Expression.parse('(name)')).toThrow();
    });

    it('should throw on unknown operator', () => {
      // Use an operator that will be parsed as an operator but doesn't exist
      expect(() => Expression.parse('(name@John)')).toThrow();
    });

    it('should validate BETWEEN requires two values', () => {
      expect(() => Expression.parse('(age:between:18)')).toThrow('two comma-separated values');
    });

    it('should validate BETWEEN requires numeric values', () => {
      expect(() => Expression.parse('(age:between:abc,def)')).toThrow('numeric values');
    });

    it('should throw on invalid regex', () => {
      expect(() => Expression.parse('(path:matches:[invalid)')).toThrow('Invalid regex');
    });

    it('should throw on extra characters after expression', () => {
      expect(() => Expression.parse('(name=John) extra')).toThrow('Unexpected characters');
    });

    it('should throw on empty AND', () => {
      expect(() => Expression.parse('(&)')).toThrow('at least one sub-expression');
    });

    it('should throw on empty OR', () => {
      expect(() => Expression.parse('(|)')).toThrow('at least one sub-expression');
    });
  });

  describe('Integration Tests', () => {
    it('should parse and match real-world filter', () => {
      const filter = '(&(status=active)(created_at>=2024-01-01))';
      const expr = Expression.parse(filter);
      expect(expr.matches({ status: 'active', created_at: '2024-06-01' })).toBe(true);
      expect(expr.matches({ status: 'inactive', created_at: '2024-06-01' })).toBe(false);
    });

    it('should parse and match complex real-world filter', () => {
      const filter =
        '(&(department=Engineering)(level>=5)(|(location=NYC)(location=SF))(verified=true))';
      const expr = Expression.parse(filter);

      expect(
        expr.matches({
          department: 'Engineering',
          level: 5,
          location: 'NYC',
          verified: true,
        })
      ).toBe(true);

      expect(
        expr.matches({
          department: 'Engineering',
          level: 5,
          location: 'SF',
          verified: true,
        })
      ).toBe(true);

      expect(
        expr.matches({
          department: 'Engineering',
          level: 5,
          location: 'LA',
          verified: true,
        })
      ).toBe(false);
    });
  });
});
