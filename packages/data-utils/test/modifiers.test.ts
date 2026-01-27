/**
 * Tests for Modifier utilities
 */
import { expect } from 'chai';
import { StringModifiers, NumberModifiers, DateModifiers, ArrayModifiers } from '../src';

describe('StringModifiers', () => {
  describe('uppercase', () => {
    it('should convert to uppercase', () => {
      expect(StringModifiers.uppercase('hello')).to.equal('HELLO');
      expect(StringModifiers.uppercase('Hello World')).to.equal('HELLO WORLD');
    });

    it('should handle non-strings', () => {
      expect(StringModifiers.uppercase(123 as any)).to.equal(123);
    });
  });

  describe('lowercase', () => {
    it('should convert to lowercase', () => {
      expect(StringModifiers.lowercase('HELLO')).to.equal('hello');
      expect(StringModifiers.lowercase('Hello World')).to.equal('hello world');
    });

    it('should handle non-strings', () => {
      expect(StringModifiers.lowercase(123 as any)).to.equal(123);
    });
  });

  describe('capitalize', () => {
    it('should capitalize first letter', () => {
      expect(StringModifiers.capitalize('hello')).to.equal('Hello');
      expect(StringModifiers.capitalize('HELLO')).to.equal('Hello');
      expect(StringModifiers.capitalize('hello world')).to.equal('Hello world');
    });

    it('should handle empty strings', () => {
      expect(StringModifiers.capitalize('')).to.equal('');
    });

    it('should handle non-strings', () => {
      expect(StringModifiers.capitalize(123 as any)).to.equal(123);
    });
  });

  describe('trim', () => {
    it('should trim whitespace', () => {
      expect(StringModifiers.trim('  hello  ')).to.equal('hello');
      expect(StringModifiers.trim('\n\thello\n\t')).to.equal('hello');
    });

    it('should handle non-strings', () => {
      expect(StringModifiers.trim(123 as any)).to.equal(123);
    });
  });

  describe('reverse', () => {
    it('should reverse strings', () => {
      expect(StringModifiers.reverse('hello')).to.equal('olleh');
      expect(StringModifiers.reverse('abc')).to.equal('cba');
    });

    it('should handle non-strings', () => {
      expect(StringModifiers.reverse(123 as any)).to.equal(123);
    });
  });

  describe('slugify', () => {
    it('should convert to URL-friendly slug', () => {
      expect(StringModifiers.slugify('Hello World')).to.equal('hello-world');
      expect(StringModifiers.slugify('Hello World!')).to.equal('hello-world');
      expect(StringModifiers.slugify('My Title  ')).to.equal('my-title');
    });

    it('should handle special characters', () => {
      expect(StringModifiers.slugify('Hello@World#Test')).to.equal('helloworldtest');
      expect(StringModifiers.slugify('Test___Value')).to.equal('test-value');
    });

    it('should handle non-strings', () => {
      expect(StringModifiers.slugify(123 as any)).to.equal(123);
    });
  });

  describe('padLeft', () => {
    it('should pad with default space', () => {
      expect(StringModifiers.padLeft('5', 3)).to.equal('  5');
      expect(StringModifiers.padLeft('hi', 5)).to.equal('   hi');
    });

    it('should pad with custom character', () => {
      expect(StringModifiers.padLeft('5', 3, '0')).to.equal('005');
      expect(StringModifiers.padLeft('hi', 5, '-')).to.equal('---hi');
    });
  });
});

