# ZeroBias Logger

A hierarchical logging system built on Winston that provides centralized configuration with flexible, per-logger customization.

## Overview

This package implements a tree-structured logging system where each `LoggerEngine` can have child loggers. The hierarchy enables:

- **Centralized management**: Configure log levels and transports at the root, automatically inherited by children
- **Selective overrides**: Child loggers can override inherited settings for specific modules or subsystems
- **Contextual grouping**: Create child loggers to tag and group related log events (e.g., per-request, per-subsystem)
- **Transport chaining**: Log messages automatically propagate up the tree, reaching all ancestor transports

## Key Concepts

### Hierarchical Structure

Applications use a singleton root logger obtained via `LoggerEngine.root()`. Child loggers are created using `LoggerEngine.get(childName, options?)` to form a tree structure that mirrors your application's logical organization.

**Example hierarchy:**
```
root
├── api
│   ├── auth
│   └── graphql
├── database
│   ├── postgres
│   └── cache
└── worker
    └── queue
```

Each logger in the tree can log independently, but messages flow up through ancestor transports for unified output.

### Core Features

1. **Dynamic Runtime Configuration**
   - Change log levels on any logger without restart
   - Add or remove transports dynamically
   - Reconfigure formatting options at runtime

2. **Transport Flexibility**
   - Separate log generation from log output (Winston transports)
   - Optimize output per destination: TTY (ANSI colors), files, structured databases (CloudWatch, Sumo Logic)
   - Transport chaining: child logger messages automatically reach parent transports
   - Add child-specific transports for specialized handling (e.g., error-only file)

3. **Structured Logging**
   - All log events carry structured metadata (logger name, path, timestamp, level, etc.)
   - Transports receive JSON events and format as needed
   - Preserve context across the entire call chain

### Logger Identity

Each `LoggerEngine` has two identifiers:

- **name**: Immutable string, unique within its parent (e.g., `"database"`, `"auth"`)
- **path**: Globally unique string formed by concatenating ancestor names with separators (e.g., `"root:api:auth"`)

The path serves as the underlying Winston logger name and appears in formatted output for tracing.

**Parent-child relationships:**
- Each logger maintains a reference to its parent (except root)
- Each parent maintains references to all its children
- Accessors enable tree traversal for inspection and management

### Log Levels

Each `LoggerEngine` has an optional log level. If undefined, it inherits from its parent (recursively up to root).

The `LogLevel` enum defines seven severity levels with metadata for display:

| Level     | Numeric | Symbol | Color       | Usage                                      |
|-----------|---------|--------|-------------|--------------------------------------------|
| `crit`    | 0       | `!!!`  | red         | Critical failures requiring immediate action |
| `error`   | 1       | `!!`   | bold red    | Errors that don't stop execution           |
| `warn`    | 2       | `!`    | yellow      | Warning conditions                         |
| `info`    | 3       | ` `    | green       | Informational messages (default)           |
| `verbose` | 4       | `*`    | blue        | Detailed informational messages            |
| `debug`   | 5       | `**`   | blue        | Debug-level messages                       |
| `trace`   | 6       | `***`  | magenta     | Very detailed tracing                      |

**Level inheritance:**
- A logger with `level: undefined` inherits from its parent
- Root logger defaults to `info` if not explicitly set
- Changing a parent's level affects all children that inherit

**Log filtering:**
- Messages are only emitted if their level is ≤ the effective logger level (lower numeric value = higher severity)
- Example: Logger at `warn` (2) emits `crit`, `error`, `warn` but drops `info`, `verbose`, `debug`, `trace`

### Transport Architecture

**ParentTransport (automatic chaining):**
- Each child logger automatically includes a `ParentTransport`
- Forwards accepted log messages to the parent's Winston logger transports
- Continues recursively up the tree until reaching root
- Enriches the log event with logger metadata (`name`, `path`) for context

**Practical implications:**
- Configure transports once at root; all loggers benefit
- Add child-specific transports for specialized routing (e.g., database logger → SQL file)
- Each transport in the chain receives the complete structured event with full ancestry context

**Metadata propagation:**
All log events carry:
- `name`: The logger that created the message
- `path`: The full hierarchical path
- `level`: The log level
- `message`: The log message
- `timestamp`: Event creation time
- `error`: Optional error object (name, message, stack) if Error parameter provided
- Additional custom fields from metadata parameter

