# @zerobias-org/module-devkit

Shared build toolchain and TypeScript base config for Hub modules.

## Why

Every Hub module declared the same ~12 toolchain devDependencies and a
near-identical `tsconfig.json`. Across 67 gradle-migrated modules that is ~800
duplicated declarations (~1,750 once all 147 migrate), and every toolchain
question — ESLint 10 support, TypeScript 7, `@types/node` 24 dropping ambient
globals — had to be answered once per module instead of once.

This package makes the module build toolchain a single versioned artifact:
modules take one devDependency and extend one tsconfig.

## Usage

```jsonc
// module package.json
"devDependencies": {
  "@zerobias-org/module-devkit": "^0.1.0"
}
```

```jsonc
// module tsconfig.json
{
  "extends": "@zerobias-org/module-devkit/tsconfig.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src/**/*", "test/**/*", "generated/**/*"],
  "exclude": ["dist", "node_modules", "hub-sdk"]
}
```

The toolchain binaries (`tsc`, `mocha`, `tsx`, `redocly`) resolve through
`node_modules/.bin` via npm hoisting, so the gradle lifecycle tasks work
unchanged.

## Version policy

**Exact pins live here.** Modules take a caret range on the devkit; the devkit
pins each tool exactly. That makes the fleet's toolchain uniform by
construction — modules cannot drift from one another, only the devkit moves.

A module that genuinely needs a different version can still declare it
directly: the devkit is a default, not a jail.

## ⚠️ Transitive advisories stay the consumer's job

Toolchain packages pull their own transitive dependencies, and those pick up
advisories over time. When the upstream package has not yet released a fixed
range, the remediation is an `overrides` entry — and **that cannot live in the
devkit**: npm only honors `overrides` from the *root* package of an install
tree, so an `overrides` field inside a dependency is ignored.

Modules therefore keep an `overrides` block in their own `package.json`:

```json
"overrides": {
  "<transitive-package>": ">=<fixed-version>"
}
```

Which entries are needed changes as advisories are published and upstreams
catch up — treat the block as living config, not a fixed list. To see what a
module currently needs:

```bash
npm audit --omit=dev          # in the module, after install
```

At the time of writing this resolves to two entries (both reached through
mocha, which has no released version requiring fixed ranges). Expect that set
to shift.

This is the one toolchain concern the devkit cannot absorb, so it should be
enforced mechanically — a gate validator that fails a module with known-
vulnerable toolchain transitives, plus the Renovate vulnerability lane — rather
than remembered.

## What belongs here

Only things no module should ever have an opinion about — the compiler, test
runner, spec linter, shared type packages, and the tsconfig base.

**Not** here: vendor SDKs (`@aws-sdk/*`), runtime platform libraries
(`logger`, `hub-module-utils`, `types-core`) or anything that ships inside the
module's docker image and affects its behavior. Those have a different
lifecycle and risk profile.

## Local development

```bash
# in this package
npm link

# in a module
npm link @zerobias-org/module-devkit
zbb gate
```
