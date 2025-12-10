# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**@zerobias-org/logger** is a hierarchical logging system built on Winston that provides centralized configuration with per-logger customization. The package exports both the new `LoggerEngine` API (v2.0+) and a deprecated `Logger` class for backward compatibility.

**NOTE:** For best results when working on this package from the meta-repo, run Claude Code from the zerobias meta-repo root to ensure access to all platform context and cross-module documentation.

## Build Commands

```bash
# Clean build artifacts
npm run clean

# Compile TypeScript
npm run compile

# Full build (clean + compile)
npm run build

# Run tests
npm run test

# Run linter
npm run lint

# Fix linting issues
npm run lint:fix
```

**Running individual tests:**
```bash
# Run single test file
npx mocha --inline-diffs --reporter=list test/unit/LoggerEngine.test.ts

# Run tests with grep filter
npx mocha --inline-diffs --reporter=list --grep "should create child logger" test/unit/**/*.ts
```

**Important:** This package uses ES modules (`"type": "module"` in package.json). All imports must use `.js` extensions even for TypeScript files.

## Architecture

### Hierarchical Logger Structure

The core architecture is a **tree of loggers** where each `LoggerEngine` can have child loggers:

```
LoggerEngine (root - singleton)
├── LoggerEngine (api)
│   ├── LoggerEngine (auth)
│   └── LoggerEngine (graphql)
├── LoggerEngine (database)
└── LoggerEngine (worker)
```

**Key architectural concepts:**

1. **Singleton Root**: `LoggerEngine.root()` returns the single root logger instance
2. **Child Logger Caching**: `parent.get(name)` caches child loggers to prevent repeated allocations
3. **Level Inheritance**: Child loggers inherit log level from parent unless explicitly overridden
4. **Transport Chaining**: Log events automatically propagate up the tree via `ParentTransport`
5. **Lifecycle Management**: `destroy()` method enables cleanup of dynamic loggers

### Core Components

**LoggerEngine** (`src/LoggerEngine.ts`)
- Main logger implementation wrapping Winston
- Manages hierarchy (parent/children relationships)
- Implements all log methods: `crit`, `error`, `warn`, `info`, `verbose`, `debug`, `trace`
- Handles level filtering and event construction

**LogLevel** (`src/LogLevel.ts`)
- Enum defining severity levels (CRIT=0 through TRACE=6)
- `LOG_LEVEL_METADATA` provides display information (symbols, colors)

**ParentTransport** (`src/ParentTransport.ts`)
- Winston transport that forwards log events to parent logger
- Automatically added to all non-root loggers
- Enables hierarchical event propagation

**LoggerTransport** (`src/transports/LoggerTransport.ts`)
- Abstract base class for transports with formatting logic
- Handles timestamp formatting, template parsing, line wrapping
- Configurable via `TransportOptions`

**ConsoleTransport** (`src/transports/ConsoleTransport.ts`)
- Default transport using `console` methods
- No color support (maximum portability)

**CLITransport** (`src/transports/CLITransport.ts`)
- ANSI color support for terminals
- Static `install()` method to replace ConsoleTransport
- Recommended for CLI tools

### Winston Integration

This package extends Winston rather than reimplementing logging:

- Each `LoggerEngine` wraps a `winston.Logger` instance
- Custom log levels defined to match `LogLevel` enum
- Winston's transport ecosystem fully compatible
- Level filtering happens at LoggerEngine level before Winston

**Why this matters for development:**
- You can add any Winston-compatible transport
- Winston's async logging provides performance
- Formatting/output separation follows Winston patterns

## Implementation Patterns

### Log Method Implementation

All log methods follow this pattern (see `LoggerEngine.ts:229-281`):