## Usage

### Basic Setup

**1. Get the root logger (singleton):**
```typescript
import { LoggerEngine } from '@zerobias-org/logger';

const rootLogger = LoggerEngine.root();
rootLogger.info('Application started');
```

**2. Create child loggers:**
```typescript
const apiLogger = rootLogger.get('api');
const dbLogger = rootLogger.get('database');

apiLogger.info('API server listening on port 3000');
dbLogger.debug('Connection pool initialized');
```

**3. Create nested hierarchies:**
```typescript
const authLogger = apiLogger.get('auth');
authLogger.warn('Failed login attempt', { username: 'admin', ip: '192.168.1.1' });
// Output includes path: "root:api:auth"
```

**4. Log exceptions/errors:**
```typescript
try {
  await connectToDatabase();
} catch (error) {
  // Method 1: Error as second parameter
  dbLogger.error('Database connection failed', error);

  // Method 2: Error + metadata
  dbLogger.error('Database connection failed', error, {
    host: 'db.example.com',
    port: 5432
  });

  // Method 3: Just metadata (backward compatible)
  dbLogger.error('Database connection failed', {
    host: 'db.example.com',
    error: error.message
  });
}
```

### API Methods

**LoggerEngine instance methods:**

```typescript
// Logging methods - each supports multiple call signatures:

// 1. Message only
logger.info(message: string): void

// 2. Message + metadata
logger.info(message: string, metadata: object): void

// 3. Message + error
logger.info(message: string, error: Error): void

// 4. Message + error + metadata
logger.info(message: string, error: Error, metadata: object): void

// Available methods (all support signatures above):
logger.crit(...)
logger.critical(...)      // Alias for crit()
logger.error(...)
logger.warn(...)
logger.warning(...)       // Alias for warn()
logger.info(...)
logger.verbose(...)
logger.debug(...)
logger.trace(...)

// Hierarchy management
logger.get(childName: string, options?: LoggerOptions): LoggerEngine
logger.parent: LoggerEngine | undefined
logger.children: Map<string, LoggerEngine>

// Configuration
logger.level: LogLevel | undefined  // undefined = inherit
logger.setLevel(level: LogLevel): void
logger.getEffectiveLevel(): LogLevel  // Resolved level (walks up tree)

// Transport management
logger.transports: winston.Transport[]
logger.addTransport(transport: winston.Transport): void
logger.removeTransport(transport: winston.Transport): void
```

**Static methods:**

```typescript
LoggerEngine.root(): LoggerEngine  // Singleton root logger
```

### Default Configuration

The root logger initializes with:
- **Log level**: `info`
- **Transport**: Single `ConsoleTransport` for maximum portability
- **Format**: Structured JSON events formatted for console output

### Transports

**ConsoleTransport (default):**
- Outputs to `console` object methods (`console.info()`, `console.error()`, etc.)
- Log levels map directly to console methods
- Works in Node.js and browser environments
- No color support

**CLITransport (recommended for terminals):**
- ANSI color support for color-aware terminals
- Replaces `ConsoleTransport` when installed
- Enhanced formatting for CLI usage

```typescript
import { CLITransport } from '@zerobias-org/logger';

CLITransport.install();  // Removes ConsoleTransport, adds CLITransport
```

### Transport Formatting Options

Both `ConsoleTransport` and `CLITransport` extend the base `LoggerTransport` class, which provides extensive formatting configuration:

#### Configuration Properties

| Option | Values | Default | Description |
|--------|--------|---------|-------------|
| `timestamp` | `NONE`, `FULL`, `TIME`, `CUSTOM` | `TIME` | Timestamp display mode |
| `timezone` | `string` (IANA timezone) | `"GMT"` | Timezone for timestamps |
| `logLevel` | `NONE`, `SYMBOL`, `NAME` | `SYMBOL` | How to display log level |
| `loggerName` | `NONE`, `NAME`, `PATH` | `NAME` | Logger identification display |
| `exceptions` | `BASIC`, `FULL` | `BASIC` | Exception detail level |
| `maxLineLength` | `number` | `100` | Max characters before wrapping |
| `template` | `string` | See below | Output format template |

