# CLAUDE.md - util-secrets-manager

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

## Purpose

`@zerobias-org/util-secrets-manager` is a unified abstraction over five secret backends:

- **AWS Secrets Manager** — direct `@aws-sdk/client-secrets-manager` (no module wrapper)
- **AWS Systems Manager Parameter Store** — direct `@aws-sdk/client-ssm`
- **HashiCorp Vault** — direct HTTP via `axios` (KV v2 only)
- **Azure Key Vault** — direct `@azure/identity` + `@azure/keyvault-secrets` + `@azure/arm-keyvault`
- **Local filesystem** — JSON/YAML files under `FILE_SECRET_ROOT`
- **Process environment** — read-only access to `process.env`

The package was migrated out of `com/hub/secrets-manager` and rewritten to remove dependencies on the auditlogic connector modules (`@auditlogic/module-amazon-aws-secretsmanager`, `@auditlogic/module-hashicorp-vault`). All backend communication now uses SDKs or direct HTTP.

## Architecture

Tree-based addressing. Every secret has a path like `{provider}.{secret}.{subpath}` joined with `.` (the `DELIMITER`). The provider prefix selects a `TreeNode` subclass; everything below the prefix is provider-specific.

```
SecretsManagerImpl
  └── managers: Record<provider, TreeNode>
       ├── env       → TreeNode (process.env)
       ├── file      → FileNode (FILE_SECRET_ROOT)
       ├── aws       → AwsNode → AwsSecretsClient (@aws-sdk/client-secrets-manager)
       ├── awsssm    → AwsSsmNode → SSMClient (@aws-sdk/client-ssm)
       ├── azure     → AzureNode → KeyVaultManagementClient + SecretClient (@azure/*)
       └── vault     → VaultNode → VaultClient (axios → Vault REST API, KV v2)
```

`TreeNode` (in `src/TreeNode.ts`) is the abstract base. Each provider subclass overrides `setValue` / resolves children lazily / caches values with a TTL. `SecretsManagerImpl` owns the lifecycle: `init()` connects all providers in parallel; `getRoot(provider)` returns the active `TreeNode` (re-registering if it went inactive).

## Key Files

```
src/
├── SecretNode.ts            # Hand-written node descriptor (path, type, writable, active, error fields). Replaces the previous OpenAPI-generated model.
├── SecretsManager.ts        # Public interface (DELIMITER, SecretsManager, SecretType)
├── SecretsManagerImpl.ts    # Provider registration, connect orchestration, public API
├── TreeNode.ts              # Abstract base (path, caching, resolveChildren)
├── AwsSecretsClient.ts      # Direct AWS Secrets Manager wrapper (replaces @auditlogic/module-amazon-aws-secretsmanager)
├── AwsNode.ts               # AWS Secrets Manager TreeNode adapter
├── AwsSsmNode.ts            # AWS SSM Parameter Store TreeNode (uses @aws-sdk/client-ssm directly)
├── VaultClient.ts           # HashiCorp Vault HTTP client (replaces @auditlogic/module-hashicorp-vault)
├── VaultNode.ts             # Vault TreeNode adapter
├── AzureNode.ts             # Azure Key Vault TreeNode (uses @azure/* SDKs directly)
├── EnvironmentNode.ts       # process.env TreeNode
├── FileNode.ts              # Filesystem TreeNode (JSON/YAML)
├── JsonNode.ts              # In-memory TreeNode for parsed JSON sub-objects
├── common.ts                # Shared logger, sleep, Semaphore, errorMessage helper
└── index.ts                 # Re-exports the public surface
```

## Public API

```typescript
import {
  SecretsManager,
  SecretsManagerImpl,
  SecretNode,
  SecretType,
  DELIMITER,
} from '@zerobias-org/util-secrets-manager';

const sm: SecretsManager = new SecretsManagerImpl();
await sm.init();                                  // Connect all providers in parallel

const nodes = await sm.listNodes('vault.kv');     // List children at a path
const value = await sm.getValue('aws.api/key');   // Read a leaf secret
await sm.setValue('vault.kv.app.token', 'xyz');   // Write (only if WRITABLE_SECRET targets this provider)
```

`SecretNode.TypeEnum.{Node,Secret}` are string literals (`'Node'` / `'Secret'`). The class supports `new SecretNode(path, type, writable, active, ...)` and the permissive `SecretNode.newInstance(partial)` factory for object-form construction.

`AwsSecretsClient` and `VaultClient` are also exported and can be used directly if a consumer doesn't need the tree abstraction.

## Environment Variables

