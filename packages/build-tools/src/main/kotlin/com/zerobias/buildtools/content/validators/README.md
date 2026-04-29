# Content validators catalog

Per-artifact-type validators that consumer repos opt into via the
`zb.content` validator slot:

```kotlin
// <content-repo>/build.gradle.kts (root)
import com.zerobias.buildtools.content.validators.VendorValidator
extra["contentValidator"] = VendorValidator::validate
```

Each validator implements `(org.gradle.api.Project) -> Unit` — throw on
invalid, return normally on valid. `zb.content.validateContent` reads
`rootProject.extra["contentValidator"]` and delegates. When the extra
is unset, falls back to `VendorValidator` (the original behavior before
the slot was introduced).

## Catalog

| Validator | For repo | Verifies |
|---|---|---|
| `VendorValidator` | `zerobias-org/vendor` | single-level `package/<code>/` layout, `@zerobias-org/vendor-<code>` npm name, `index.yml` schema (id UUID, code, name, description, url, status enum, aliases[]), zerobias metadata block |
| `TagValidator` | `zerobias-com/tag` | tag-type subdirectories present (env-type, product-segment, service-segment, query-folder, other, marketplace), `zerobias.import-artifact == "tag"`, dataloader-version set |

**Each validator is artifact-type-specific.** Do not import `VendorValidator`
for non-vendor repos — its `expectedName` formula and required-files set
are vendor-shaped. Other content types (suite, product, framework,
standard, crosswalk, benchmark) need their own validator written for
their actual shape.

## Adding a validator for a new artifact type

1. Create `<Type>Validator.kt` in this package.
2. Object with `@JvmStatic fun validate(project: Project)`.
3. Throw on invalid; return normally on valid. Keep the check honest —
   only verify what's actually invariant for the type, don't copy
   vendor's formulas blindly.
4. Add a row to the catalog table above with the actual checks performed.
5. The consumer repo opts in:
   `extra["contentValidator"] = <Type>Validator::validate`

No changes to `zb.content` or the validator slot are required.

## The dataloader is the universal contract

A repo-supplied validator is a **pre-flight schema check** — it catches
malformed packages before they reach the dataloader. The dataloader
itself (run by `testIntegrationDataloader` against an ephemeral Neon
branch) is the universal "is this loadable?" check across every content
type. Validators should focus on *cheap, fast* schema checks; let the
dataloader be the source of truth on loadability.

## Pattern: util provides the slot, repo fills it

This catalog reflects a project-wide convention for the `zb.*` plugins:
util provides extension points (`extra["<concern>"]`) with safe defaults;
each consumer repo fills the slot with its own implementation. New
extension points (e.g. gate-stamp source-set, marker-emit shape) follow
the same shape — slot in the plugin script, default behavior in util,
library implementations alongside `validators/` or in a sibling feature
folder.