#### Timestamp Modes

- **NONE**: No timestamp
- **FULL**: Full ISO date-time (e.g., `2025-12-08T14:23:45.123Z`)
- **TIME**: Time only (e.g., `14:23:45`), with hourly date markers for long-running processes
- **CUSTOM**: Provide custom format function

**TIME mode with date markers:**
For long-running processes, `TIME` mode emits a full date marker at the top of each hour:
```
--- 2025-12-08 ---
14:23:45 [api] info Server started
15:00:00 --- 2025-12-08 ---
15:01:32 [api] debug Request processed
```

#### Log Level Display

- **NONE**: No level indicator
- **SYMBOL**: Use symbol from LogLevel enum (`!!!`, `!!`, `!`, ` `, `*`, `**`, `***`)
- **NAME**: Use level name (`crit`, `error`, `warn`, `info`, `verbose`, `debug`, `trace`)

#### Logger Name Display

- **NONE**: No logger identification
- **NAME**: Just the logger's name (e.g., `auth`)
- **PATH**: Full hierarchical path (e.g., `root:api:auth`)

Note: Root logger omits name/path regardless of setting to reduce noise.

#### Exception Display

- **BASIC**: Error message and first line of stack only
- **FULL**: Complete stack trace with all frames

#### Template Format

The `template` string defines the output format using placeholders:

**Available placeholders:**
- `%{timestamp}`: Formatted timestamp
- `%{level}`: Log level (formatted per `logLevel` option)
- `%{name}`: Logger name (formatted per `loggerName` option)
- `%{message}`: The log message
- `%{metadata}`: JSON representation of metadata object (if provided)
- `%{exception}`: Formatted exception (if present)

**Default template:**
```
%{timestamp} %{name} [%{level}] %{message}\n%{metadata}\n%{exception}
```

**Example custom template:**
```typescript
const transport = new CLITransport({
  template: '[%{level}] %{name}: %{message} %{metadata}',
  logLevel: 'NAME',
  loggerName: 'PATH',
  timestamp: 'FULL'
});
```

**Output:**
```
[error] root:api:auth: Failed login attempt {"username":"admin","ip":"192.168.1.1"}
```

### Example: Custom Transport Configuration

```typescript
import { LoggerEngine, CLITransport } from '@zerobias-org/logger';

const root = LoggerEngine.root();

// Remove default console transport
root.transports.forEach(t => root.removeTransport(t));

// Add custom CLI transport
const cliTransport = new CLITransport({
  timestamp: 'TIME',
  timezone: 'America/New_York',
  logLevel: 'SYMBOL',
  loggerName: 'PATH',
  exceptions: 'FULL',
  maxLineLength: 120,
  template: '%{timestamp} [%{level}] %{name} %{message}\n%{metadata}\n%{exception}'
});

root.addTransport(cliTransport);

// All loggers in the tree now use this transport
const apiLogger = root.get('api');
apiLogger.info('Server started');  // Uses custom formatting
```

### Migration from Current Implementation

The new design is a **breaking change** from the current `Logger(requestId)` factory pattern:

**Before (current):**
```typescript
import { Logger } from '@zerobias-org/logger';

const logger = new Logger('request-123');
const moduleLogger = logger.getLogger('myModule', 'custody-456');
moduleLogger.info('Message');
```

**After (new design):**
```typescript
import { LoggerEngine } from '@zerobias-org/logger';

const rootLogger = LoggerEngine.root();
const moduleLogger = rootLogger.get('myModule');
moduleLogger.info('Message', { requestId: 'request-123' });
```

**Key changes:**
- ❌ Removed: `Logger` factory class with requestId parameter
- ❌ Removed: Chain-of-custody as first-class parameter
- ✅ Added: Hierarchical structure with `LoggerEngine.root()`
- ✅ Added: Metadata object for context (requestId, etc.)
- ✅ Added: `verbose` and `trace` log levels
- ✅ Added: Configurable transports and formatting

## Error Logging

### Exception Parameter Support

All log methods accept an optional `Error` object as the second parameter. This provides rich error context including stack traces, error types, and error messages.

**Method Signatures:**

```typescript
// Two overloads per method:
logger.error(message: string, error?: Error, metadata?: object): void
logger.error(message: string, metadata?: object): void
```

