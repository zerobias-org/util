# Content validators catalog

Library functions a content repo opts into via the `zb.content` validator
slot:

```kotlin
// <content-repo>/build.gradle.kts (root)
import com.zerobias.buildtools.content.validators.VendorValidator
extra["contentValidator"] = VendorValidator::validate
```

Each validator implements `(org.gradle.api.Project) -> Unit` — throw on
invalid, return normally on valid. `zb.content.validateContent` reads
`rootProject.extra["contentValidator"]` and delegates.

## When to pick which

| Validator | Repos that should use it | Shape |
|---|---|---|
| `VendorValidator` | `vendor`, `suite`, `product`, `framework`, `standard`, `crosswalk`, `benchmark` (default) | `index.yml` + logo + package.json |
| `TagValidator` | `zerobias-com/tag` | tag-type subdirectories (env-type/, product-segment/, marketplace/, …) + package.json |

## Pattern

Util provides the catalog as a shared toolbox. Each repo declares which
tool it uses; util doesn't decide. New artifact types add a new
validator here without touching `zb.content` itself — same delegation
principle as the slot it plugs into.

When `extra["contentValidator"]` is unset, `zb.content.validateContent`
falls back to `VendorValidator` for backward-compatibility with repos
migrated before the slot existed.

## Adding a new validator

1. Create `src/main/kotlin/com/zerobias/buildtools/content/validators/<Type>Validator.kt`
2. Object with `@JvmStatic fun validate(project: Project)`
3. Document the package shape it expects + which repos use it
4. Add a row to the table above
5. The consumer repo opts in: `extra["contentValidator"] = <Type>Validator::validate`

No changes to `zb.content` or the validator slot are required.