```typescript
private log(
  level: LogLevel,
  levelName: string,
  message: string,
  errorOrMetadata?: Error | object,
  metadata?: object
): void {
  // 1. Check if logger destroyed
  if (this._destroyed) throw new Error(...)

  // 2. Filter by effective level (inheritance walk)
  const effectiveLevel = this.getEffectiveLevel();
  if (level > effectiveLevel) return;

  // 3. Detect Error vs metadata parameter
  let error: Error | undefined;
  let meta: object | undefined;
  if (errorOrMetadata instanceof Error) {
    error = errorOrMetadata;
    meta = metadata;
  } else {
    meta = errorOrMetadata;
  }

  // 4. Build structured log event
  const logEvent = {
    level: levelName,
    message,
    name: this._name,
    path: this.path,
    ...(error && { error: { name, message, stack } }),
    ...(meta && meta)
  };

  // 5. Emit to Winston
  this._logger.log(logEvent);
}
```

**When modifying log methods:**
- Preserve backward compatibility (both signatures must work)
- Maintain level filtering before Winston emission
- Keep structured event format consistent
- Test both Error and metadata parameter types

### Level Inheritance

Level resolution walks up the tree until finding an explicit level (see `LoggerEngine.ts:129-140`):

```typescript
getEffectiveLevel(): LogLevel {
  if (this._level !== undefined) {
    return this._level;
  }
  if (this._parent) {
    return this._parent.getEffectiveLevel();
  }
  return LogLevel.INFO; // Root default
}
```

**Testing level inheritance:**
- Create multi-level hierarchy (root → child → grandchild)
- Set level only at root, verify child/grandchild inherit
- Set level on child, verify grandchild inherits from child
- Set level on grandchild, verify it overrides parent
- Test `setLevel(null)` clears explicit level and restores inheritance

### Ephemeral Loggers (Automatic Garbage Collection)

**New in v2.1.0**: Loggers can be created with `ephemeral: true` to enable automatic garbage collection without calling `destroy()`.

**How it works** (see `LoggerEngine.ts:85-88`):
```typescript
// Ephemeral loggers are NOT cached in parent's _children map
if (options?.ephemeral) {
  return new LoggerEngine(childName, this, options);
}
```

**Use case - per-request logging:**
```typescript
app.use((req, res, next) => {
  // Create ephemeral logger - no cleanup needed!
  req.logger = apiLogger.get(`request-${req.id}`, { ephemeral: true });
  next();
  // When request ends, logger is garbage collected automatically
});
```