The implementation automatically detects whether the second parameter is an `Error` instance or a metadata object, maintaining full backward compatibility.

### Usage Patterns

**1. Simple error logging:**
```typescript
try {
  const result = JSON.parse(invalidJson);
} catch (error) {
  logger.error('Failed to parse JSON', error);
}
// Output includes: message, error.name, error.message, error.stack
```

**2. Error with additional context:**
```typescript
try {
  await api.fetchUser(userId);
} catch (error) {
  logger.error('User fetch failed', error, {
    userId,
    endpoint: '/api/users',
    retryCount: 3
  });
}
// Output includes: message, error details, AND metadata
```

**3. Non-error levels (debugging, warnings):**
```typescript
try {
  const result = await experimentalFeature();
} catch (error) {
  // Just warn, don't treat as critical error
  logger.warn('Experimental feature failed, using fallback', error);
  return fallbackBehavior();
}
```

**4. Trace-level exception details:**
```typescript
try {
  processComplexWorkflow();
} catch (error) {
  logger.trace('Workflow exception details', error, {
    step: currentStep,
    state: workflowState
  });
}
```

### Error Object Handling

When an `Error` is provided, the transport receives:

```typescript
{
  level: 'error',
  message: 'Failed to parse JSON',
  error: {
    name: 'SyntaxError',
    message: 'Unexpected token < in JSON at position 0',
    stack: '...' // Full stack trace
  },
  // ... additional metadata if provided
}
```

### Transport Formatting

Transports control how errors are displayed via the `exceptions` option:

- **BASIC** (default): Error name and message only
  ```
  14:23:45 [api] error Failed to parse JSON
    SyntaxError: Unexpected token < in JSON at position 0
  ```

- **FULL**: Complete stack trace
  ```
  14:23:45 [api] error Failed to parse JSON
    SyntaxError: Unexpected token < in JSON at position 0
      at JSON.parse (<anonymous>)
      at parseResponse (/app/api.js:42:18)
      at processRequest (/app/api.js:128:12)
      ...
  ```

### Backward Compatibility

All existing code continues to work without changes:

```typescript
// ✅ Still works - metadata only
logger.error('Something failed', { userId: 123 });

// ✅ Still works - no second parameter
logger.info('Processing started');

// ✅ NEW - error parameter
logger.error('Request failed', new Error('Timeout'));

// ✅ NEW - error + metadata
logger.error('Request failed', new Error('Timeout'), { url: '/api' });
```

### Implementation Note

The overload is resolved at runtime using type detection:

```typescript
error(message: string, errorOrMetadata?: Error | object, metadata?: object): void {
  let error: Error | undefined;
  let meta: object | undefined;

  // Detect if second param is Error or metadata
  if (errorOrMetadata instanceof Error) {
    error = errorOrMetadata;
    meta = metadata;
  } else {
    meta = errorOrMetadata;
  }

  // Build log event with error if present
  const logEvent = {
    level: 'error',
    message,
    ...(error && { error: { name: error.name, message: error.message, stack: error.stack } }),
    ...(meta && meta)
  };

  this.logger.log(logEvent);
}
```

## Advanced Usage

### Per-Request Logging

For HTTP request tracing, create request-scoped child loggers with metadata:

```typescript
import { LoggerEngine } from '@zerobias-org/logger';
import express from 'express';

const app = express();
const rootLogger = LoggerEngine.root();
const apiLogger = rootLogger.get('api');

app.use((req, res, next) => {
  // Create request-specific logger
  const requestLogger = apiLogger.get(`request-${req.id}`);

  // Attach to request object
  req.logger = requestLogger;

  requestLogger.info('Request received', {
    method: req.method,
    path: req.path,
    ip: req.ip
  });

  next();
});

app.get('/api/users', (req, res) => {
  req.logger.debug('Fetching users');
  // ... handler logic
  req.logger.info('Response sent', { statusCode: 200, count: 42 });
});
```

**Alternative: Metadata-only approach (more efficient for high-volume):**

```typescript
app.use((req, res, next) => {
  req.logContext = { requestId: req.id, method: req.method, path: req.path };
  next();
});

app.get('/api/users', (req, res) => {
  apiLogger.info('Fetching users', req.logContext);
  // ... handler logic
  apiLogger.info('Response sent', { ...req.logContext, statusCode: 200 });
});
```

