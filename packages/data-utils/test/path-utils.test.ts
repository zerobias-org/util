/**
 * Tests for PathUtils utility
 */
import { expect } from 'chai';
import { PathUtils } from '../src';

describe('PathUtils', () => {
  describe('getNestedValue', () => {
    const testObj = {
      user: {
        profile: {
          name: 'John Doe',
          age: 30,
        },
        settings: {
          theme: 'dark',
        },
      },
      items: [1, 2, 3],
    };

    it('should get nested values with dot notation', () => {
      expect(PathUtils.getNestedValue(testObj, 'user.profile.name')).to.equal('John Doe');
      expect(PathUtils.getNestedValue(testObj, 'user.profile.age')).to.equal(30);
      expect(PathUtils.getNestedValue(testObj, 'user.settings.theme')).to.equal('dark');
    });

    it('should get top-level values', () => {
      expect(PathUtils.getNestedValue(testObj, 'items')).to.deep.equal([1, 2, 3]);
    });

    it('should return undefined for non-existent paths', () => {
      expect(PathUtils.getNestedValue(testObj, 'user.nonexistent')).to.be.undefined;
      expect(PathUtils.getNestedValue(testObj, 'user.profile.missing')).to.be.undefined;
      expect(PathUtils.getNestedValue(testObj, 'completely.invalid.path')).to.be.undefined;
    });

    it('should handle empty path', () => {
      expect(PathUtils.getNestedValue(testObj, '')).to.equal(testObj);
    });

    it('should handle null/undefined objects', () => {
      expect(PathUtils.getNestedValue(null, 'path')).to.be.undefined;
      expect(PathUtils.getNestedValue(undefined, 'path')).to.be.undefined;
    });
  });

  describe('setNestedValue', () => {
    it('should set nested values', () => {
      const obj: any = {};
      PathUtils.setNestedValue(obj, 'user.profile.name', 'John Doe');
      expect(obj).to.deep.equal({
        user: {
          profile: {
            name: 'John Doe',
          },
        },
      });
    });

    it('should update existing nested values', () => {
      const obj = {
        user: {
          profile: {
            name: 'Jane',
          },
        },
      };
      PathUtils.setNestedValue(obj, 'user.profile.name', 'John');
      expect(obj.user.profile.name).to.equal('John');
    });

    it('should create intermediate objects', () => {
      const obj: any = {};
      PathUtils.setNestedValue(obj, 'a.b.c.d.e', 'value');
      expect(obj.a.b.c.d.e).to.equal('value');
    });

    it('should handle top-level properties', () => {
      const obj: any = {};
      PathUtils.setNestedValue(obj, 'name', 'John');
      expect(obj.name).to.equal('John');
    });

    it('should handle null/undefined objects gracefully', () => {
      expect(() => PathUtils.setNestedValue(null, 'path', 'value')).to.not.throw();
      expect(() => PathUtils.setNestedValue(undefined, 'path', 'value')).to.not.throw();
    });

    it('should handle empty path', () => {
      const obj: any = {};
      PathUtils.setNestedValue(obj, '', 'value');
      expect(obj).to.deep.equal({});
    });
  });

  describe('getArrayItemValues', () => {
    const testObj = {
      users: [
        { name: 'John', email: 'john@example.com', profile: { age: 30 } },
        { name: 'Jane', email: 'jane@example.com', profile: { age: 25 } },
        { name: 'Bob', email: 'bob@example.com', profile: { age: 35 } },
      ],
      addresses: [
        { street: '123 Main St', city: 'Boston' },
        { street: '456 Oak Ave', city: 'NYC' },
      ],
    };

    it('should get values from array items', () => {
      const names = PathUtils.getArrayItemValues(testObj, 'users[].name');
      expect(names).to.deep.equal(['John', 'Jane', 'Bob']);

      const emails = PathUtils.getArrayItemValues(testObj, 'users[].email');
      expect(emails).to.deep.equal(['john@example.com', 'jane@example.com', 'bob@example.com']);
    });

    it('should get nested values from array items', () => {
      const ages = PathUtils.getArrayItemValues(testObj, 'users[].profile.age');
      expect(ages).to.deep.equal([30, 25, 35]);
    });

    it('should handle multiple arrays', () => {
      const cities = PathUtils.getArrayItemValues(testObj, 'addresses[].city');
      expect(cities).to.deep.equal(['Boston', 'NYC']);
    });

    it('should return empty array for non-array paths', () => {
      const result = PathUtils.getArrayItemValues({ notArray: 'value' }, 'notArray[].field');
      expect(result).to.deep.equal([]);
    });

    it('should return empty array for non-existent paths', () => {
      const result = PathUtils.getArrayItemValues(testObj, 'nonexistent[].field');
      expect(result).to.deep.equal([]);
    });

    it('should return array itself if no property specified', () => {
      const result = PathUtils.getArrayItemValues(testObj, 'users[].');
      expect(result).to.be.an('array');
      expect(result).to.have.lengthOf(3);
    });

    it('should handle paths without array notation', () => {
      const result = PathUtils.getArrayItemValues(testObj, 'users.name');
      expect(result).to.deep.equal([]);
    });
  });

  describe('setArrayItemValues', () => {
    it('should set values in array items', () => {
      const obj = {
        users: [
          { name: 'John' },
          { name: 'Jane' },
        ],
      };

      PathUtils.setArrayItemValues(obj, 'users[].age', [30, 25]);
      expect(obj.users[0]).to.deep.include({ name: 'John', age: 30 });
      expect(obj.users[1]).to.deep.include({ name: 'Jane', age: 25 });
    });

    it('should set nested values in array items', () => {
      const obj = {
        users: [
          { profile: {} },
          { profile: {} },
        ],
      };

      PathUtils.setArrayItemValues(obj, 'users[].profile.age', [30, 25]);
      expect(obj.users[0].profile).to.deep.include({ age: 30 });
      expect(obj.users[1].profile).to.deep.include({ age: 25 });
    });

    it('should handle fewer values than array items', () => {
      const obj = {
        users: [
          { name: 'John' },
          { name: 'Jane' },
          { name: 'Bob' },
        ],
      };

      PathUtils.setArrayItemValues(obj, 'users[].age', [30, 25]);
      expect(obj.users[0]).to.deep.include({ age: 30 });
      expect(obj.users[1]).to.deep.include({ age: 25 });
      expect(obj.users[2]).to.not.have.property('age');
    });

    it('should handle non-array paths gracefully', () => {
      const obj = { notArray: 'value' };
      expect(() => PathUtils.setArrayItemValues(obj, 'notArray[].field', [1, 2])).to.not.throw();
    });

    it('should handle non-array values parameter', () => {
      const obj = { users: [{ name: 'John' }] };
      expect(() => PathUtils.setArrayItemValues(obj, 'users[].age', 'not-array' as any)).to.not.throw();
    });
  });

  describe('hasPath', () => {
    const testObj = {
      user: {
        name: 'John',
        profile: {
          age: 30,
        },
      },
      items: [],
    };

    it('should return true for existing paths', () => {
      expect(PathUtils.hasPath(testObj, 'user.name')).to.be.true;
      expect(PathUtils.hasPath(testObj, 'user.profile.age')).to.be.true;
      expect(PathUtils.hasPath(testObj, 'items')).to.be.true;
    });

    it('should return false for non-existent paths', () => {
      expect(PathUtils.hasPath(testObj, 'user.email')).to.be.false;
      expect(PathUtils.hasPath(testObj, 'user.profile.city')).to.be.false;
      expect(PathUtils.hasPath(testObj, 'nonexistent')).to.be.false;
    });

    it('should return true for empty arrays', () => {
      expect(PathUtils.hasPath(testObj, 'items')).to.be.true;
    });

    it('should return false for null values', () => {
      const obj = { value: null };
      expect(PathUtils.hasPath(obj, 'value')).to.be.false;
    });
  });

  describe('deletePath', () => {
    it('should delete nested properties', () => {
      const obj = {
        user: {
          name: 'John',
          email: 'john@example.com',
        },
      };

      const result = PathUtils.deletePath(obj, 'user.email');
      expect(result).to.be.true;
      expect(obj.user).to.deep.equal({ name: 'John' });
    });

    it('should delete top-level properties', () => {
      const obj: any = {
        name: 'John',
        age: 30,
      };

      const result = PathUtils.deletePath(obj, 'age');
      expect(result).to.be.true;
      expect(obj).to.deep.equal({ name: 'John' });
    });

    it('should return false for non-existent paths', () => {
      const obj = {
        user: {
          name: 'John',
        },
      };

      const result = PathUtils.deletePath(obj, 'user.email');
      expect(result).to.be.false;
      expect(obj.user).to.deep.equal({ name: 'John' });
    });

    it('should return false for invalid paths', () => {
      const obj = {
        user: 'string',
      };

      const result = PathUtils.deletePath(obj, 'user.property');
      expect(result).to.be.false;
    });

    it('should handle null/undefined objects', () => {
      expect(PathUtils.deletePath(null, 'path')).to.be.false;
      expect(PathUtils.deletePath(undefined, 'path')).to.be.false;
    });

    it('should handle empty path', () => {
      const obj = { name: 'John' };
      expect(PathUtils.deletePath(obj, '')).to.be.false;
      expect(obj).to.deep.equal({ name: 'John' });
    });
  });

  describe('Complex scenarios', () => {
    it('should handle deeply nested structures', () => {
      const obj: any = {};
      PathUtils.setNestedValue(obj, 'a.b.c.d.e.f.g', 'deep value');
      expect(PathUtils.getNestedValue(obj, 'a.b.c.d.e.f.g')).to.equal('deep value');
      expect(PathUtils.hasPath(obj, 'a.b.c.d.e.f.g')).to.be.true;
    });

    it('should handle mixed array and object paths', () => {
      const obj = {
        departments: [
          {
            name: 'Engineering',
            employees: [
              { name: 'John', skills: { primary: 'TypeScript' } },
              { name: 'Jane', skills: { primary: 'Python' } },
            ],
          },
        ],
      };

      const skills = PathUtils.getArrayItemValues(obj, 'departments[].employees[].skills.primary');
      expect(skills).to.have.lengthOf(2);
    });

    it('should handle updates to complex structures', () => {
      const obj = {
        config: {
          server: {
            port: 3000,
            host: 'localhost',
          },
        },
      };

      PathUtils.setNestedValue(obj, 'config.server.port', 8080);
      PathUtils.setNestedValue(obj, 'config.database.host', 'db.example.com');

      expect(obj.config.server.port).to.equal(8080);
      expect((obj.config as any).database.host).to.equal('db.example.com');
    });
  });
});