describe('NumberModifiers', () => {
  describe('round', () => {
    it('should round to nearest integer', () => {
      expect(NumberModifiers.round(3.7)).to.equal(4);
      expect(NumberModifiers.round(3.4)).to.equal(3);
      expect(NumberModifiers.round(3.5)).to.equal(4);
    });

    it('should round to decimal places', () => {
      expect(NumberModifiers.round(3.14159, 2)).to.equal(3.14);
      expect(NumberModifiers.round(3.14159, 3)).to.equal(3.142);
    });

    it('should handle non-numbers', () => {
      expect(NumberModifiers.round('abc' as any)).to.equal('abc');
    });
  });

  describe('floor', () => {
    it('should round down', () => {
      expect(NumberModifiers.floor(3.9)).to.equal(3);
      expect(NumberModifiers.floor(3.1)).to.equal(3);
    });

    it('should handle non-numbers', () => {
      expect(NumberModifiers.floor('abc' as any)).to.equal('abc');
    });
  });

  describe('ceil', () => {
    it('should round up', () => {
      expect(NumberModifiers.ceil(3.1)).to.equal(4);
      expect(NumberModifiers.ceil(3.9)).to.equal(4);
    });

    it('should handle non-numbers', () => {
      expect(NumberModifiers.ceil('abc' as any)).to.equal('abc');
    });
  });

  describe('abs', () => {
    it('should return absolute value', () => {
      expect(NumberModifiers.abs(-42)).to.equal(42);
      expect(NumberModifiers.abs(42)).to.equal(42);
      expect(NumberModifiers.abs(-3.14)).to.equal(3.14);
    });

    it('should handle non-numbers', () => {
      expect(NumberModifiers.abs('abc' as any)).to.equal('abc');
    });
  });

  describe('formatCurrency', () => {
    it('should format as USD by default', () => {
      expect(NumberModifiers.formatCurrency(1234.56)).to.equal('$1234.56');
      expect(NumberModifiers.formatCurrency(100)).to.equal('$100.00');
    });

    it('should handle different currencies', () => {
      const result = NumberModifiers.formatCurrency(1234.56, 'EUR', 'en-US');
      expect(result).to.include('1,234.56');
      expect(result).to.match(/EUR|€/);
    });

    it('should handle non-numbers', () => {
      expect(NumberModifiers.formatCurrency('abc' as any)).to.equal('abc');
    });
  });

  describe('pow', () => {
    it('should raise to power', () => {
      expect(NumberModifiers.pow(3)).to.equal(9);
      expect(NumberModifiers.pow(5, 2)).to.equal(25);
      expect(NumberModifiers.pow(2, 3)).to.equal(8);
    });

    it('should handle non-numbers', () => {
      expect(NumberModifiers.pow('abc' as any)).to.equal('abc');
    });
  });

  describe('sqrt', () => {
    it('should calculate square root', () => {
      expect(NumberModifiers.sqrt(9)).to.equal(3);
      expect(NumberModifiers.sqrt(16)).to.equal(4);
      expect(NumberModifiers.sqrt(2)).to.be.closeTo(1.414, 0.001);
    });

    it('should handle non-numbers', () => {
      expect(NumberModifiers.sqrt('abc' as any)).to.equal('abc');
    });
  });

  describe('log', () => {
    it('should calculate base-10 logarithm', () => {
      expect(NumberModifiers.log(100)).to.equal(2);
      expect(NumberModifiers.log(1000)).to.equal(3);
      expect(NumberModifiers.log(10)).to.equal(1);
    });

    it('should handle non-numbers', () => {
      expect(NumberModifiers.log('abc' as any)).to.equal('abc');
    });
  });

  describe('percentage', () => {
    it('should convert to percentage', () => {
      expect(NumberModifiers.percentage(0.5)).to.equal(50);
      expect(NumberModifiers.percentage(0.75)).to.equal(75);
      expect(NumberModifiers.percentage(1)).to.equal(100);
    });

    it('should calculate percentage of total', () => {
      expect(NumberModifiers.percentage(25, 100)).to.equal(25);
      expect(NumberModifiers.percentage(50, 200)).to.equal(25);
    });

    it('should handle decimal places', () => {
      expect(NumberModifiers.percentage(1 / 3, undefined, 2)).to.equal(33.33);
      expect(NumberModifiers.percentage(1 / 3, undefined, 4)).to.equal(33.3333);
    });

    it('should handle non-numbers', () => {
      expect(NumberModifiers.percentage('abc' as any)).to.equal('abc');
    });
  });
});