### Conditional Log Levels

Change log levels dynamically based on environment or runtime conditions:

```typescript
const dbLogger = rootLogger.get('database');

// Debug SQL in development
if (process.env.NODE_ENV === 'development') {
  dbLogger.setLevel(LogLevel.DEBUG);
}

// Enable verbose logging for specific user sessions
if (req.session.userId === 'debug-user-123') {
  const sessionLogger = apiLogger.get(`session-${req.session.id}`);
  sessionLogger.setLevel(LogLevel.TRACE);
}
```

### Specialized Transports for Child Loggers

Add child-specific transports for specialized output:

```typescript
import winston from 'winston';

const errorLogger = rootLogger.get('errors');

// Add file transport for errors only
const errorFileTransport = new winston.transports.File({
  filename: 'errors.log',
  level: 'error'
});

errorLogger.addTransport(errorFileTransport);

// Error logs go to both console (via parent chain) AND errors.log
errorLogger.error('Database connection failed', { host: 'db.example.com' });
```

### Custom Winston Transports

Integrate any Winston-compatible transport:

**Example: CloudWatch**
```typescript
import { LoggerEngine } from '@zerobias-org/logger';
import winston from 'winston';
import WinsonCloudWatch from 'winston-cloudwatch';

const root = LoggerEngine.root();

const cloudwatchTransport = new WinsonCloudWatch({
  logGroupName: 'my-app',
  logStreamName: 'production',
  awsRegion: 'us-east-1',
  jsonMessage: true
});

root.addTransport(cloudwatchTransport);
```

**Example: SumoLogic**
```typescript
import { LoggerEngine } from '@zerobias-org/logger';
// Note: winston-sumologic-transport is a hypothetical package
import SumoLogicTransport from 'winston-sumologic-transport';

const root = LoggerEngine.root();

const sumologicTransport = new SumoLogicTransport({
  url: process.env.SUMOLOGIC_ENDPOINT,
  level: 'info',
  meta: {
    service: 'my-app',
    environment: process.env.NODE_ENV
  }
});

root.addTransport(sumologicTransport);
```

**Example: File with rotation**
```typescript
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

const root = LoggerEngine.root();

const fileTransport = new DailyRotateFile({
  filename: 'application-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d'
});

root.addTransport(fileTransport);
```

### Testing and Mocking

Intercept logs in tests without polluting console:

```typescript
import { LoggerEngine } from '@zerobias-org/logger';
import winston from 'winston';

describe('MyService', () => {
  let capturedLogs: any[] = [];

  beforeEach(() => {
    capturedLogs = [];

    const root = LoggerEngine.root();

    // Remove all transports
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

  it('should log expected messages', () => {
    const logger = LoggerEngine.root().get('myService');
    logger.info('Test message', { value: 42 });

    expect(capturedLogs).toHaveLength(1);
    expect(capturedLogs[0].message).toBe('Test message');
    expect(capturedLogs[0].value).toBe(42);
  });

  it('should log errors with stack traces', () => {
    const logger = LoggerEngine.root().get('myService');
    const testError = new Error('Test error');

    logger.error('Operation failed', testError, { operation: 'test' });

    expect(capturedLogs).toHaveLength(1);
    expect(capturedLogs[0].message).toBe('Operation failed');
    expect(capturedLogs[0].error.name).toBe('Error');
    expect(capturedLogs[0].error.message).toBe('Test error');
    expect(capturedLogs[0].error.stack).toContain('Error: Test error');
    expect(capturedLogs[0].operation).toBe('test');
  });
});
```

## Implementation Architecture

### Core Classes

**LoggerEngine**
- Main logger implementation
- Manages Winston logger instance lifecycle
- Implements hierarchy (parent/children relationships)
- Provides logging methods: `crit`/`critical`, `error`, `warn`/`warning`, `info`, `verbose`, `debug`, `trace`
- Metadata parameter is simple `object` type (no generics) for maximum flexibility

**ParentTransport** (extends `winston.Transport`)
- Custom Winston transport for hierarchy chaining
- Automatically added to all non-root loggers
- Forwards log events to parent's transports
- Enriches events with logger metadata

