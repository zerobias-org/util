/**
 * Tests for JsonataIntegration utility
 */
import { expect } from 'chai';
import jsonata from 'jsonata';
import { JsonataIntegration } from '../src';

describe('JsonataIntegration', () => {
  describe('registerFunctions', () => {
    it('should register string modifiers', async () => {
      const expr = jsonata('$uppercase($trim("  hello  "))');
      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate({});
      expect(result).to.equal('HELLO');
    });

    it('should register number modifiers', async () => {
      const expr = jsonata('$round(3.7)');
      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate({});
      expect(result).to.equal(4);
    });

    it('should register number modifiers with parameters', async () => {
      const expr = jsonata('$round(3.456, 2)');
      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate({});
      expect(result).to.equal(3.46);
    });

    it('should register date modifiers', async () => {
      const expr = jsonata('$extractYear("2023-01-15T10:30:00Z")');
      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate({});
      expect(result).to.equal(2023);
    });

    it('should register array modifiers', async () => {
      const expr = jsonata('$unique([1, 2, 2, 3, 1])');
      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate({});
      expect(result).to.deep.equal([1, 2, 3]);
    });

    it('should register path utilities', async () => {
      const data = {
        user: {
          profile: {
            name: 'John',
          },
        },
      };
      const expr = jsonata('$getNestedValue(data, "user.profile.name")');
      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate({ data });
      expect(result).to.equal('John');
    });

    it('should register value converters', async () => {
      const expr = jsonata('$toNumber("123.45")');
      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate({});
      expect(result).to.equal(123.45);
    });

    it('should chain multiple modifiers', async () => {
      const expr = jsonata('$slugify($lowercase($trim("  HELLO World!  ")))');
      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate({});
      expect(result).to.equal('hello-world');
    });

    it('should work with data from context', async () => {
      const data = { firstName: '  john  ', lastName: 'doe' };
      const expr = jsonata('$uppercase($trim(firstName)) & " " & $capitalize($trim(lastName))');
      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate(data);
      expect(result).to.equal('JOHN Doe');
    });

    it('should handle array operations', async () => {
      const data = {
        users: [
          { name: 'John' },
          { name: 'Jane' },
          { name: 'Bob' },
        ],
      };
      const expr = jsonata('$first($getArrayValues(data, "users[].name"))');
      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate({ data });
      expect(result).to.equal('John');
    });

    it('should handle formatCurrency', async () => {
      const expr = jsonata('$formatCurrency(1234.56)');
      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate({});
      expect(result).to.equal('$1234.56');
    });

    it('should handle percentage calculations', async () => {
      const expr = jsonata('$percentage(0.5)');
      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate({});
      expect(result).to.equal(50);
    });

    it('should handle array join', async () => {
      const expr = jsonata('$join(["a", "b", "c"], "-")');
      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate({});
      expect(result).to.equal('a-b-c');
    });

    it('should handle array slice', async () => {
      const expr = jsonata('$slice([1, 2, 3, 4, 5], 1, 3)');
      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate({});
      expect(result).to.deep.equal([2, 3]);
    });

    it('should handle date operations', async () => {
      const date = new Date(2023, 0, 15); // Jan 15, 2023
      const expr = jsonata('$extractMonth($addDays(date, 20))');
      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate({ date });
      expect(result).to.equal(2); // February
    });
  });

  describe('getModifier', () => {
    it('should return string modifier functions', () => {
      const uppercase = JsonataIntegration.getModifier('uppercase');
      expect(uppercase).to.be.a('function');
      expect(uppercase!('hello')).to.equal('HELLO');
    });

    it('should return number modifier functions', () => {
      const round = JsonataIntegration.getModifier('round');
      expect(round).to.be.a('function');
      expect(round!(3.7)).to.equal(4);
    });

    it('should return date modifier functions', () => {
      const extractYear = JsonataIntegration.getModifier('extractYear');
      expect(extractYear).to.be.a('function');
      expect(extractYear!(new Date(2023, 0, 15))).to.equal(2023);
    });

    it('should return array modifier functions', () => {
      const first = JsonataIntegration.getModifier('first');
      expect(first).to.be.a('function');
      expect(first!([1, 2, 3])).to.equal(1);
    });

    it('should return undefined for unknown modifiers', () => {
      const unknown = JsonataIntegration.getModifier('doesNotExist');
      expect(unknown).to.be.undefined;
    });

    it('should support modifier chains', () => {
      const modifiers = ['trim', 'uppercase'];
      let value = '  hello  ';

      for (const name of modifiers) {
        const fn = JsonataIntegration.getModifier(name);
        if (fn) {
          value = fn(value) as string;
        }
      }

      expect(value).to.equal('HELLO');
    });

    it('should support round2 shorthand', () => {
      const round2 = JsonataIntegration.getModifier('round2');
      expect(round2).to.be.a('function');
      expect(round2!(3.456)).to.equal(3.46);
    });
  });

  describe('getModifierNames', () => {
    it('should return all modifier names', () => {
      const names = JsonataIntegration.getModifierNames();
      expect(names).to.be.an('array');
      expect(names.length).to.be.greaterThan(40);
    });

    it('should include string modifiers', () => {
      const names = JsonataIntegration.getModifierNames();
      expect(names).to.include('uppercase');
      expect(names).to.include('lowercase');
      expect(names).to.include('trim');
      expect(names).to.include('capitalize');
      expect(names).to.include('slugify');
    });

    it('should include number modifiers', () => {
      const names = JsonataIntegration.getModifierNames();
      expect(names).to.include('round');
      expect(names).to.include('formatCurrency');
      expect(names).to.include('percentage');
    });

    it('should include date modifiers', () => {
      const names = JsonataIntegration.getModifierNames();
      expect(names).to.include('dateOnly');
      expect(names).to.include('extractYear');
      expect(names).to.include('addDays');
    });

    it('should include array modifiers', () => {
      const names = JsonataIntegration.getModifierNames();
      expect(names).to.include('unique');
      expect(names).to.include('first');
      expect(names).to.include('last');
    });

    it('should include path utilities', () => {
      const names = JsonataIntegration.getModifierNames();
      expect(names).to.include('getNestedValue');
      expect(names).to.include('getArrayValues');
    });

    it('should include value converters', () => {
      const names = JsonataIntegration.getModifierNames();
      expect(names).to.include('toBoolean');
      expect(names).to.include('toNumber');
      expect(names).to.include('toString');
    });

    it('all returned names should have working modifiers', () => {
      const names = JsonataIntegration.getModifierNames();

      for (const name of names) {
        const fn = JsonataIntegration.getModifier(name);
        expect(fn, `Modifier "${name}" should exist`).to.not.be.undefined;
      }
    });
  });

  describe('Real-world mapping scenarios', () => {
    it('should transform user data', async () => {
      const sourceData = {
        first_name: '  JOHN  ',
        last_name: 'doe',
        email: 'john.doe@example.com',
      };

      const expr = jsonata(`{
        "displayName": $uppercase($trim(first_name)) & " " & $capitalize($trim(last_name)),
        "username": $slugify(first_name & "-" & last_name),
        "contact": $lowercase($trim(email))
      }`);

      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate(sourceData);

      expect(result).to.deep.equal({
        displayName: 'JOHN Doe',
        username: 'john-doe',
        contact: 'john.doe@example.com',
      });
    });

    it('should transform financial data', async () => {
      const sourceData = {
        price: 1234.567,
        quantity: 3,
        discount: 0.15,
      };

      const expr = jsonata(`{
        "formattedPrice": $formatCurrency(price),
        "total": $formatCurrency(price * quantity),
        "discountPercent": $percentage(discount) & "%",
        "finalAmount": $formatCurrency($round(price * quantity * (1 - discount), 2))
      }`);

      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate(sourceData);

      expect(result.formattedPrice).to.equal('$1234.57');
      expect(result.discountPercent).to.equal('15%');
    });

    it('should transform nested array data', async () => {
      const sourceData = {
        departments: [
          { name: 'Engineering', city: 'Boston' },
          { name: 'Sales', city: 'NYC' },
          { name: 'Marketing', city: 'Boston' },
        ],
      };

      const expr = jsonata(`{
        "cities": $unique($getArrayValues(sourceData, "departments[].city")),
        "firstDept": $first($getArrayValues(sourceData, "departments[].name")),
        "deptCount": $arraySize(sourceData.departments)
      }`);

      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate({ sourceData });

      expect(result.cities).to.deep.equal(['Boston', 'NYC']);
      expect(result.firstDept).to.equal('Engineering');
      expect(result.deptCount).to.equal(3);
    });

    it('should transform date data', async () => {
      const sourceData = {
        createdAt: '2023-01-15T10:30:00Z',
        daysToAdd: 30,
      };

      const expr = jsonata(`{
        "year": $extractYear(createdAt),
        "dateOnly": $dateOnly(createdAt),
        "futureDate": $dateOnly($addDays(createdAt, daysToAdd))
      }`);

      JsonataIntegration.registerFunctions(expr);
      const result = await expr.evaluate(sourceData);

      expect(result.year).to.equal(2023);
      expect(result.dateOnly).to.equal('2023-01-15');
      expect(result.futureDate).to.include('2023-02-14');
    });
  });
});
