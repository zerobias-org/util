/**
 * Tests for ValueConverter utility
 */
import { expect } from 'chai';
import { ValueConverter } from '../src';

describe('ValueConverter', () => {
  describe('toBoolean', () => {
    it('should convert boolean values', () => {
      expect(ValueConverter.toBoolean(true)).to.equal(true);
      expect(ValueConverter.toBoolean(false)).to.equal(false);
    });

    it('should convert string values', () => {
      expect(ValueConverter.toBoolean('true')).to.equal(true);
      expect(ValueConverter.toBoolean('TRUE')).to.equal(true);
      expect(ValueConverter.toBoolean('false')).to.equal(false);
      expect(ValueConverter.toBoolean('FALSE')).to.equal(false);
      expect(ValueConverter.toBoolean('yes')).to.equal(false);
    });

    it('should convert number values', () => {
      expect(ValueConverter.toBoolean(1)).to.equal(true);
      expect(ValueConverter.toBoolean(0)).to.equal(false);
      expect(ValueConverter.toBoolean(-1)).to.equal(true);
    });

    it('should handle undefined', () => {
      expect(ValueConverter.toBoolean(undefined)).to.equal(undefined);
      expect(ValueConverter.toBoolean(undefined)).to.equal(undefined);
    });

    it('should convert truthy/falsy values', () => {
      expect(ValueConverter.toBoolean({})).to.equal(true);
      expect(ValueConverter.toBoolean([])).to.equal(true);
      expect(ValueConverter.toBoolean('')).to.equal(false);
    });
  });

  describe('toNumber', () => {
    it('should convert number values', () => {
      expect(ValueConverter.toNumber(123)).to.equal(123);
      expect(ValueConverter.toNumber(0)).to.equal(0);
      expect(ValueConverter.toNumber(-42)).to.equal(-42);
      expect(ValueConverter.toNumber(3.14)).to.equal(3.14);
    });

    it('should convert string values', () => {
      expect(ValueConverter.toNumber('123')).to.equal(123);
      expect(ValueConverter.toNumber('3.14')).to.equal(3.14);
      expect(ValueConverter.toNumber('-42')).to.equal(-42);
    });

    it('should handle formatted strings', () => {
      expect(ValueConverter.toNumber('$1,234.56')).to.equal(1234.56);
      expect(ValueConverter.toNumber('$1,000')).to.equal(1000);
      expect(ValueConverter.toNumber('1,234,567.89')).to.equal(1234567.89);
    });

    it('should handle invalid conversions', () => {
      expect(ValueConverter.toNumber('abc')).to.equal(undefined);
      expect(ValueConverter.toNumber('12abc')).to.equal(12);
      expect(ValueConverter.toNumber(NaN)).to.equal(undefined);
    });

    it('should handle undefined', () => {
      expect(ValueConverter.toNumber(undefined)).to.equal(undefined);
      expect(ValueConverter.toNumber(undefined)).to.equal(undefined);
    });
  });

  describe('toDate', () => {
    it('should preserve Date objects', () => {
      const date = new Date('2023-01-15');
      const result = ValueConverter.toDate(date);
      expect(result).to.be.instanceOf(Date);
      expect(result?.getTime()).to.equal(date.getTime());
    });

    it('should convert ISO strings', () => {
      const result = ValueConverter.toDate('2023-01-15T10:30:00Z');
      expect(result).to.be.instanceOf(Date);
      expect(result?.toISOString()).to.equal('2023-01-15T10:30:00.000Z');
    });

    it('should convert date strings', () => {
      const result = ValueConverter.toDate('2023-01-15T12:00:00Z');
      expect(result).to.be.instanceOf(Date);
      expect(result?.getUTCFullYear()).to.equal(2023);
      expect(result?.getUTCMonth()).to.equal(0); // January
      expect(result?.getUTCDate()).to.equal(15);
    });

    it('should convert timestamps', () => {
      const timestamp = 1673740800000; // 2023-01-15T00:00:00.000Z
      const result = ValueConverter.toDate(timestamp);
      expect(result).to.be.instanceOf(Date);
      expect(result?.getTime()).to.equal(timestamp);
    });

    it('should handle invalid dates', () => {
      expect(ValueConverter.toDate('invalid')).to.equal(undefined);
      expect(ValueConverter.toDate('not-a-date')).to.equal(undefined);
      expect(ValueConverter.toDate(new Date('invalid'))).to.equal(undefined);
    });

    it('should handle undefined', () => {
      expect(ValueConverter.toDate(undefined)).to.equal(undefined);
      expect(ValueConverter.toDate(undefined)).to.equal(undefined);
    });
  });

  describe('toDateString', () => {
    it('should convert dates to ISO strings', () => {
      const date = new Date('2023-01-15T10:30:00Z');
      expect(ValueConverter.toDateString(date)).to.equal('2023-01-15T10:30:00.000Z');
    });

    it('should convert string dates', () => {
      const result = ValueConverter.toDateString('2023-01-15');
      expect(result).to.be.a('string');
      expect(result).to.include('2023-01-15');
    });

    it('should handle invalid dates', () => {
      expect(ValueConverter.toDateString('invalid')).to.equal(undefined);
    });

    it('should handle undefined', () => {
      expect(ValueConverter.toDateString(undefined)).to.equal(undefined);
      expect(ValueConverter.toDateString(undefined)).to.equal(undefined);
    });
  });

  describe('toString', () => {
    it('should convert primitive values', () => {
      expect(ValueConverter.toString(123)).to.equal('123');
      expect(ValueConverter.toString(true)).to.equal('true');
      expect(ValueConverter.toString(false)).to.equal('false');
    });

    it('should preserve strings', () => {
      expect(ValueConverter.toString('hello')).to.equal('hello');
      expect(ValueConverter.toString('')).to.equal('');
    });

    it('should convert objects', () => {
      expect(ValueConverter.toString({})).to.equal('[object Object]');
      expect(ValueConverter.toString([])).to.equal('');
    });

    it('should handle undefined', () => {
      expect(ValueConverter.toString(undefined)).to.equal('');
      expect(ValueConverter.toString(undefined)).to.equal('');
    });
  });

  describe('convert', () => {
    it('should convert to boolean', () => {
      expect(ValueConverter.convert('true', 'boolean')).to.equal(true);
      expect(ValueConverter.convert(1, 'boolean')).to.equal(true);
    });

    it('should convert to number', () => {
      expect(ValueConverter.convert('123', 'number')).to.equal(123);
      expect(ValueConverter.convert('$1,234.56', 'number')).to.equal(1234.56);
    });

    it('should convert to date', () => {
      const result = ValueConverter.convert('2023-01-15', 'date');
      expect(result).to.be.instanceOf(Date);
    });

    it('should convert to string', () => {
      expect(ValueConverter.convert(123, 'string')).to.equal('123');
      expect(ValueConverter.convert(true, 'string')).to.equal('true');
    });

    it('should convert to array', () => {
      expect(ValueConverter.convert([1, 2, 3], 'array')).to.deep.equal([1, 2, 3]);
      expect(ValueConverter.convert('hello', 'array')).to.deep.equal(['hello']);
      expect(ValueConverter.convert(undefined, 'array')).to.deep.equal([]);
    });

    it('should convert to object', () => {
      const obj = { a: 1 };
      expect(ValueConverter.convert(obj, 'object')).to.equal(obj);
      expect(ValueConverter.convert('string', 'object')).to.equal(undefined);
    });
  });
});