**LoggerTransport** (abstract base class)
- Base class for `ConsoleTransport` and `CLITransport`
- Implements formatting logic and configuration
- Provides template parsing and rendering
- Handles timestamp formatting with timezone support

**ConsoleTransport** (extends `LoggerTransport`)
- Default transport for maximum portability
- Maps log levels to `console` methods
- No external dependencies

**CLITransport** (extends `LoggerTransport`)
- ANSI color support for terminals
- Enhanced formatting for CLI environments
- Static `install()` method for easy setup

### LogLevel Enum

```typescript
enum LogLevel {
  CRIT = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  VERBOSE = 4,
  DEBUG = 5,
  TRACE = 6
}

// Each level has associated metadata:
interface LogLevelMetadata {
  name: string;      // 'crit', 'error', etc.
  value: number;     // 0-6
  symbol: string;    // '!!!', '!!', '!', '', '*', '**', '***'
  color: string;     // ANSI color name
}
```

### Singleton Pattern for Root Logger

```typescript
class LoggerEngine {
  private static _root: LoggerEngine | undefined;

  static root(): LoggerEngine {
    if (!LoggerEngine._root) {
      LoggerEngine._root = new LoggerEngine('root', undefined, {
        level: LogLevel.INFO,
        transports: [new ConsoleTransport()]
      });
    }
    return LoggerEngine._root;
  }
}
```

### Level Inheritance Algorithm

```typescript
class LoggerEngine {
  private _level: LogLevel | undefined;

  getEffectiveLevel(): LogLevel {
    if (this._level !== undefined) {
      return this._level;
    }

    if (this.parent) {
      return this.parent.getEffectiveLevel();
    }

    // Root logger with no explicit level
    return LogLevel.INFO;
  }
}
```

## Type Definitions

```typescript
interface LoggerOptions {
  level?: LogLevel;
  transports?: winston.Transport[];
}

interface TransportOptions {
  timestamp?: 'NONE' | 'FULL' | 'TIME' | 'CUSTOM';
  timezone?: string;  // IANA timezone name
  logLevel?: 'NONE' | 'SYMBOL' | 'NAME';
  loggerName?: 'NONE' | 'NAME' | 'PATH';
  exceptions?: 'BASIC' | 'FULL';
  maxLineLength?: number;
  template?: string;
  customTimestampFormatter?: (date: Date) => string;
}

interface LogEvent {
  level: string;
  message: string;
  timestamp: string;
  name: string;      // Logger name
  path: string;      // Logger path
  error?: {          // Optional error object
    name: string;    // Error type (e.g., 'TypeError')
    message: string; // Error message
    stack: string;   // Stack trace
  };
  [key: string]: any;  // Metadata fields
}
```

## Design Rationale

### Why Hierarchical Structure?

1. **Natural code organization**: Mirrors application module structure
2. **Centralized configuration**: Set once at root, inherit everywhere
3. **Selective debugging**: Enable verbose logging for specific subsystems
4. **Context preservation**: Logger path provides automatic breadcrumbs

### Why Remove requestId/chainOfCustody Parameters?

1. **Flexibility**: Metadata object supports any context fields
2. **Consistency**: All contextual data handled uniformly
3. **Simplicity**: Fewer required parameters, clearer API
4. **Extensibility**: Add new context fields without API changes

### Why Winston Foundation?

1. **Battle-tested**: Industry standard with wide adoption
2. **Transport ecosystem**: Huge library of existing transports
3. **Performance**: Efficient async logging
4. **Standards compliance**: Supports npm log levels and syslog levels

### Why Keep Current Log Methods?

The current `LoggerEngine` methods are preserved because:

1. **Simple, familiar API**: Matches `console` and most logging libraries
2. **Optional metadata**: `logger.info(msg, metadata?)` is concise and clear
3. **Type safety**: TypeScript validates message string, metadata is flexible `object` type
4. **No learning curve**: Developers immediately understand the API
5. **Backward compatibility**: Aliases (`warning`/`critical`) preserved from current implementation

**Method aliases rationale:**
- `warning()` → `warn()`: Common convention (npm, syslog)
- `critical()` → `crit()`: Syslog convention
- Both forms supported for developer preference and backward compatibility

## Performance Considerations