| Provider | Required | Optional |
|---|---|---|
| **AWS Secrets Manager / SSM** | At least one of: `AWS_REGION` / `AWS_DEFAULT_REGION` / `AWS_ENDPOINT`. With `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` it tries direct creds first; otherwise falls through to the default credential chain ("infrastructure mode" — env, shared profile, instance role). | `AWS_CONNECTION_TIMEOUT_MS` (default 10000) |
| **HashiCorp Vault** | `VAULT_ADDR` plus one of: `VAULT_TOKEN` (token auth), or `VAULT_ROLE_ID` + `VAULT_SECRET_ID` (approle). Falls back to `~/.vault-token` for `vault login` users. | `VAULT_NAMESPACE`, `VAULT_AUTH_PATH` (default `approle`), `VAULT_CONNECTION_TIMEOUT_MS`, `VAULT_MAX_RETRIES`, `VAULT_RETRY_MS`, `NO_VAULT_RETRY` |
| **Azure Key Vault** | `AZURE_SUBSCRIPTION_ID` (or runs IMDS lookup at `169.254.169.254` for VM-resident detection). Auth via `DefaultAzureCredential` (env vars, managed identity, etc.). | — |
| **Local file** | `FILE_SECRET_ROOT` — directory to expose | `WRITABLE_SECRET` (path prefix that's permitted to write) |
| **All** | — | `CACHE_TIMEOUT_SECONDS` (default 300), `HUB_DISABLE_EXTERNAL_PROVIDERS` (`true` to skip AWS/Azure/Vault registration), `WRITABLE_SECRET` |

`WRITABLE_SECRET` is an opt-in: only the provider matching its prefix is allowed to write, and the package issues a write probe at init time to validate.

## Development

```bash
# Standard org/util workflow
npm run build         # lint + tsc
npm run lint
npm run test          # alias for test:unit
npm run test:unit     # mocha; uses CACHE_TIMEOUT_SECONDS=5
npm run test:integration  # requires live AWS/Vault/Azure credentials
npm run clean
```

Build is plain TypeScript — no OpenAPI codegen, no `redocly`, no `hub-generator`. The `SecretNode` model lives at `src/SecretNode.ts` as hand-written code.

## Architectural Constraints

These have caused real bugs. Don't violate them.

1. **No `@auditlogic/module-*` imports.** This package was extracted specifically to remove that dependency. AWS calls go through `AwsSecretsClient.ts`; Vault calls go through `VaultClient.ts`. SSM and Azure use their SDKs directly. If you need a new backend, follow the same pattern — write a thin client class, never re-introduce a module wrapper.

2. **Strict catch typing.** `useUnknownInCatchVariables` is on (TypeScript default). Don't add `: any` to catch parameters. Use `errorMessage(err)` from `common.ts`, or narrow with `err instanceof Error`. The helper is the standard pattern in this package.

3. **`SecretNode.TypeEnum` values are string literals.** Equality checks (`node.type === SecretNode.TypeEnum.Secret`) compare strings — the values are `'Node'` and `'Secret'`. Don't reintroduce opaque `EnumValue` wrappers or numeric enums; existing wire compatibility relies on string serialization.

4. **Vault is KV v2 only.** `VaultClient.getSecret` and `upsertSecret` hardcode `/{mount}/data/{path}` paths; `listSecrets` uses `/{mount}/metadata/{path}?list=true`. Don't add KV v1 support without explicit version detection — silently auto-detecting causes secret-loss bugs in the wild.

5. **Connect failures don't throw — they leave the manager inactive.** `SecretsManagerImpl.registerXProvider()` catches connect errors and stores them on the TreeNode's `connectError`. Consumers call `getRoot(provider)` which throws `InvalidStateError` if inactive. This pattern lets the manager partially come up when one backend is down. Preserve it.

6. **`WRITABLE_SECRET` is the only path that can write.** All other paths get `writable: false` on their TreeNode. The init-time write probe asserts this. Don't add bypass paths.

## Testing

- **Unit tests** (`test/unit/`) — exercise file/env nodes only; no live credentials needed. 24 tests, ~10s.
- **Integration tests** (`test/integration/`) — one suite per backend (`AwsIT`, `AwsSsmIT`, `VaultIT`, `AzureIT`). Each gracefully skips when its provider can't connect, so you can run the full suite even without all four sets of credentials.

When adding a backend, mirror the existing integration test pattern: register a `WRITABLE_SECRET` for that provider, init the manager, skip if inactive, then exercise list/get/set.

## History

- Originally lived at `com/hub/secrets-manager` as `@zerobias-com/hub-secrets-manager`.
- Migrated to `org/util/packages/secrets-manager` and renamed `@zerobias-org/util-secrets-manager` after the auditlogic-module removal.
- The OpenAPI-generated `SecretNode` model was replaced with a hand-written TS class. `api.yml`, `secrets-manager.yml`, and `generated/` are gone.
