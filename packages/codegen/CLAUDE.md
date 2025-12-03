# CLAUDE.md - Codegen Package

This file provides guidance to Claude Code when working with the codegen package.

## Overview

This package is an OpenAPI code generator built on top of [OpenAPI Generator](https://openapi-generator.tech/). It produces ESM-compatible TypeScript code for Hub Modules and API clients.

**Key Feature**: Generates proper ESM imports with `.js` extensions on relative imports, eliminating the need for post-processing scripts.

## Project Structure

```
packages/codegen/
├── bin/
│   ├── hub-generator.js          # CLI entry point (ESM)
│   ├── hub-module-codegen.jar    # Built Java codegen (generated)
│   └── openapi-generator-cli.jar # OpenAPI Generator dependency (generated)
├── src/main/
│   ├── java/io/zerobias-org/hub/module/codegen/
│   │   ├── HubModuleCodegenGenerator.java   # Main hub-module generator
│   │   └── ApiClientGenerator.java          # API client generator
│   └── resources/
│       ├── hub-module/           # Templates for hub-module generator
│       ├── hub-module-server/    # Templates for hub-module-server generator
│       └── api-client/           # Templates for api-client generator
├── test/unit/
│   └── GeneratorTest.ts          # Unit tests
├── build.gradle                  # Gradle build configuration
├── hub-module-codegen.gradle     # Additional Gradle config
└── settings.gradle               # Gradle settings
```

## Build Commands

```bash
# Full build (compile Java + copy JARs)
npm run build

# Just compile Java
npm run compile

# Copy built JARs to bin/
npm run copyDeps

# Clean build artifacts
npm run clean

# Run tests (generates test output first)
npm run test
```

## Generator Types

### 1. `hub-module`
Generates TypeScript models and API interfaces for Hub Module development.

```bash
./bin/hub-generator.js generate -g hub-module -i api.yml -o output/
```

### 2. `hub-module-server`
Generates server-side implementations for Hub Modules.

```bash
./bin/hub-generator.js generate -g hub-module-server -i api.yml -o output/
```

### 3. `api-client` (via ApiClientGenerator)
Generates API client code for consuming APIs.

## ESM Import Handling

The generators produce ESM-compatible TypeScript with:

- **Relative imports**: Include `.js` extension (e.g., `from './Activity.js'`)
- **Directory imports**: Use explicit `index.js` (e.g., `from './index.js'`)
- **External packages**: No `.js` extension (e.g., `from '@zerobias-org/types-core-js'`)

### How It Works

The ESM import logic is in `toTsImports()` method in both generator classes:

```java
// In HubModuleCodegenGenerator.java and ApiClientGenerator.java
private List<Map<String, String>> toTsImports(CodegenModel cm, Set<String> imports) {
    // External packages (from CORE_TYPES map) - NO .js extension
    // Relative model imports - ADD .js extension
}
```

Key locations for ESM handling:
- `HubModuleCodegenGenerator.java:toTsImports()` - Adds `.js` to relative imports only
- `ApiClientGenerator.java:toTsImports()` - Same logic for API client
- Mustache templates - Use `{{filename}}.js` for relative paths

## Mustache Templates

Templates use [Mustache](https://mustache.github.io/) syntax. Key variables:

| Variable | Description |
|----------|-------------|
| `{{classname}}` | The class/type name |
| `{{filename}}` | The file name (without extension) |
| `{{classFilename}}` | The class filename |
| `{{#tsImports}}` | Loop over TypeScript imports |
| `{{#models}}` | Loop over model definitions |

### Template Locations

- `src/main/resources/hub-module/` - Hub module templates
  - `model.mustache` - Individual model file
  - `models.mustache` - Index file exporting all models
  - `api-single.mustache` - Single API class
  - `api-all.mustache` - API index file

- `src/main/resources/api-client/` - API client templates
  - Similar structure to hub-module

## Adding New Templates or Modifying Existing

1. Edit the `.mustache` template file
2. Rebuild: `npm run build`
3. Test: `./bin/hub-generator.js generate -g hub-module -i api.yml -o /tmp/test`
4. Verify output has correct ESM imports

## Core Types Mapping

The generators map OpenAPI types to TypeScript types via `CORE_TYPES` map:

```java
// Example mappings in HubModuleCodegenGenerator.java
CORE_TYPES.put("UUID", new CoreTypeMetadata("UUID", "@zerobias-org/types-core-js"));
CORE_TYPES.put("Duration", new CoreTypeMetadata("Duration", "@zerobias-org/types-core-js"));
CORE_TYPES.put("Nmtoken", new CoreTypeMetadata("Nmtoken", "@zerobias-org/types-core-js"));
```

These types are imported from external packages without `.js` extensions.

## Common Issues

### Generated imports missing `.js`
Check `toTsImports()` method - ensure the else branch (for model imports) adds `.js`.

### External packages have `.js` appended
Check that external packages go through the `CORE_TYPES` map path, not the model import path.

### Template not found errors
Ensure template files are in `src/main/resources/{generator-name}/` and rebuild.

### Java compilation errors
Run `./gradlew build --stacktrace` for detailed error output.

## Testing Changes

1. Make changes to Java code or templates
2. Build: `npm run build`
3. Generate test output:
   ```bash
   ./bin/hub-generator.js generate -g hub-module -i /path/to/api.yml -o /tmp/test
   ```
4. Verify imports in generated files:
   ```bash
   head -15 /tmp/test/model/SomeModel.ts
   ```

## Dependencies

- **Java 8+**: Required for compiling and running the generator
- **Gradle**: Build system for Java code
- **OpenAPI Generator 5.4.0**: Base generator framework

## Related Files

- `/home/cscarola/nfa-repos/zerobias/util/tsconfig.json` - Root TypeScript config (NodeNext)
- `/home/cscarola/nfa-repos/zerobias/util/package.json` - Root package config