### Log Level Filtering

Log level checks happen **before** message formatting:

```typescript
debug(message: string, metadata?: object): void {
  const effectiveLevel = this.getEffectiveLevel();
  if (LogLevel.DEBUG > effectiveLevel) {
    return;  // Skip formatting and transport entirely
  }

  // Only format and emit if level permits
  this.logger.log({ level: 'debug', message, ...metadata });
}
```

**Implication**: Disabled log calls have minimal overhead (just a numeric comparison).

### Child Logger Creation

Child loggers are **cached** on first access:

```typescript
class LoggerEngine {
  private children = new Map<string, LoggerEngine>();

  get(childName: string, options?: LoggerOptions): LoggerEngine {
    let child = this.children.get(childName);

    if (!child) {
      child = new LoggerEngine(childName, this, options);
      this.children.set(childName, child);
    }

    return child;
  }
}
```

**Implication**: Repeated calls to `logger.get('same-name')` return the same instance (no allocation overhead).

### Transport Chaining Overhead

Each log event traverses up the tree, hitting each ancestor's transports. For deep hierarchies:

- **Shallow trees (2-4 levels)**: Negligible overhead
- **Deep trees (5+ levels)**: Consider adding transports only at root
- **High-volume logging**: Use metadata instead of child loggers for request IDs

## Migration Strategy

### Phase 1: Parallel Implementation
- Implement new design as `LoggerEngine` (no changes to existing code)
- Keep current `Logger` class as deprecated
- Both APIs work side-by-side

### Phase 2: Consumer Migration
- Update services incrementally to use `LoggerEngine.root()`
- Move requestId to metadata: `logger.info(msg, { requestId })`
- Update tests to use new API

### Phase 3: Deprecation
- Mark old `Logger` class as deprecated
- Add migration guide to documentation
- Remove after all consumers migrated

### Compatibility Shim (Optional)

For gradual migration, provide a compatibility wrapper:

```typescript
// Deprecated: Use LoggerEngine.root() instead
export class Logger {
  constructor(public requestId: string) {}

  getLogger(moduleName: string, chainOfCustody?: string): LoggerEngine {
    const logger = LoggerEngine.root().get(moduleName);

    // Wrap to auto-inject requestId
    return new Proxy(logger, {
      get(target, prop) {
        if (['info', 'debug', 'warn', 'error', 'crit'].includes(prop as string)) {
          return (message: string, metadata?: object) => {
            const enrichedMetadata = {
              ...metadata,
              requestId: this.requestId,
              chainOfCustody
            };
            return target[prop](message, enrichedMetadata);
          };
        }
        return target[prop];
      }
    });
  }
}
```

## Future Enhancements

### Potential Additions

1. **Async transports**: Non-blocking I/O for high-throughput scenarios
2. **Log sampling**: Sample high-frequency logs (e.g., "log 1% of requests")
3. **Structured query**: Search logs by metadata fields
4. **Performance metrics**: Track log volume and performance per logger
5. **Dynamic reconfiguration**: Hot-reload configuration from file/API

### Non-Goals

1. **Log aggregation**: Use external tools (ELK, Splunk, CloudWatch)
2. **Log analysis**: Use external tools (Grafana, Datadog)
3. **Log storage**: Winston transports handle persistence
4. **Distributed tracing**: Use OpenTelemetry or similar

## Contributing

When modifying this package:

1. **Preserve existing log methods**: `crit`/`critical`, `error`, `warn`/`warning`, `info`, `verbose`, `debug`, `trace`
2. **Maintain backward compatibility**: All methods support both signatures:
   - `logger.error(msg, metadata?)`
   - `logger.error(msg, error?, metadata?)`
3. **Ensure level inheritance works correctly**: Test undefined levels inherit from parent
4. **Test transport chaining**: Validate multi-level hierarchies propagate correctly
5. **Validate formatting options**: Test all transports with various configurations
6. **Test error handling**: Verify Error objects are properly serialized (name, message, stack)
7. **Check performance**: High log volume shouldn't degrade application performance
8. **Update type definitions**: Keep TypeScript definitions in sync with implementation
9. **Keep metadata simple**: Use `object` type, avoid generics for maximum flexibility

## License

ISC License - See LICENSE file for details 