describe('DateModifiers', () => {
  describe('formatDate', () => {
    it('should format dates', () => {
      const date = new Date('2023-01-15');
      const result = DateModifiers.formatDate(date);
      expect(result).to.be.a('string');
      expect(result).to.include('2023');
    });

    it('should format date strings', () => {
      const result = DateModifiers.formatDate('2023-01-15');
      expect(result).to.be.a('string');
      expect(result).to.include('2023');
    });

    it('should handle invalid dates', () => {
      expect(DateModifiers.formatDate('invalid')).to.equal('invalid');
    });
  });

  describe('dateOnly', () => {
    it('should extract date only', () => {
      const date = new Date('2023-01-15T10:30:00Z');
      expect(DateModifiers.dateOnly(date)).to.equal('2023-01-15');
    });

    it('should handle date strings', () => {
      expect(DateModifiers.dateOnly('2023-01-15T10:30:00Z')).to.equal('2023-01-15');
    });

    it('should handle invalid dates', () => {
      expect(DateModifiers.dateOnly('invalid')).to.equal('invalid');
    });
  });

  describe('timeOnly', () => {
    it('should extract time only', () => {
      const date = new Date('2023-01-15T10:30:00Z');
      const result = DateModifiers.timeOnly(date);
      expect(result).to.include('10:30:00');
    });

    it('should handle invalid dates', () => {
      expect(DateModifiers.timeOnly('invalid')).to.equal('invalid');
    });
  });

  describe('toTimestamp', () => {
    it('should convert to Unix timestamp', () => {
      const date = new Date('2023-01-15T00:00:00Z');
      const timestamp = DateModifiers.toTimestamp(date);
      expect(timestamp).to.be.a('number');
      expect(timestamp).to.equal(1673740800);
    });

    it('should handle date strings', () => {
      const timestamp = DateModifiers.toTimestamp('2023-01-15T00:00:00Z');
      expect(timestamp).to.equal(1673740800);
    });

    it('should handle invalid dates', () => {
      expect(DateModifiers.toTimestamp('invalid')).to.equal('invalid');
    });
  });

  describe('addDays', () => {
    it('should add days to date', () => {
      const date = new Date(2023, 0, 15); // Month is 0-indexed
      const result = DateModifiers.addDays(date, 5);
      expect(result).to.be.instanceOf(Date);
      expect((result as Date).getDate()).to.equal(20);
    });

    it('should add days with default', () => {
      const date = new Date(2023, 0, 15);
      const result = DateModifiers.addDays(date);
      expect((result as Date).getDate()).to.equal(16);
    });

    it('should handle date strings', () => {
      const result = DateModifiers.addDays('2023-01-15', 5);
      expect(result).to.be.instanceOf(Date);
    });

    it('should handle invalid dates', () => {
      expect(DateModifiers.addDays('invalid', 5)).to.equal('invalid');
    });
  });

  describe('subtractDays', () => {
    it('should subtract days from date', () => {
      const date = new Date(2023, 0, 15);
      const result = DateModifiers.subtractDays(date, 5);
      expect(result).to.be.instanceOf(Date);
      expect((result as Date).getDate()).to.equal(10);
    });
  });

  describe('extractYear', () => {
    it('should extract year', () => {
      const date = new Date('2023-01-15');
      expect(DateModifiers.extractYear(date)).to.equal(2023);
    });

    it('should handle date strings', () => {
      expect(DateModifiers.extractYear('2023-01-15')).to.equal(2023);
    });

    it('should handle invalid dates', () => {
      expect(DateModifiers.extractYear('invalid')).to.equal('invalid');
    });
  });

  describe('extractMonth', () => {
    it('should extract month (1-12)', () => {
      const date = new Date('2023-01-15');
      expect(DateModifiers.extractMonth(date)).to.equal(1);

      const date2 = new Date('2023-12-15');
      expect(DateModifiers.extractMonth(date2)).to.equal(12);
    });

    it('should handle invalid dates', () => {
      expect(DateModifiers.extractMonth('invalid')).to.equal('invalid');
    });
  });

  describe('extractDay', () => {
    it('should extract day', () => {
      const date = new Date(2023, 0, 15);
      expect(DateModifiers.extractDay(date)).to.equal(15);
    });

    it('should handle invalid dates', () => {
      expect(DateModifiers.extractDay('invalid')).to.equal('invalid');
    });
  });
});

