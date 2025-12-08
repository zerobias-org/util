# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## 2.0.0 (TBD)

### BREAKING CHANGES

- **Hierarchical Logger Architecture**: Complete rewrite to hierarchical design with parent-child relationships
- **Log Level System**: Changed to 7-level system (CRIT=0, ERROR=1, WARN=2, INFO=3, VERBOSE=4, DEBUG=5, TRACE=6)
- **Singleton Root Logger**: Access root logger via `LoggerEngine.root()` instead of creating instances directly
- **Level Inheritance**: Child loggers inherit log level from parent unless explicitly overridden
- **Deprecated Logger class**: Old `Logger` class is deprecated in favor of `LoggerEngine`

### Features

- **Error Parameter Support**: All log methods now accept optional Error parameter for exception logging
  ```typescript
  logger.error('Operation failed', error);
  logger.error('Operation failed', error, { userId: 123 });
  ```
- **Logger Lifecycle Management**: New `destroy()` method for proper cleanup and memory leak prevention
- **Winston Transport Integration**: Custom `ParentTransport` automatically chains logs up the hierarchy
- **Custom Log Levels**: Full support for verbose, debug, and trace levels via Winston custom levels
- **Logger Path Tracking**: Each logger includes its full hierarchical path (e.g., 'root:api:auth')
- **Method Aliases**: `critical()` and `warning()` aliases for `crit()` and `warn()`
- **Advanced Transport System**: Template-based formatting with extensive configuration options
  - `ConsoleTransport`: Default transport for maximum portability (Node.js + browser)
  - `CLITransport`: Enhanced terminal transport with ANSI colors via chalk
  - `LoggerTransport`: Base class for custom transports with template system
- **Transport Formatting Options**:
  - Timestamp modes: NONE, FULL, TIME (with hourly date markers), CUSTOM
  - Log level display: NONE, SYMBOL, NAME
  - Logger name display: NONE, NAME, PATH
  - Exception detail: BASIC, FULL
  - Timezone configuration
  - Custom output templates with placeholders
  - `CLITransport.install()` for easy default transport replacement

### Migration Guide

See README.md for full migration guide from 1.x to 2.0.0.

**Quick migration:**
```typescript
// Before (1.x)
import { Logger } from '@zerobias-org/logger';
const logger = new Logger('myapp');

// After (2.0.0)
import { LoggerEngine } from '@zerobias-org/logger';
const logger = LoggerEngine.root().get('myapp');
```

### Internal Changes

- Added `LogLevel.ts` with enum and metadata definitions
- Added `types.ts` with TypeScript interfaces
- Added `ParentTransport.ts` for hierarchical log chaining
- Added `transports/LoggerTransport.ts` with template-based formatting engine
- Added `transports/ConsoleTransport.ts` for console output
- Added `transports/CLITransport.ts` with chalk-based ANSI colors
- Complete rewrite of `LoggerEngine.ts` implementation
- Comprehensive unit test suite (72 tests)
- Dependencies: Added `chalk` for terminal colors, `@types/node` for TypeScript

## <small>1.0.3 (2025-12-08)</small>

* fix: logger not exported correctly ([9ebd0c4](https://github.com/zerobiasorg/util/commit/9ebd0c4))

## <small>1.0.2 (2025-12-08)</small>

* fix: bump types deps, add exports ([fbdbab6](https://github.com/zerobiasorg/util/commit/fbdbab6))





## <small>1.0.1 (2025-12-05)</small>

* fix: added and corrected lint for all projects ([bf18b93](https://github.com/zerobiasorg/util/commit/bf18b93))
* fix: lets go ([9c0cc3a](https://github.com/zerobiasorg/util/commit/9c0cc3a))
* fix: trash old loggers, consolidate to 1 standard logger ([a925734](https://github.com/zerobiasorg/util/commit/a925734))
* fix: update deps ([a668792](https://github.com/zerobiasorg/util/commit/a668792))
* fix: update deps, prepublish ([600c33b](https://github.com/zerobiasorg/util/commit/600c33b))
* chore(release): bump version ([54fb7d6](https://github.com/zerobiasorg/util/commit/54fb7d6))
* chore(release): bump version ([788964a](https://github.com/zerobiasorg/util/commit/788964a))
* chore(release): bump version ([08f3ee8](https://github.com/zerobiasorg/util/commit/08f3ee8))
* chore(release): bump version ([5930b16](https://github.com/zerobiasorg/util/commit/5930b16))
* chore(release): bump version ([51df8b5](https://github.com/zerobiasorg/util/commit/51df8b5))





# Changelog

## 1.0.0

- Initial release
- Consolidated from @zerobias-org/util-platform-logger
- Standard logger for all ZeroBias services
- ESM-compatible winston wrapper
- Exports `Logger` class and `LoggerEngine` class
