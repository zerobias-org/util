# Hub Module Test Client Generator

Code generator template for creating typed test clients that work with `@zerobias-org/module-tester` framework.

## Status

⚠️ **Work in Progress** - Template needs refinement to match OpenAPI Generator's context model.

## Purpose

Generate typed test clients that transform OpenAPI operations into Docker container wire protocol calls:

**OpenAPI:**
```yaml
GET /organizations?page=1&perPage=10
```

**Generated Client:**
```typescript
client.organization.listMyOrganizations({ page: 1, perPage: 10 })
// Transforms to: POST /connections/{id}/OrganizationApi.listMyOrganizations
// With body: { argMap: { page: 1, perPage: 10 } }
```

## Usage (When Complete)

```bash
hub-generator generate \
  -g hub-module-test-client \
  -i full.yml \
  -o test/generated/
```

## Current Approach

Until the code generator is refined, use manual client-factory.ts files as references:
- `/auditlogic/module/package/github/github/test/client-factory.ts`
- `/auditlogic/module/package/auditmation/generic/sql/test/client-factory.ts`

These demonstrate the correct wire protocol transformation pattern.

## Next Steps

1. Study OpenAPI Generator's Mustache context model
2. Test template generation with actual modules
3. Refine template structure to match hub-module template patterns
4. Add proper API grouping by tags
5. Handle pagination wrapper unwrapping
6. Add comprehensive TypeScript types

## References

- Wire protocol: `/org/util/packages/module-tester/PROTOCOL.md`
- Existing generator: `/org/util/packages/codegen/src/main/resources/hub-module/`
- OpenAPI Generator docs: https://openapi-generator.tech/docs/templating/