describe('ArrayModifiers', () => {
  describe('first', () => {
    it('should return first element', () => {
      expect(ArrayModifiers.first([1, 2, 3])).to.equal(1);
      expect(ArrayModifiers.first(['a', 'b', 'c'])).to.equal('a');
    });

    it('should handle empty arrays', () => {
      expect(ArrayModifiers.first([])).to.be.undefined;
    });

    it('should handle non-arrays', () => {
      expect(ArrayModifiers.first('string' as any)).to.be.undefined;
    });
  });

  describe('last', () => {
    it('should return last element', () => {
      expect(ArrayModifiers.last([1, 2, 3])).to.equal(3);
      expect(ArrayModifiers.last(['a', 'b', 'c'])).to.equal('c');
    });

    it('should handle empty arrays', () => {
      expect(ArrayModifiers.last([])).to.be.undefined;
    });
  });

  describe('unique', () => {
    it('should remove duplicates', () => {
      expect(ArrayModifiers.unique([1, 2, 2, 3, 3, 3])).to.deep.equal([1, 2, 3]);
      expect(ArrayModifiers.unique(['a', 'b', 'a', 'c'])).to.deep.equal(['a', 'b', 'c']);
    });

    it('should handle already unique arrays', () => {
      expect(ArrayModifiers.unique([1, 2, 3])).to.deep.equal([1, 2, 3]);
    });

    it('should handle non-arrays', () => {
      expect(ArrayModifiers.unique('string' as any)).to.equal('string');
    });
  });

  describe('size', () => {
    it('should return array length', () => {
      expect(ArrayModifiers.size([1, 2, 3])).to.equal(3);
      expect(ArrayModifiers.size([])).to.equal(0);
      expect(ArrayModifiers.size([1])).to.equal(1);
    });

    it('should handle non-arrays', () => {
      expect(ArrayModifiers.size('string' as any)).to.equal(0);
    });
  });

  describe('reverse', () => {
    it('should reverse arrays', () => {
      expect(ArrayModifiers.reverse([1, 2, 3])).to.deep.equal([3, 2, 1]);
      expect(ArrayModifiers.reverse(['a', 'b', 'c'])).to.deep.equal(['c', 'b', 'a']);
    });

    it('should not mutate original array', () => {
      const arr = [1, 2, 3];
      const reversed = ArrayModifiers.reverse(arr);
      expect(arr).to.deep.equal([1, 2, 3]);
      expect(reversed).to.deep.equal([3, 2, 1]);
    });

    it('should handle non-arrays', () => {
      expect(ArrayModifiers.reverse('string' as any)).to.equal('string');
    });
  });

  describe('join', () => {
    it('should join with default comma', () => {
      expect(ArrayModifiers.join([1, 2, 3])).to.equal('1,2,3');
      expect(ArrayModifiers.join(['a', 'b', 'c'])).to.equal('a,b,c');
    });

    it('should join with custom separator', () => {
      expect(ArrayModifiers.join([1, 2, 3], '-')).to.equal('1-2-3');
      expect(ArrayModifiers.join(['a', 'b', 'c'], ' | ')).to.equal('a | b | c');
    });

    it('should handle empty arrays', () => {
      expect(ArrayModifiers.join([])).to.equal('');
    });

    it('should handle non-arrays', () => {
      expect(ArrayModifiers.join('string' as any)).to.equal('');
    });
  });

  describe('slice', () => {
    it('should slice arrays', () => {
      expect(ArrayModifiers.slice([1, 2, 3, 4, 5], 1, 3)).to.deep.equal([2, 3]);
      expect(ArrayModifiers.slice([1, 2, 3, 4, 5], 2)).to.deep.equal([3, 4, 5]);
    });

    it('should handle negative indices', () => {
      expect(ArrayModifiers.slice([1, 2, 3, 4, 5], -2)).to.deep.equal([4, 5]);
    });

    it('should not mutate original array', () => {
      const arr = [1, 2, 3];
      const sliced = ArrayModifiers.slice(arr, 1);
      expect(arr).to.deep.equal([1, 2, 3]);
      expect(sliced).to.deep.equal([2, 3]);
    });

    it('should handle non-arrays', () => {
      expect(ArrayModifiers.slice('string' as any, 0)).to.equal('string');
    });
  });
});