**Key behaviors:**
- Ephemeral loggers can have children (entire chain gets GC'd)
- Not stored in parent's `_children` Map
- Calling `destroy()` on ephemeral logger still works (closes Winston logger)
- Each call to `get(name, { ephemeral: true })` creates a NEW instance

**When to use ephemeral:**
- ✅ High-volume dynamic loggers (thousands per second)
- ✅ Per-request, per-session, per-transaction loggers
- ✅ Short-lived scoped loggers
- ❌ Long-lived module loggers (use cached loggers instead)

### Lifecycle and Memory Management

The `destroy()` method prevents memory leaks from cached loggers (see `LoggerEngine.ts:98-128`):

```typescript
destroy(): void {
  // Idempotent
  if (this._destroyed) return;

  // Prevent root destruction
  if (!this._parent) throw new Error('Cannot destroy root logger');

  this._destroyed = true;

  // 1. Recursively destroy children
  for (const child of this._children.values()) {
    child.destroy();
  }
  this._children.clear();

  // 2. Remove from parent's children map
  this._parent._children.delete(this._name);

  // 3. Close Winston logger
  this._logger.close();

  // 4. Clear parent reference
  this._parent = undefined;
}
```

**When working with lifecycle:**
- Child logger caching means `parent.get(name)` returns same instance
- Dynamic loggers (per-request, per-session) must be destroyed
- Destroyed logger throws on all operations
- After destroy, `parent.get(name)` creates NEW instance

### Transport Architecture

Transports receive structured log events and format them for output:

**LoggerTransport base class:**
- Implements `winston.Transport` interface
- Provides template-based formatting
- Handles timestamp formatting with timezone support
- Supports line wrapping and multi-line output
- **Runtime reconfiguration** via `apply(options)` method
- **Type registration** via `public readonly transportType` property
- **Color hook** - `applyColor(text, color)` method for subclasses to override

**Adding new transports:**
1. Extend `LoggerTransport` (for formatting support) or `winston.Transport` (for full control)
2. Pass `TransportType` to super() constructor
3. Implement `log(info: any, callback: Function)` method
4. Parse template placeholders or implement custom formatting
5. Optionally override `formatLogLevel()` to add color/styling
6. Call callback when done (Winston requirement)

**Example:**
```typescript
import { LoggerTransport, TransportType } from '@zerobias-org/logger';

class FileTransport extends LoggerTransport {
  constructor(filePath: string, options?: TransportOptions) {
    super(TransportType.FILE, options);
    this.filePath = filePath;
  }

  log(info: any, callback: () => void): void {
    const formatted = this.formatLog(info);
    // Write to file...
    callback();
  }
}
```

**Adding color to transports:**
```typescript
class ColoredTransport extends LoggerTransport {
  // Override formatLogLevel to add color only to level indicator
  protected formatLogLevel(level: string): string {
    const uncoloredLevel = super.formatLogLevel(level);
    if (!uncoloredLevel) return '';

    // Add your color logic here
    return this.applyColor(uncoloredLevel, 'red');
  }

  // Override applyColor to implement your coloring
  protected applyColor(text: string, color: string): string {
    // Add ANSI codes, HTML tags, etc.
    return text; // Base class returns uncolored
  }
}
```

### Transport Type Registry

**New in v2.1.0**: Transports are registered with well-known types for programmatic access.

**TransportType enum** (`src/TransportType.ts`):
```typescript
enum TransportType {
  CLI = 'cli',        // CLITransport with ANSI colors
  CONSOLE = 'console', // ConsoleTransport using console.*
  FILE = 'file',      // File-based transport (future)
  MEMORY = 'memory',  // In-memory transport (typically testing)
  API = 'api'         // HTTP/API remote transport (future)
}
```

**Key features:**
- Each LoggerTransport has `public readonly transportType: TransportType`
- Get transports by type without keeping references
- Remove all transports of a type in one call
- Check if transport type exists
- Type-safe typed returns

**LoggerEngine methods:**

```typescript
// Get first transport of type (typed return)
getTransport<T extends LoggerTransport>(transportType: TransportType): T | undefined

// Get all transports of type
getTransports<T extends LoggerTransport>(transportType: TransportType): T[]

// Check if type exists
hasTransport(transportType: TransportType): boolean

// Remove by instance (original)
removeTransport(transport: Transport): void

// Remove all by type (new overload)
removeTransport(transportType: TransportType): void
```

**Use cases:**

**1. Swap transports without references:**
```typescript
// Remove console, add CLI
root.removeTransport(TransportType.CONSOLE);
root.addTransport(new CLITransport());
```

**2. Reconfigure existing transport:**
```typescript
const transport = root.getTransport<CLITransport>(TransportType.CLI);
if (transport) {
  transport.apply({ exceptions: 'FULL' });
}
```

**3. Conditional transport management:**
```typescript
if (process.stdout.isTTY) {
  root.removeTransport(TransportType.CONSOLE);
  root.addTransport(new CLITransport());
}
```

**4. Check before adding:**
```typescript
if (!root.hasTransport(TransportType.FILE)) {
  root.addTransport(new FileTransport('/var/log/app.log'));
}
```

### Runtime Transport Reconfiguration

**New in v2.1.0**: Transports can be reconfigured at runtime using the `apply()` method.

**How it works** (see `LoggerTransport.ts:48-134`):
```typescript
apply(options: Partial<TransportOptions>): void {
  // Update configuration fields
  // Recompute downstream state (timezoneFormatter, placeholderRegexes, etc.)
  // Reset affected caches (lastDateMarker if timezone changed)
}
```

**Use cases:**

**1. Change timezone dynamically:**
```typescript
const transport = new CLITransport({ timezone: 'GMT' });
root.addTransport(transport);

// Later: switch to local timezone
transport.apply({ timezone: 'America/New_York' });
```

**2. Toggle verbose exception logging:**
```typescript
const transport = new ConsoleTransport({ exceptions: 'BASIC' });

// In development, show full stack traces
if (process.env.NODE_ENV === 'development') {
  transport.apply({ exceptions: 'FULL' });
}
```

**3. Change formatting template:**
```typescript
const transport = new CLITransport();

// Switch to compact format for production
transport.apply({
  template: '%{level} %{message}',
  timestamp: 'NONE'
});
```

**4. Bulk reconfiguration:**
```typescript
transport.apply({
  timestamp: 'FULL',
  logLevel: 'NAME',
  loggerName: 'PATH',
  exceptions: 'FULL',
  timezone: 'UTC'
});
```

**Key behaviors:**
- Partial updates supported - only specified options change
- Downstream state automatically recomputed (formatters, regexes)
- Caches reset when needed (date marker on timezone change)
- No performance penalty if option unchanged
- Thread-safe (single-threaded runtime)

## Testing Practices

### Test Structure

Tests use Mocha + Chai and are organized by functionality:

- `test/unit/LoggerEngine.test.ts` - Hierarchy, lifecycle, level inheritance
- `test/unit/LoggingMethods.test.ts` - Log method signatures, error handling
- `test/unit/Transports.test.ts` - Transport formatting, configuration

### Memory Leak Testing Pattern

When testing dynamic logger creation, always verify cleanup:

```typescript
it('should clean up logger on destroy', () => {
  const root = LoggerEngine.root();
  const parent = root.get('parent');
  const child = parent.get('child');

  expect(parent.children.has('child')).to.be.true;
  expect(child.parent).to.equal(parent);

  child.destroy();

  expect(parent.children.has('child')).to.be.false;
  expect(child.parent).to.be.undefined;
});
```

**Testing ephemeral loggers:**
```typescript
it('should not cache ephemeral loggers', () => {
  const root = LoggerEngine.root();
  const parent = root.get('parent');

  const ephemeral1 = parent.get('ephemeral', { ephemeral: true });
  const ephemeral2 = parent.get('ephemeral', { ephemeral: true });

  // Each call creates new instance
  expect(ephemeral1).to.not.equal(ephemeral2);

  // Not cached in parent
  expect(parent.children.has('ephemeral')).to.be.false;

  // Should have ephemeral flag
  expect(ephemeral1.ephemeral).to.be.true;
  expect(ephemeral2.ephemeral).to.be.true;
});
```

### Transport Reconfiguration Testing Pattern

Test the `apply()` method for runtime reconfiguration:

```typescript
it('should reconfigure transport at runtime', () => {
  const root = LoggerEngine.root();
  root.transports.forEach(t => root.removeTransport(t));

  const transport = new ConsoleTransport({ logLevel: 'SYMBOL' });
  root.addTransport(transport);

  // Log with original configuration
  root.info('Before reconfiguration');

  // Reconfigure
  transport.apply({ logLevel: 'NAME', exceptions: 'FULL' });

  // Log with new configuration
  root.error('After reconfiguration', new Error('Test'));
});
```

**Testing partial updates:**
```typescript
it('should preserve unmodified options', () => {
  const transport = new CLITransport({
    timestamp: 'TIME',
    timezone: 'GMT',
    logLevel: 'SYMBOL'
  });

  // Only change timezone
  transport.apply({ timezone: 'America/New_York' });

  // timestamp and logLevel should remain unchanged
});
```

### Transport Testing Pattern

Test transports by capturing their output:

```typescript
let capturedLogs: any[] = [];

beforeEach(() => {
  capturedLogs = [];
  const root = LoggerEngine.root();

  // Remove default transports
  root.transports.forEach(t => root.removeTransport(t));

  // Add memory transport
  const memoryTransport = new winston.transports.Stream({
    stream: {
      write: (message: string) => {
        capturedLogs.push(JSON.parse(message));
      }
    }
  });

  root.addTransport(memoryTransport);
});
```

## Common Development Tasks

### Adding a New Log Level

If you need to add a log level (unlikely - current set covers standard use cases):

1. **Update LogLevel enum** (`src/LogLevel.ts`) - Add level with numeric value
2. **Update LOG_LEVEL_METADATA** - Add display metadata (symbol, color)
3. **Update Winston levels** (`src/LoggerEngine.ts:45-53`) - Add to customLevels object
4. **Add log method** (`src/LoggerEngine.ts`) - Implement method like `crit()`, `error()`, etc.
5. **Update types** (`src/types.ts`) - If needed for LogEvent interface
6. **Add tests** - Test new method with all parameter combinations

### Adding a New Transport Type

When creating a new transport (e.g., FileTransport, APITransport):

1. **Add to TransportType enum** (`src/TransportType.ts`) if it's a common type
2. **Create transport class** - Extend `LoggerTransport`
3. **Pass type to super()** - `super(TransportType.FILE, options)`
4. **Implement log() method** - Format and output the log event
5. **Add tests** - Create test file following `TransportType.test.ts` pattern
6. **Export from index** - Add to `src/index.ts` exports

### Modifying Transport Formatting

When changing how transports format output:

1. **LoggerTransport base class** (`src/transports/LoggerTransport.ts`) - Shared formatting logic
2. **Template placeholders** - Available: `%{timestamp}`, `%{level}`, `%{name}`, `%{message}`, `%{metadata}`, `%{exception}`
3. **Test all transports** - ConsoleTransport and CLITransport both use base class
4. **Verify color handling** - CLITransport uses chalk, ConsoleTransport does not
5. **Update `apply()` method** - If adding new options, update the apply() method to handle them
   - Add field to class (use `!` for definite assignment if initialized in apply)
   - Update apply() to process the new option
   - Recompute any downstream state if needed
   - Add tests in `TransportReconfiguration.test.ts`

### Changing Event Structure

If modifying the log event structure (rarely needed):

1. **LoggerEngine.log()** (`src/LoggerEngine.ts:258-280`) - Build logEvent object
2. **LogEvent type** (`src/types.ts`) - Update interface
3. **ParentTransport** (`src/ParentTransport.ts`) - May need to enrich events
4. **All transports** - Update formatting to handle new fields
5. **README.md** - Document new fields in LogEvent interface section
6. **Tests** - Verify new fields appear in output

## Backward Compatibility Notes

The package maintains backward compatibility with v1.x via the deprecated `Logger` class:

- `Logger` class (`src/Logger.ts`) provides old requestId-based API
- Both APIs exported from `src/index.ts`
- New code should use `LoggerEngine`, old code continues working
- `Logger` will be removed in v3.0.0

**When making changes:**
- Do not break existing `LoggerEngine` API
- Method signatures are part of public API (error parameter support, etc.)
- Transport options are part of public API
- LogLevel enum values are part of public API

## Related Documentation

**Meta-Repo Context:**
- **[CLAUDE.md](../../../CLAUDE.md)** - Platform overview, component relationships (from meta-repo root)
- **[LocalDevelopment.md](../../../LocalDevelopment.md)** - npm link workflows for local development (from meta-repo root)

**Related Components:**
- This logger is used throughout the platform (hydra, hub, platform/api, etc.)
- Changes to public API affect all consuming services
- Test changes locally with `npm link` before publishing

## Publishing

Publishing is handled via GitHub Actions on version tag:

```bash
# Update version
npm version patch  # or minor, major

# Publish (triggers CI)
git push && git push --tags
```

**Registry:** GitHub Packages (`@zerobias-org` scope)

**Important:** Always test with consuming packages via `npm link` before publishing, as breaking changes affect entire platform.
