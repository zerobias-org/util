# CLAUDE.md - TypeScript/NPM Implementation

This file provides TypeScript/NPM-specific guidance to Claude Code (claude.ai/code) when working with code in this repository.

**For general project information, data model, syntax, and behavioral specifications, see [../CLAUDE.md](../CLAUDE.md).**

## TypeScript Implementation Overview

This is the TypeScript/NPM implementation of lite-filter. The module provides a type-safe API for parsing RFC4515 filters and testing JavaScript objects against filter criteria.

## TypeScript-Specific Architecture

### Type Definitions

**MatchOptions interface:**
```typescript
interface MatchOptions {
  caseSensitive?: boolean;  // default: false
}
```

**Expression interface:**
```typescript
interface Expression {
  matches(obj: any, options?: MatchOptions): boolean;
  as(adapterKey: string): string;
}
```

**Adapter interface:**
```typescript
interface Adapter {
  fromExpression(expr: Expression): string;
}
```

### API Signatures

**Expression Factory Methods - Comparison Operations:**
```typescript
Expression.equals(property: string, value: any): Expression
Expression.notEquals(property: string, value: any): Expression
Expression.greaterThan(property: string, value: any): Expression
Expression.greaterThanOrEqual(property: string, value: any): Expression
Expression.lessThan(property: string, value: any): Expression
Expression.lessThanOrEqual(property: string, value: any): Expression
Expression.approxMatch(property: string, value: string): Expression
Expression.present(property: string): Expression

// String operations
Expression.contains(property: string, value: string): Expression
Expression.startsWith(property: string, value: string): Expression
Expression.endsWith(property: string, value: string): Expression
Expression.matches(property: string, regex: string | RegExp): Expression

// Null/empty checks
Expression.isNull(property: string): Expression
Expression.isEmpty(property: string): Expression

// Array operations
Expression.includes(property: string, value: any): Expression
Expression.includesAny(property: string, values: string): Expression  // comma-separated

// Numeric operations
Expression.between(property: string, min: number, max: number): Expression

// Date operations
Expression.withinDays(property: string, days: number): Expression
Expression.year(property: string, year: number): Expression
```

**Expression Factory Methods - Logical Operations:**
```typescript
Expression.and(...expressions: Expression[]): Expression
Expression.or(...expressions: Expression[]): Expression
Expression.not(expression: Expression): Expression
```

**Parser:**
```typescript
Expression.parse(filter: string): Expression
```

**Adapter Management:**
```typescript
Expression.addAdapter(key: string, description: string, adapter: Adapter): void
Expression.adapters(): { [key: string]: string }
```

### Usage Examples

**Building filters programmatically:**
```typescript
const filter = Expression.and(
  Expression.or(
    Expression.equals('zip', '90210'),
    Expression.startsWith('name', 'Rob')
  ),
  Expression.equals('status', 'Active')
);

// Test an object
filter.matches(someObject);
```

**Stream filtering:**
```typescript
const activeUsers = Expression.and(
  Expression.equals('status', 'active'),
  Expression.greaterThanOrEqual('age', 18)
);

const results = users
  .filter(user => activeUsers.matches(user))
  .map(user => user.email);

// With case-sensitive option
const caseSensitiveFilter = Expression.contains('name', 'Rob');
const results = users.filter(u =>
  caseSensitiveFilter.matches(u, { caseSensitive: true })
);
```

**Adapter usage:**
```typescript
let expr = Expression.parse('(&(status=active)(created_at>=2024-01-01))');
let sql = expr.as("SQL");
// Returns: "status = 'active' AND created_at >= '2024-01-01'"
```

## Development Commands

Since this is a new TypeScript NPM project, standard commands will be:

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run specific test file
npm test -- <test-file-name>

# Lint
npm run lint

# Type check
npx tsc --noEmit
```

## TypeScript Implementation Notes

### Dependencies

**Required:**
- `fast-fuzzy` - For approximate matching (`~=` operator)

### File Organization

- `src/Expression.ts` - Core Expression interface, factory methods, and parser
- `src/Clause.ts` - Clause implementation (internal, used by factory methods)
- `src/Grouping.ts` - Grouping implementation (internal, used by logical operators)
- `src/ComparisonOperator.ts` - Operator definitions and parsing (internal)
- `src/adapters/` - Directory for adapter implementations
- `tests/` or `__tests__/` - Test files

**Public API Surface:**
- Only `Expression` is exported as the main public interface
- All factory methods (comparison and logical) are static methods on `Expression`
- Clause, Grouping, and ComparisonOperator are internal implementation details

### TypeScript-Specific Implementation Details

**Property Access:**
Use nested property access for dot notation:
```typescript
function getNestedProperty(obj: any, path: string): any {
  return path.split('.').reduce((current, prop) => current?.[prop], obj);
}
```

**Type Coercion:**
Implement automatic coercion for string-number and string-boolean comparisons:
```typescript
function coerceValue(value: any, targetValue: any): any {
  if (typeof targetValue === 'number' && typeof value === 'string') {
    const num = Number(value);
    return isNaN(num) ? value : num;
  }
  if (typeof targetValue === 'boolean' && typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  return value;
}
```

**Date Parsing:**
Use ISO 8601 parsing:
```typescript
function parseDate(value: any): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }
  return null;
}
```

**Fuzzy Matching:**
Use the fast-fuzzy library for `~=` operator:
```typescript
import { search } from 'fast-fuzzy';

function approxMatch(value: string, pattern: string): boolean {
  const results = search(pattern, [value]);
  return results.length > 0;
}
```
