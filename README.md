# @zerobias-org/util

Utility packages for ZeroBias projects.

## Structure

This is an npm workspaces monorepo using Lerna and Nx for build orchestration.

```
packages/
  codegen/     # OpenAPI code generator for Hub Modules
```

## Requirements

- Node.js >= 24.11.0
- npm >= 10.0.0
- Java 8+ (for codegen)

## Setup

```bash
npm install
```

## Packages

### @zerobias-org/util-codegen

OpenAPI Generator for creating Hub Modules and API clients. Generates ESM-compatible TypeScript with proper `.js` extensions on imports.

```bash
# Build the codegen
cd packages/codegen
npm run build

# Generate a hub module
./bin/hub-generator.js generate -g hub-module -i api.yml -o output/
```
