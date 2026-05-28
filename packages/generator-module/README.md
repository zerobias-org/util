# @zerobias-org/generator-module

Yeoman generator that scaffolds a new Hub module package.

## Naming exception

Other packages in this monorepo follow the `@zerobias-org/util-*` convention
(e.g. `@zerobias-org/util-codegen`, `@zerobias-org/util-hub-module-utils`).

This package intentionally **breaks** that convention. Yeoman's discovery
mechanism only resolves generators whose npm package name starts with
`generator-` (scoped form: `@scope/generator-*`). A name like
`@zerobias-org/util-generator-module` would not be picked up by
`yo zerobias-org/module` — so the package is published as
`@zerobias-org/generator-module` so Yeoman can find it.

See: https://yeoman.io/authoring/#node_modules-and-the-generator-resolution

## Usage

```bash
npm install -g @zerobias-org/generator-module
yo @zerobias-org/module
```

## History

Migrated from `auditmation/hub`'s `generator-hub-module` subpackage
(originally `@auditmation/generator-hub-module`). Picks up the changes from
PR #260 (`generator_auditmation_dependencies`) plus the local edits that
were never committed there.
