# Org-Private Publish (`zbb publishOrg`) — End-to-End Reference

**Status:** as-built description of the code on disk, 2026-08-12.
**Scope:** the `-PorgPublish=true` path for a TypeScript connector module in
`zerobias-org/module`, from CLI invocation through to org-scoped rows in Postgres.
**Audience:** engineers who need to run, debug, or change this flow.

Everything below is traced from source. Every non-obvious claim carries a
`file:line` citation so it can be re-verified rather than trusted.

---

## Path conventions used in citations

| Prefix | Real path |
|---|---|
| `BT/` | `org/util/packages/build-tools/src/main/kotlin/` |
| `zbb/` | `org/util/packages/zbb/` |
| `module/` | `org/module/` |
| `devops/` | `org/devops/` |
| `platform/` | `com/platform/` |
| `dana/` | `com/dana/` |
| `hydra/` | `com/hydra/` |

All rooted at `~/nfa-repos/{org,com}/`.

---

## TL;DR

`zbb publishOrg` publishes an artifact that exists **only inside one
organization**. It is not a separate pipeline — it is the normal `publish` task
graph run in a different mode, selected by one Gradle property.

```
zbb publishOrg  →  ./gradlew publish -PorgPublish=true --console=plain
```

Three things are added (an admin precheck, an org-specific version resolver, a
catalog-load job) and eight things are removed (version bump, git commit, git
tag, both pushes, dist-tag promotion, the Slack release event, and the failure
rollback). npm publish and both container image pushes run **unchanged**.

The org identity travels in the **version string**:

```
1.2.5-rc.<orgId-hex32>.<n>
```

That string is not cosmetic. Server-side it is the authorization subject — the
platform extracts the org UUID from the version and checks that the calling
principal is an admin of that org. See §7.2.

**Current state: this path cannot succeed in `zerobias-org/module` today.** No
package under `module/package/` declares `zerobias.orgId`, so `verifyOrgPublish`
fails immediately for every module. See §11.

---

## 1. Invocation and command resolution (zbb layer)

### 1.1 What zbb actually does

`zbb publishOrg` is a first-class lifecycle verb
(`zbb/lib/lifecycle.ts:28-33`), mapped in the consuming repo:

```yaml
# module/zbb.yaml:79-81
lifecycle:
  publish:     ./gradlew publish
  publishOrg:  ./gradlew publish -PorgPublish=true
```

The CLI performs **no publishing logic of its own**. It resolves an environment,
then spawns exactly one child process and exits with its code:

```js
// zbb/lib/standardLifecycle.ts:203-208
spawn('bash', ['-c', './gradlew publish -PorgPublish=true --console=plain'], {
  cwd: repoRoot, stdio: 'inherit', env: process.env, detached: true
})
```

`stdio: 'inherit'` — no output parsing, no TUI (publish verbs are excluded from
the display-eligible set at `standardLifecycle.ts:129`), no retry. Nothing runs
after the child exits.

### 1.2 Blocking preconditions before the spawn

1. **`ZB_SLOT` must be set** — otherwise `Not inside a loaded slot. Run: zbb slot load <name>` (`zbb/lib/cli.ts:611`)
2. **A matching stack must be added to the slot** — resolved against `@zerobias-org/module` or the short name `module` (`zbb/lib/cli.ts:621-642`)

Not checked at all: node version, Java version, git dirty/branch/tag state,
token validity. The `tools: [dataloader]` gate in `module/zbb.yaml` is attached
only to `test` and `gate`; `publish` and `publishOrg` are plain string entries,
so `owner.tools` is `undefined` and the entire gate block at `cli.ts:713` is
skipped. **Org publish runs with zero tool/env gate checks at the CLI layer.**

### 1.3 Environment resolution

`prepareSlot(slot, { fatal: false, stack, command: 'publishOrg' })` — `cli.ts:669`:

1. **DNS TXT slot resolution** — silent no-op unless `SLOT_RESOLVE_HOST` is set (`zbb/lib/slot/Slot.ts:210-235`)
2. **Vault refresh** — scans only `module/zbb.yaml`'s `env:` block (`zbb/lib/env/Scanner.ts:26-49`). Fetch decision at `zbb/lib/stack/refresh.ts:103-106`: fetch iff `refresh === true` **or** the value is currently undefined.
   - `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` carry `refresh: true` → **re-fetched from Vault on every invocation**
   - `NEON_API_KEY` / `NEON_PROJECT_ID` → fetched only on first use
   - Vault token comes from `~/.vault-token` first, then `$VAULT_TOKEN` (`zbb/lib/env/VaultResolver.ts:25-38`). **`ZB_TOKEN` is not a Vault credential** — it is a plain declared var with no `source`.
   - There is no time-based TTL. Both AWS creds share one HTTP call (cached by path, `VaultResolver.ts:56,113`).
   - **Vault failure is non-fatal** — `fatal: false` means publish proceeds with whatever values exist, possibly empty AWS creds (`cli.ts:669`, `refresh.ts:117-124`).
3. **Hermetic seal** (`zbb/lib/env/effective.ts:206-248`) — every `process.env` key not in the resolved stack env, not in `SYSTEM_BASE`, and not in `PUBLISH_CONTRACT` is deleted. Disabled when `CI`/`GITHUB_ACTIONS` is set, or via `ZBB_HERMETIC=0`.
4. **Gradle daemon drift check** — daemons whose captured env no longer matches the stack are SIGTERM'd. Linux only, advisory (`zbb/lib/gradleDaemon.ts:61-131`).

`publishOrg` maps to the **full** `PUBLISH_CONTRACT`, not a narrowed one. The
comment at `effective.ts:100-106` explains why: a narrower contract stripped the
AWS/ECR vars that `preflightChecks` and `publishImageEcr` hard-require.

### 1.4 Scoping

There is no `--scope` flag and no `--changed` flag — neither string exists in the
CLI. Scope is implicit from the working directory
(`zbb/lib/standardLifecycle.ts:260-337`):

| cwd | Resulting command |
|---|---|
| repo root | `./gradlew publish -PorgPublish=true` (all packages) |
| `package/avigilon/alta/access` | `./gradlew :avigilon:alta:access:publish -PorgPublish=true` |
| a dir with `package.json` but no `build.gradle.kts` | hard error, exit 1 (`:294-301`) |
| a dir with `build.gradle.kts` not in `settings.gradle.kts` | hard error, exit 1 (`:326-332`) |

Recognized flags: `--dry-run`, `--force`, `--clean`, `--verbose`, `--modules`,
`--no-push`, `--version-committed` (`-PversionAlreadyCommitted=true`) and
`--force-direct` (`-Pdataloader.forceDirect=true`). The last two are standard
mode only; a monorepo refuses them. Anything else lands in `parsed.remaining`
and is forwarded verbatim to Gradle (`zbb/lib/lifecycle.ts`).

> **Note.** The "publish must run from the monorepo root" refusal at
> `cli.ts:577-584` is keyed on the literal string `'publish'` **and** only fires
> in monorepo mode. `module` is in standard mode, so neither `publish` nor
> `publishOrg` is blocked from a package subdirectory.

### 1.5 Version caveat

There is a version skew worth checking before debugging behavior:

- source in `org/util` is **1.0.8**
- the globally installed CLI may be **1.0.7**, whose `LIFECYCLE_COMMANDS` lacks `publishOrg`

In 1.0.7 the dispatcher still runs (the owner is non-fallback, so the guard
passes) and lands on the custom-verb branch — producing the **same command
line** — but with a narrower env passthrough. For `module` this barely matters
because `AWS_*`/`ECR_*`/`GHCR_*` are declared in its own `env:` block and
therefore survive the seal as effective env. Run `npm i -g @zerobias-org/zbb`
before relying on 1.0.8 semantics.

---

## 2. Gradle configuration time

Three decisions, all made before any task runs.

| Value | Org-mode result | Citation |
|---|---|---|
| `isOrgPublish` | `project.findProperty("orgPublish") == "true"` | `BT/zb.base.gradle.kts:404` |
| `extra["isOrgPublish"]` | exported to flavor plugins | `zb.base:405` |
| `changedSinceTag` | **forced `true`** — an unchanged package still publishes | `zb.base:427-429` |

The org wiring block, verbatim (`zb.base:1404-1419`):

```kotlin
if (isOrgPublish) {
    // Fail before gate: a missing orgId or a non-admin token should cost
    // seconds, not a full validate/build/test/dataloader cycle.
    gate.configure { dependsOn(verifyOrgPublish) }

    publishAll.configure { dependsOn(resolveOrgVersion) }
    listOf("publishNpm", "publishImage", "publishSdk", "publishHubSdk").forEach { taskName ->
        tasks.named(taskName) { mustRunAfter(resolveOrgVersion) }
    }

    // The catalog load runs LAST, after publishAll — which includes
    // publishImage.
    dataloaderOrgJob.configure { mustRunAfter(publishAll) }
}
```

and `zb.base:1832-1833`:

```kotlin
if (isOrgPublish) {
    publish.configure { dependsOn(dataloaderOrgJob) }
} else { /* catalog wiring */ }
```

**Guard on the alias.** `./gradlew publishOrg` **without** the property hard-fails
at `gradle.taskGraph.whenReady` (`zb.base:1838-1846`) rather than silently
performing a public release.

**Gate stamp evaluation** happens in the same `whenReady` hook
(`zb.base:1244-1316`). With a `VALID` stamp, every task in
`testAndValidationTasks` plus `gate` and `writeGateStamp` is set
`enabled = false` (`:1255-1265`, `:1289-1290`). With `INVALID` under `CI=true` it
throws before anything runs (`:1310`). The comment at `:1245-1247` notes
`publishOrg` needs no special handling because it depends on `publish`.

---

## 3. Task graph

### 3.1 What actually executes

Main branch, non-dry-run, TypeScript connector module, valid gate stamp:

| # | Task | Registration / gate |
|---|---|---|
| 1 | **`verifyOrgPublish`** | `zb.base:1370-1372`; pulled in by `gate.dependsOn` at `:1407`. Runs even though `gate` is disabled — Gradle still executes the dependencies of a disabled task. |
| 2 | `verifyNoLocalRegistry` | `zb.base:135-170`; direct dependency of both `gate` (`:943`) and `publish` (`:1816`) |
| 3 | **`resolveOrgVersion`** | `zb.base:1374-1384`; `doLast` assigns `project.version = orgVersion.get()` (`:1381`) |
| 4 | `preflightChecks` | `zb.base:493-800`, `onlyIf { !isDryRun }` (`:501`) |
| 5 | `patchPackageJson` | `zb.typescript:1156-1169` — writes the org rc version to disk |
| 6 | `flattenConnectionProfileForPublish` | `zb.typescript:1199-1229`, `onlyIf { hasConnectionProfile }` |
| 7 | **`publishNpmExec`** | `zb.typescript:1301-1331` |
| 8 | `restorePackageJson` | `zb.typescript:1137-1154`, finalizer of #5 (`:1162`) |
| 9 | `restoreConnectionProfile` | `zb.typescript:1184-1197`, finalizer of #6 (`:1204`) |
| 10 | `publishNpm` (aggregator) | `zb.base:1319-1323`; passes `onlyIf { changedSinceTag }` (`:1426-1435`) |
| 11 | `ensureEcrRepo` | `zb.typescript:1967-1982`, `onlyIf { !isInterface && hasConnectionProfile && !isDryRun }` |
| 12 | **`publishImageEcr`** | `zb.typescript:1985-2023` |
| 13 | **`publishImageGhcr`** | `zb.typescript:2026-2063`, `dependsOn(buildImage, publishImageEcr, preflightChecks)` |
| 14 | `publishImage` (aggregator) | `zb.base:1325-1330` |
| 15 | **`publishHubSdkExec`** | `zb.typescript:1911-1952`; `mustRunAfter(publishNpmExec)` (`:1959`) |
| 16 | `restoreHubSdkPackageJson` | `zb.typescript:1898-1909`, finalizer (`:1915`) |
| 17 | `publishHubSdk` / `publishSdk` | aggregators, `zb.base:1332-1342` |
| 18 | `publishAll` | `zb.base:1393-1397`; `doLast` sets `publishAllSucceeded = true` (`:1448-1460`) |
| 19 | `dispatchGenerateKb` | `zb.typescript-connector.gradle.kts:52-123` — executes, then self-aborts (§10.1) |
| 20 | **`dataloaderOrgJob`** | `zb.base:1386-1391`; last real work |
| 21 | `publish` | `zb.base:1813-1817` |

### 3.2 Disabled in org mode

| Task | Disabling condition | Citation |
|---|---|---|
| `bumpVersion` | `onlyIf { … && !isOrgPublish }` | `zb.base:336` |
| `resolvePublishVersion` | `onlyIf { branch != "main" && branchSuffix != null && !isOrgPublish }` | `zb.base:1354` |
| `commitVersion` | `onlyIf { … && !isOrgPublish }` | `zb.base:1557` |
| `tagVersion` | `onlyIf { … && !isOrgPublish }` | `zb.base:365` |
| `pushVersion` | `onlyIf { … && !isOrgPublish }` | `zb.base:1684` |
| `pushTag` | `onlyIf { … && !isOrgPublish }` | `zb.base:1792` |
| `publishReleaseEvent` (Slack) | `onlyIf { … && !isOrgPublish }` | `zb.base:1638` |
| `promoteAll` | `if (isOrgPublish) return@onlyIf false` | `zb.base:1516-1519` |
| `promoteNpm` / `promoteHubSdk` / `promoteSdk` | `if (isOrgPublish) return@onlyIf false` | `zb.typescript:2197-2200` |
| `buildFinished` rollback | `if (!isDryRun && branch == "main" && !isOrgPublish …` | `zb.base:1470` |

Because `promoteAll` is skipped, `promoteAllSucceeded` stays `false` — it is only
set inside `promoteAll.doLast` (`zb.base:1535`) — so the tag/push/announce tasks
are doubly gated.

Also skipped, but **not** for org-specific reasons:

- `publishSdkExec` — `onlyIf { hasOpenApiSdk }`, default `false` (`zb.base:25`, `zb.typescript:1845`)
- `generateShrinkwrap` / `cleanupShrinkwrap` — require `npm-shrinkwrap.json` in the package's `files` array (`zb.typescript:1249,1260-1266`); no `module` package declares it
- `gate`, `writeGateStamp`, all validate/lint/test/build tasks — valid gate stamp (`zb.base:1284-1290`)

**Net effect: no git side effects whatsoever.** No commit, no tag, no push,
nothing promoted off a dist-tag, nothing announced to Slack.

### 3.3 `preflightChecks` is NOT weakened

This is the most common practical surprise. `preflightChecks` contains no
`isOrgPublish` branch. An org publish still hard-requires the full production
publishing toolchain:

| Check | Citation | Failure mode |
|---|---|---|
| `NPM_TOKEN` set | `zb.base:518-521` | fail |
| version not `unspecified` | `:525-527` | fail |
| **dirty git tree** | `:530-538` | **warning only, never fails** |
| docker daemon running | `:544-557` | fail |
| buildx advertises amd64 + arm64 | `:560-575` | fail |
| live arm64 exec probe — `docker run --platform linux/arm64 alpine:3 /bin/true` | `:585-608` | fail |
| `ECR_REGISTRY` + `AWS_REGION` set | `:611-618` | fail |
| `aws sts get-caller-identity` | `:620-633` | fail |
| `aws ecr get-login-password` → `docker login` | `:636-657` | fail |
| ECR `describe-repositories` / `batch-check-layer-availability` probes | `:659-707` | fail |
| `GHCR_REGISTRY` set + `docker login ghcr.io` | `:709-731` | fail |
| `npm whoami --registry <first registry= in .npmrc>` | `:737-765` | fail |
| already-published check | `:767-783` | warning only |
| `.npmrc` present in package dir | `:785-796` | fail |

The docker/ECR/GHCR blocks (rows 4–11) are skipped when the module is
interface-only or has no `connectionProfile.yml` (`:541`). Everything is skipped
under `-PdryRun=true` (`:501`).

---

## 4. `verifyOrgPublish` — the admission gate

`BT/com/zerobias/buildtools/tasks/VerifyOrgPublishTask.kt:26-68`, in full:

```kotlin
abstract class VerifyOrgPublishTask : DefaultTask() {

    @get:InputDirectory
    abstract val packageDir: DirectoryProperty

    init {
        group = "publish"
        description = "Verify org-private publish preconditions (orgId declared, principal is org admin)"
        // Talks to dana; never safe to consider up-to-date from a prior run.
        outputs.upToDateWhen { false }
    }

    @TaskAction
    fun execute() {
        val pkgDir = packageDir.get().asFile
        val token = OrgPublish.requireToken(name)
        val pkgRaw = OrgPublish.readPackageJson(name, pkgDir)
        val orgId = OrgPublish.readOrgId(name, pkgRaw)

        logger.lifecycle("$name: orgId = $orgId")
        logger.lifecycle("$name: verifying principal is admin of $orgId...")

        val whoAmI = OrgPublish.curlGet(
            name,
            "${OrgPublish.platformUrl()}/dana/me",
            listOf(
                "-H", "Authorization: APIKey $token",
                "-H", "dana-org-id: $orgId",
                "-H", "Accept: application/json"
            ),
            pkgDir,
        ) { msg -> logger.lifecycle(msg) }

        when (PackageJsonReader.extractBoolean(whoAmI, "isAdmin")) {
            null -> throw GradleException(
                "$name: dana /me response does not include `isAdmin`. " +
                "Deployed dana may be older than this feature; upgrade before publishing to an org."
            )
            false -> throw GradleException("$name: principal is not an admin of org $orgId.")
            true -> logger.lifecycle("$name: principal is an admin of $orgId.")
        }
    }
}
```

### 4.1 The HTTP request

`OrgPublish.curlGet` (`OrgPublish.kt:249-260`) builds
`["curl","-s","--fail-with-body"] + headers + [url]`; `CurlUtils.withRetry`
(`BT/com/zerobias/buildtools/util/CurlUtils.kt:49-58`) splices its own flags in
after `curl`. The effective command:

```bash
curl --show-error --retry 5 --retry-delay 2 -s --fail-with-body \
  -H "Authorization: APIKey $ZB_TOKEN" \
  -H "dana-org-id: <orgId>" \
  -H "Accept: application/json" \
  https://app.zerobias.com/api/dana/me
```

- **Method:** GET (no `-X`)
- **Working directory:** the package dir (`VerifyOrgPublishTask.kt:56`)
- **Timeouts: none.** No `--max-time`, no `--connect-timeout`, no Kotlin-side deadline anywhere in `CurlUtils.kt` or `OrgPublish.kt`. **A hung dana blocks the build indefinitely.**
- **Redirects: not followed.** No `-L`. `--fail-with-body` only fails on ≥400 (`CurlUtils.kt:126`), so a 301/302 returns exit 0 with the redirect body → no `isAdmin` found → the "does not include `isAdmin`" failure.
- **Retries:** outer loop of 5 (`CurlUtils.kt:46,66`), backoff `(1000L * (1 shl attempt)) + Random.nextLong(500L, 1500L)` ms (`:106`) ≈ 2.5s / 4.5s / 8.5s / 16.5s — plus curl's own `--retry 5 --retry-delay 2` for transient 5xx/429/connection errors.
- **401/403 fast-fail** (`:92-103`), matched by substring `"error: 401"` in stderr or `"\"statusCode\":401"` in stdout.

### 4.2 URL derivation

```kotlin
// OrgPublish.kt:60-63
fun platformUrl(): String =
    (System.getenv("ZB_PLATFORM_URL")?.takeIf { it.isNotBlank() }
        ?: DEFAULT_PLATFORM_URL).trimEnd('/')
```

`DEFAULT_PLATFORM_URL = "https://app.zerobias.com/api"` (`:46`). Note
`System.getenv` reads the **Gradle daemon's** environment, not the shell's, if a
daemon is reused.

### 4.3 Token

```kotlin
// OrgPublish.kt:73-75
fun requireToken(taskName: String): String =
    System.getenv("ZB_TOKEN")?.takeIf { it.isNotBlank() }
        ?: throw GradleException("$taskName: ZB_TOKEN must be set.")
```

### 4.4 Response parsing

Exactly one field, by regex — `PackageJsonReader.kt:40-43`:

```kotlin
fun extractBoolean(json: String, field: String): Boolean? {
    val m = Regex(""""$field"\s*:\s*(true|false)\b""").find(json) ?: return null
    return m.groupValues[1] == "true"
}
```

`find` — the **first** `isAdmin` anywhere in the payload, at any nesting depth.

### 4.5 Failure messages

| Message | Trigger | Citation |
|---|---|---|
| `verifyOrgPublish: ZB_TOKEN must be set.` | env unset or blank | `OrgPublish.kt:75` |
| `verifyOrgPublish: package.json not found at <abs>` | no package.json in packageDir | `OrgPublish.kt:81` |
| ``package.json must declare `zerobias.orgId` (or legacy `auditmation.orgId`).`` | neither section has orgId | `OrgPublish.kt:89-91` |
| `zerobias.orgId "<x>" is not a valid UUID.` | fails `UUID_RE.matches` | `OrgPublish.kt:93` |
| `… returned 401 Unauthenticated. Token may be invalid, expired, or for the wrong environment.` | detected in curl output | `CurlUtils.kt:93-97` |
| `… returned 403 Forbidden. Principal authenticated but lacks permission for this endpoint.` | detected in curl output | `CurlUtils.kt:98-102` |
| `verifyOrgPublish: GET <url> failed after 5 attempts:\n…` | any other non-zero curl exit | `CurlUtils.kt:112` |
| ``dana /me response does not include `isAdmin`. Deployed dana may be older than this feature; upgrade before publishing to an org.`` | regex found nothing | `VerifyOrgPublishTask.kt:60-63` |
| `principal is not an admin of org <orgId>.` | `isAdmin: false` | `VerifyOrgPublishTask.kt:64` |

`CurlUtils.curlExitMeaning` (`:121-133`) adds plain-English hints for curl exits
3, 6, 7, 22, 28, 35, 52, 56, 60.

### 4.6 Server side — what `/dana/me` actually computes

| Layer | Location |
|---|---|
| OpenAPI fragment | `dana/app/src/api/me.yml:1-15` — `operationId: whoAmI` |
| Base path `/dana` | `dana/app/src/server.ts:44-45` |
| Express route | `dana/app/generated/server/MeApiController.ts:41`, handler `:289-300` |
| Implementation | `dana/app/src/producers/MeProducerImpl.ts:50-73` |

```ts
// MeProducerImpl.ts:60-71
const requestorInfo: WhoAmI = { ...data, isAdmin: false, ... };
if (this.context.org) {
  requestorInfo.isAdmin = await this.context.principalDao.isOrgAdmin(data.id, this.context.org.id);
}
```

backed by `isOrgAdmin.sql:1-5` in `@zerobias-com/hydra-dao`:

```sql
SELECT exists(select principal_id from hydra.group_member
  where principal_id = ${principalId}
  and group_id = (select admin_group_id from hydra.org where id = ${orgId}));
```

**`isAdmin` is org admin-group membership and nothing else.** Not a role enum,
not a scope, not a column on `hydra.org`. **Superuser is not OR'd in** — contrast
`dana/app/src/common.ts:42-49` where `canWriteOrg = token.superuser || isOrgAdmin`.
The subject is `owner?.id || token.principal.id` (`MeProducerImpl.ts:51-57`) — for
API-key auth that is the **owning user**, not the key.

The response (`WhoAmI` = `ExtendedWhoAmIInfo` + `oneOf(User, ServiceAccount)`,
`dana/app/dana.yml:2471-2477`) contains **no orgId**, so the caller cannot see
which org `isAdmin` was computed against.

`dana-org-id` handling (`dana/app/src/constants.ts:2`,
`dana/app/src/RequestContext.ts:235-243`): **query param first**, then header,
then org-by-hostname (`:245-251`), then AppInstance contract (`:253-267`).
Membership is validated in the proxy, not the producer —
`dana/app/src/proxy.ts:557-559`:

```ts
if (orgId && !await ctx.principalDao.isInOrg(accessPrincipal.id, orgId)
         && !await ctx.principalDao.isSuperuser(accessPrincipal.id)) {
  throw new ForbiddenError();
}
```

If the header is omitted, dana **auto-selects** an org (JWT `requestOrg`, else
email-domain match, else `memberOrgs[0]`) at `proxy.ts:560-611` — so `/me` still
returns an `isAdmin`, silently computed against a dana-chosen org.

**Auth schemes accepted** (`proxy.ts:388-466`): `APIKey <key>` (sha512 →
`getApiKeyByHash`), `Bearer <jwt>` (RS256, dana's own key, issuer `Dana`,
3-minute expiry — `dana/app/src/services/AuthService.ts:61-99,165-167`),
`Session <id>`, or a `dana-session-id` cookie. The gradle task uses **`APIKey`**,
which matches the official SDK (`@zerobias-com/dataloader-sdk/dist/api/index.js:28-41`).

Failure responses: **400** malformed `Authorization` (`proxy.ts:382-386,463-466`)
or non-UUID `dana-org-id` (`RequestContext.ts:235-241`); **401** no credential
(`:495-497`), invalid/expired bearer (`:417-421`), disabled/expired API key
(`AuthService.ts:109-119`), disabled principal (`:528-531`), principal in no orgs
(`:573-576`); **403** not a member of the requested org (`:557-559`), JWT
`requestOrg` not a member org (`:561-565`), outstanding EULA (`:543-554`);
**404** org id points at a nonexistent org (`RequestContext.ts:269-271`).

### 4.7 orgId read path

```kotlin
// OrgPublish.kt:86-96
fun readOrgId(taskName: String, pkgRaw: String): String {
    val orgId = PackageJsonReader.extractZerobiasOrgId(pkgRaw)
        ?: throw GradleException(
            "$taskName: package.json must declare `zerobias.orgId` (or legacy `auditmation.orgId`)."
        )
    if (!UUID_RE.matches(orgId)) {
        throw GradleException("$taskName: zerobias.orgId \"$orgId\" is not a valid UUID.")
    }
    return orgId
}
```

```kotlin
// PackageJsonReader.kt:73-78
fun extractZerobiasOrgId(pkgRaw: String): String? {
    val zerobias = Regex(""""zerobias"\s*:\s*\{[^}]*?"orgId"\s*:\s*"([^"]+)"""")
    zerobias.find(pkgRaw)?.let { return it.groupValues[1] }
    val auditmation = Regex(""""auditmation"\s*:\s*\{[^}]*?"orgId"\s*:\s*"([^"]+)"""")
    return auditmation.find(pkgRaw)?.groupValues?.get(1)
}
```

`[^}]*?` **cannot cross a `}`** — an `orgId` placed after a nested object inside
the `zerobias` block will not be found. The doc comment at `:69-71` states this
limitation explicitly.

```kotlin
// OrgPublish.kt:48-51
val UUID_RE = Regex(
    "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    RegexOption.IGNORE_CASE
)
```

`.matches()` = full-string. **No UUID version/variant nibble check** — any hex
string of that shape passes.

The hex32 form used in the version comes from
`PackageJsonReader.stripUuidHyphens` (`:104-105`):
`uuid.replace("-", "").lowercase()`.

`readOrgId` is called from exactly two places — `VerifyOrgPublishTask.kt:43` and
`ResolveOrgVersionTask.kt:56`. **`DataloaderOrgJobTask` never reads or validates
orgId**; it sends only name + version.

---

## 5. `resolveOrgVersion` — version math

```kotlin
// OrgPublish.kt:177-198
fun computeOrgVersion(
    taskName: String,
    pkgVersion: String,
    orgIdStripped: String,
    maxOwnIncrement: Int?,
): String {
    val semverMatch = PLAIN_SEMVER_RE.matchEntire(pkgVersion)
        ?: throw GradleException(
            "$taskName: package.json version \"$pkgVersion\" must be plain semver " +
            "(no prerelease/build metadata)."
        )
    val bumpedPatch = "${semverMatch.groupValues[1]}." +
        "${semverMatch.groupValues[2]}." +
        "${semverMatch.groupValues[3].toInt() + 1}"
    val nextIncrement = if (maxOwnIncrement == null) 0 else maxOwnIncrement + 1
    return "$bumpedPatch-rc.$orgIdStripped.$nextIncrement"
}
```

- **Base X.Y.Z** comes from `PackageJsonReader.extractString(pkgRaw, "version")` (`ResolveOrgVersionTask.kt:53-54`) — the **on-disk package.json**, not `project.version` and not a git tag.
- `PLAIN_SEMVER_RE = Regex("""(\d+)\.(\d+)\.(\d+)""")` (`OrgPublish.kt:52`) with `matchEntire` — so `2.0.6-uat.0` is rejected with the "must be plain semver" message. **Org publish only works from a clean semver base**, i.e. effectively from `main`.
- **Why Z+1** (`:178-180`): "patch-bumped off the package.json version so the org line always sorts above the base version."
- **First-ever org publish gets `n = 0`, not 1** (`:196`).

### 5.1 The npm query

```kotlin
// OrgPublish.kt:98-124
fun npmViewVersions(pkgName: String, token: String, workingDir: File): List<String> {
    val npmrc = writeTempNpmrc(resolveNpmToken(token))
    try {
        val output = ExecUtils.execCapture(
            command = listOf(
                "npm", "view", pkgName, "versions", "--json",
                "--registry", registryUrl(),
                "--userconfig", npmrc.absolutePath
            ),
            workingDir = workingDir,
            throwOnError = false
        )
        val trimmed = output.trim()
        if (trimmed.isEmpty()) return emptyList()
        // npm view on a missing package writes an E404 error message to stdout …
        if (trimmed.contains("E404") || trimmed.contains("\"code\": \"E404\"")) return emptyList()
        return parseVersionsArray(trimmed)
    } finally {
        try { npmrc.delete() } catch (_: Exception) { /* ignore */ }
    }
}
```

Registry queried = `registryUrl()` (`:56-58`) =
`PUBLISH_ORG_REGISTRY_URL` ?: **`https://pkg.zerobias.org`** — **not** the
package's `publishConfig.registry`. `throwOnError = false`, and
`ExecUtils.execCapture` returns **stdout only** (`ExecUtils.kt:63-64,76-83`) —
stderr is discarded.

```kotlin
// OrgPublish.kt:126-134
private fun parseVersionsArray(stdout: String): List<String> {
    if (stdout.startsWith("[")) {
        return Regex(""""([^"]+)"""").findAll(stdout).map { it.groupValues[1] }.toList()
    }
    if (stdout.startsWith("\"")) {
        return Regex(""""([^"]+)"""").find(stdout)?.let { listOf(it.groupValues[1]) } ?: emptyList()
    }
    return emptyList()
}
```

Array form → every quoted token. Single-version string form → the one token.
Anything else — including a JSON object or an error object — → empty list.

### 5.2 Existing-version classification

```kotlin
// OrgPublish.kt:136-175
fun classifyExistingVersions(
    taskName: String,
    pkgName: String,
    versions: List<String>,
    orgIdStripped: String,
): Int? {
    if (versions.isEmpty()) return null
    var maxOwn = -1
    for (v in versions) {
        if (PLAIN_SEMVER_RE.matches(v)) {
            throw GradleException(
                "$taskName: artifact \"$pkgName\" already has catalog versions (e.g. $v). " +
                "Org publish is for artifacts that exist only inside your org."
            )
        }
        val m = RC_VERSION_RE.matchEntire(v)
            ?: throw GradleException(
                "$taskName: artifact \"$pkgName\" has existing version \"$v\" that doesn't fit the " +
                "org-publish format. Org publish is for artifacts that exist only inside your org."
            )
        val hex = m.groupValues[1].lowercase()
        val inc = m.groupValues[2].toInt()
        if (hex != orgIdStripped) {
            throw GradleException(
                "$taskName: artifact \"$pkgName\" is already owned by a different org (version $v). " +
                "Org publish cannot reuse names owned by other orgs."
            )
        }
        if (inc > maxOwn) maxOwn = inc
    }
    return maxOwn
}
```

`RC_VERSION_RE = Regex("""\d+\.\d+\.\d+-rc\.([0-9a-f]{32})\.(\d+)""")` (`:53`).

Three rejection cases, **any one of which aborts the whole publish**:

1. any plain-semver version present → *"already has catalog versions"*
2. any version matching neither shape → *"doesn't fit the org-publish format"*
3. an rc version whose hex ≠ this org → *"already owned by a different org"*

The invariant being enforced: **a package name is either catalog-owned or
owned by exactly one org, forever.**

### 5.3 Log output

`ResolveOrgVersionTask.kt:45-73`:

```
<task>: classifying existing versions of <pkgName> in https://pkg.zerobias.org...
<task>: no existing versions — brand new.
   (or) <task>: N existing org-owned version(s); max increment = M.
<task>: resolved org version = 1.2.5-rc.<hex32>.0
```

Assignment happens at the registration site: `project.version = orgVersion.get()`
(`zb.base:1381`).

---

## 6. `publishAll` in org mode

### 6.1 npm arguments

```kotlin
// OrgPublish.kt:200-218
fun npmPublishArgs(isOrgPublish: Boolean): List<String> {
    if (!isOrgPublish) return listOf("--tag", "next")
    val override = System.getenv("PUBLISH_ORG_REGISTRY_URL")?.takeIf { it.isNotBlank() }
    return if (override != null) listOf("--registry", override.trimEnd('/')) else emptyList()
}
```

Rationale at `:200-212`: an org publish "is never promoted, so it takes no
dist-tag at all."

Spliced in via gradle-node-plugin's `NpmTask`
(`com.github.node-gradle:gradle-node-plugin:7.1.0`,
`build-tools/build.gradle.kts:124`), which runs `npm` + `npmCommand` + `args`:

| Task | `npmCommand` | `args` (org mode) | `workingDir` | Effective command |
|---|---|---|---|---|
| `publishNpmExec` (`zb.typescript:1301-1311`) | `listOf("publish")` `:1309` | `[]` or `--registry <url>` `:1310` | `project.projectDir` `:1311` | `npm publish` |
| `publishHubSdkExec` (`:1911-1919`) | `listOf("publish")` `:1917` | same `:1918` | `project.file("hub-sdk")` `:1919` | `npm publish` |
| `publishSdkExec` (`:1841-1851`) | `listOf("publish")` `:1848` | same `:1849` | `project.file("sdk")` `:1851` | **never runs** — `onlyIf { hasOpenApiSdk }` `:1845`, default `false` (`zb.base:25`) |

**By default no `--registry` and no `--userconfig` are passed to `npm publish`.**
Registry resolution falls entirely to npm's own precedence.

### 6.2 Where the packages actually land

| Artifact | Registry decided by | Current value |
|---|---|---|
| `package/avigilon/alta/access` | `publishConfig.registry` (`package.json:15-17`) | `https://npm.pkg.github.com/` |
| `package/interface/dataproducer` | `publishConfig.registry` | `https://npm.pkg.github.com/` |
| `package/readyplayerme/readyplayerme` | `publishConfig.registry` | `https://pkg.zerobias.org/` |
| `package/hl7/v2` | no `.npmrc` at all | — |
| `hub-sdk/` (any package) | user-level `.npmrc` scope map — `hub-sdk/package.json` has `publishConfig: { access: "restricted" }` with **no registry**, and there is no `.npmrc` inside `hub-sdk/` | `https://pkg.zerobias.org` |

`module/.npmrc:1-6` (copied verbatim into each package dir by CI) maps all five
scopes to `https://pkg.zerobias.org` and carries auth **only for that host**:
`//pkg.zerobias.org/:_authToken=${ZB_TOKEN}`. **There is no
`//npm.pkg.github.com/:_authToken=` line anywhere in the repo.**

`module/gradle.properties:9` `npmRegistry=https://npm.pkg.github.com/` is **dead
config** — read by no plugin and by no part of zbb.

See §10.6 for the three-registry inconsistency this produces.

### 6.3 The temp `.npmrc`

```kotlin
// OrgPublish.kt:220-247
fun writeTempNpmrc(token: String): File {
    val path = Files.createTempFile(".npmrc-org-publish-", ".tmp")
    try {
        Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"))
    } catch (_: Exception) { /* best effort */ }
    val authHost = registryUrl()
        .removePrefix("https://").removePrefix("http://").trimEnd('/')
    Files.writeString(
        path,
        """
            //$authHost/:always-auth=true
            //$authHost/:_authToken=$token
        """.trimIndent() + "\n"
    )
    return path.toFile()
}
```

JVM temp dir, mode `rw-------`, two lines scoped to the target host only —
deliberately **not** the scope mappings (`:222-226`). Cleanup is best-effort in a
`finally` block (`:121-123`); it leaks the file if the JVM dies mid-task.

**It is used exclusively by `npmViewVersions` (`:103`, the sole call site) —
never by any publish.**

### 6.4 Container images run unchanged

Neither `onlyIf` mentions `isOrgPublish`:

| Task | `onlyIf` | Citation |
|---|---|---|
| `ensureEcrRepo` | `!isInterface && hasConnectionProfile && !isDryRun` | `zb.typescript:1970` |
| `publishImageEcr` | `!isInterface && hasConnectionProfile` | `zb.typescript:1989` |
| `publishImageGhcr` | `!isInterface && hasConnectionProfile` | `zb.typescript:2030` |
| java equivalents | `hasConnectionProfile && !javaIsDryRun` / `hasConnectionProfile` | `zb.java-module.gradle.kts:127,148,176` |

**`zb.java-module.gradle.kts` contains zero `orgPublish` references.**

The only org effect is the **tag**, because both read `project.version` at
execution time after `resolveOrgVersion` has set it —
`val ver = project.version.toString().substringBefore("+")`
(`zb.typescript:1994`, `:2035`). Pushed refs:

```
${ECR_REGISTRY}/${dockerImageName}:1.2.5-rc.<hex32>.0
${GHCR_REGISTRY}/${dockerImageName}:1.2.5-rc.<hex32>.0
```

The image **name** derives from the npm package name (`zb.base:29-43`) and is
**not** rewritten in org mode. The build is
`docker buildx build --platform linux/amd64,linux/arm64 … --push`. GHCR auth uses
`NPM_TOKEN` as the password with the username hardcoded to `auditlogic`
(`zb.typescript:2045-2046,2055`).

The changed-since-tag guard on these tasks (`zb.typescript:2079-2094`) passes
trivially because org mode forces `changedSinceTag = true`.

Intent is explicit — `zb.base:1364-1369` and the "Belt-and-suspenders" comment at
`:1421-1424`: *"the org path cannot silently lose a step the catalog path has."*

---

## 7. `dataloaderOrgJob` — the catalog load

### 7.1 Client side

Registration (`zb.base:1386-1391`):

```kotlin
val dataloaderOrgJob by tasks.registering(DataloaderOrgJobTask::class) {
    packageDir.set(project.layout.projectDirectory)
    // project.version, not package.json — restorePackageJson has already put
    // the original version back on disk by the time this runs.
    artifactVersion.set(provider { project.version.toString() })
}
```

Ordering: `mustRunAfter(publishAll)` (`:1418`) and
`publish.configure { dependsOn(dataloaderOrgJob) }` (`:1833`) — strictly after
the npm publish **and** both image pushes.

Task action (`BT/com/zerobias/buildtools/tasks/DataloaderOrgJobTask.kt:45-70`):

```kotlin
@TaskAction
fun execute() {
    val pkgDir = packageDir.get().asFile
    val token = OrgPublish.requireToken(name)
    val pkgRaw = OrgPublish.readPackageJson(name, pkgDir)
    val pkgName = PackageJsonReader.extractString(pkgRaw, "name")
        ?: throw GradleException("$name: package.json missing 'name'.")
    val version = artifactVersion.get()

    logger.lifecycle("$name: queueing dataloader job for $pkgName@$version...")
    val body = """{"artifactName":${PackageJsonReader.jsonEscape(pkgName)},""" +
        """"artifactVersion":${PackageJsonReader.jsonEscape(version)}}"""
    val jobJson = OrgPublish.curlPost(
        name,
        "${OrgPublish.platformUrl()}/dataloader/jobs",
        body, token, pkgDir,
    ) { msg -> logger.lifecycle(msg) }

    val jobId = PackageJsonReader.extractString(jobJson, "id")
        ?: throw GradleException("$name: dataloader /jobs response missing 'id':\n$jobJson")
    logger.lifecycle("$name: job id = $jobId")

    pollJob(jobId, token, pkgDir)
}
```

The POST (`OrgPublish.curlPost`, `:262-280`, plus `CurlUtils` flags):

```bash
curl --show-error --retry 5 --retry-delay 2 -s --fail-with-body \
  -H "Authorization: APIKey $ZB_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -X POST \
  -d '{"artifactName":"@zerobias-org/module-avigilon-alta-access","artifactVersion":"1.2.5-rc.<hex32>.0"}' \
  https://app.zerobias.com/api/dataloader/jobs
```

Body is built by string concatenation with `PackageJsonReader.jsonEscape`
(`:94-95`), which escapes only `\` and `"`. **Exactly two fields — no orgId is
sent.** The service infers tenancy from the version shape
(`DataloaderOrgJobTask.kt:18-20`).

The polling loop (`:72-113`):

```kotlin
private fun pollJob(jobId: String, token: String, workingDir: java.io.File) {
    val url = "${OrgPublish.platformUrl()}/dataloader/jobs/$jobId"
    …
    while (true) {
        val resp = OrgPublish.curlGet(name, url,
            listOf("-H", "Authorization: APIKey $token", "-H", "Accept: application/json"),
            workingDir) { msg -> logger.lifecycle(msg) }

        val status = (PackageJsonReader.extractString(resp, "status") ?: "").lowercase()
        …
        if (status == "completed") { logger.lifecycle("$name: dataloader job completed in $elapsedStr."); return }
        if (status == "failed" || status == "errored") {
            PackageJsonReader.extractString(resp, "errorMessage")
                ?.let { logger.lifecycle("$name: error: $it") }
            throw GradleException("$name: dataloader job $status ($elapsedStr).")
        }
        Thread.sleep(POLL_INTERVAL_MS)
    }
}
```

- Poll interval `POLL_INTERVAL_MS = 10_000L` (`:116`); heartbeat log every `HEARTBEAT_INTERVAL_MS = 60_000L` (`:117`) while status is unchanged (`:96-99`)
- **`while (true)` — no max attempts, no overall timeout** (`:78`). Terminal values are exactly `completed`, `failed`, `errored`. Any other value — including the empty string produced when the regex fails (`:89`) — loops forever.
- **A failure fails the build** (`GradleException` at `:108`). Because this is the last task, npm artifacts and both container images are already published when it fires.
- Each individual poll GET is itself retried 5× by `CurlUtils.withRetry`; a 401/403 aborts immediately (`CurlUtils.kt:92-103`).

### 7.2 Server side — `POST /dataloader/jobs`

Service: `platform/dataloader-service/`. (`platform/image/dataloader-service/package/`
is a packed copy — identical source, different `package.json` version. Cite the
source tree.)

| Layer | Location |
|---|---|
| OpenAPI | `platform/dataloader-service/src/api/job.yml:61-84`, `operationId: queueJob` |
| Route | `generated/server/JobApiController.ts:29` — `POST {basePath}/jobs` |
| Implementation | `src/producers/JobProducerImpl.ts:34-81` |

The service serves `/jobs`; the `/dataloader` segment is added by the ingress
(`SERVICE_BASE_PATH` defaults to `''`, `src/server.ts:267`).

**Request body** — `QueueEventRequestBody`
(`src/api/schemas/dataloader/queueEventRequestBody.yml:1-19`), complete:

| Field | Type | Required | Nullable |
|---|---|---|---|
| `artifactName` | string | **yes** (the only required field) | no |
| `artifactVersion` | string | no | yes |
| `force` | boolean | no | yes |
| `forceDirect` | boolean | no | yes |
| `skipObjects` | boolean | no | yes |

**Response** — HTTP **200** (not 201), body `DataloaderEvent`
(`@zerobias-com/hydra-core/platform-models.yml:15780-15837`). Required fields:
`id` (**uuid — this is the job id; there is no `jobId` field in the body**),
`artifactName`, `artifactVersion`, `forceAll` (maps from request `force`),
`forceDirect`, `skipObjects`, `status`, `principalId`, `orgId`, `source`.
Optional/nullable: `queueDate`, `startDate`, `endDate`, `durationSeconds`,
`errorMessage`, `errorStack`.

**Authorization on create** (`JobProducerImpl.ts:34-81`) — this is the heart of
org publish:

1. `artifactName` must start with `@` → else `IllegalArgumentError` (**400**). Not expressed in the schema.
2. No JWT principal → **401**
3. **Non-superuser:** `artifactVersion` must parse as an org-rc version → else **403**
4. **Non-superuser:** must be `isOrgAdmin(principal.id, parsedOrgId)` → else **403**
5. **Non-superuser:** `force: true` is rejected → **403** (use `forceDirect`)

**The version string is the authorization subject** —
`platform/dataloader-service/src/util/orgVersion.ts:9-21`:

```ts
const ORG_VERSION_RE = /^(\d+\.\d+\.\d+)-rc\.([0-9a-f]{32})\.(\d+)$/;
export function parseOrgVersion(version: string): OrgVersionParts | null {
  const m = ORG_VERSION_RE.exec(version);
  if (!m) return null;
  const hex = m[2];
  const uuidStr = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  return { base: m[1], orgId: new UUID(uuidStr), increment: parseInt(m[3], 10) };
}
```

This regex matches the gradle producer format exactly. Two consumers, both
load-bearing:

- `JobProducerImpl.ts:47,58` — the authorization gate
- `DataloaderJobEventHandler.ts:113` — skips the content-master load for org-private versions

**Auth at the service.** The spec declares no header params and applies no
`security` (the `oauth2` scheme at `src/api/schemas/headers/components.yml:12-18`
is declared but never referenced; Redocly's `security-defined` rule is disabled
in `.redocly.yaml:15`). At runtime `Authorization` is mandatory
(`src/server.ts:128-144`), and in non-local mode the service does `jwt.decode`
**without signature validation** — it explicitly trusts that it sits behind dana
(`server.ts:178-191`). The service does **not** read `dana-org-id`; org context
comes from the JWT `requestOrg` claim (`src/ServerImpl.ts:583-585`), which dana
stamps.

### 7.3 Status state machine

Values are **lowercase**, exactly four
(`platform-models.yml:15870-15876`; Postgres enum
`hydra/schema/sql/baseline/platform/schema.sql:1232-1237`):

```sql
CREATE TYPE catalog.dataloader_event_status AS ENUM ('queued','running','failed','completed');
```

| Status | Terminal | Set by |
|---|---|---|
| `queued` | no | initial, `JobProducerImpl.ts:104` |
| `running` | no | `hydra/dao/sql/catalog/dataloader_event/setRunning.sql:3` |
| `completed` | yes | `setCompleted.sql:3` |
| `failed` | yes | `setFailure.sql:3` |

Transitions are unconditional `UPDATE … WHERE id` with no guard, driven by
`src/handlers/DataloaderJobEventHandler.ts:45,57,79`. There is no `PENDING`, no
uppercase variant, and no `error` or `cancelled`. **`errored` — which the gradle
poller checks for — does not exist**; harmless dead branch.

`queued → failed` also happens synchronously inside the POST if event publishing
fails (`JobProducerImpl.ts:134-140`), which then returns **500** rather than the
job.

`PUT /jobs` (replay, superuser only) can reopen a terminal job back to `queued`.

### 7.4 Polling endpoint

`GET /jobs/{jobId}` — path param is `jobId`, not `id`
(`src/api/job.yml:112-139`). Returns `DataloaderEventExtended` =
`DataloaderEvent` + required `principalName` and `orgName`
(`platform-models.yml:15838-15849`) — note the POST/GET response asymmetry.
Declares 403 and 404.

Authorization (`JobProducerImpl.ts:188-211`): superuser, else
`job.principalId === token.principal.id`, else 403.

`GET /jobs` (list) is **superuser-only** (`requireSuperuser()` at `:163`) — an org
admin can fetch by id but cannot list.

Jobs are hard-deleted after `DATALOADER_CLEANUP_DAYS` (default 7)
(`DataloaderJobEventHandler.ts:20,269`), so a poller can legitimately get a 404
for an id that was valid earlier.

### 7.5 What the job actually does

The loader is `@zerobias-com/platform-dataloader` = `platform/dataloader/`
(local, not a separate repo). Execution is **asynchronous**: the POST writes a
`queued` row then publishes a `base.DataloaderJob` event to **EventBridge → SQS
FIFO** (`JobProducerImpl.ts:83-124`;
`util/packages/events/src/producers/AWSEventProducer.ts:42-79`). The handler
`DataloaderJobEventHandler.ts:24` (`sqsQueueUrl = DATALOADER_JOB_QUEUE_URL`,
30-minute timeout) runs the loader **in-process** by synthesizing an argv
(`:33-54`). No Kafka, no NATS.

Stages:

1. `setRunning` (`DataloaderJobEventHandler.ts:45`)
2. **Registry resolve** — `npm view <pkg> dist-tags --json` / `versions --json` (`platform/dataloader/src/importer/ArtifactHandler.ts:225,287,305`). Version gating at `:374-472`: a `skip-dataloader` dist-tag aborts; an `-rc.*` older than the env tag is rejected.
3. **Download** — `npm pack <pkg>@<version>` into `temp-<ts>` (`ArtifactHandler.ts:498`), with `.npmrc` copied for auth (`:482-493`). No pacote, no direct tarball HTTP.
4. **Extract** — `tar.x({strip:1})` (`:514-521`), then `bun install --production --ignore-scripts` or `npm ci --omit=dev` (`:530-534`)
5. Recurse as a local-directory loader (`:585-591`)
6. **Dependency resolution** — `npm list -a --json` → recursive load order (`platform/dataloader/src/importer/Validator.ts:346-420`)
7. **Per-dependency, one transaction each** (`platform/dataloader/src/importer/DataLoader.ts:1685-1691`); `setArtifact` writes `catalog.artifact` + `catalog.artifact_version` (`:747-769`)
8. **Processor dispatch** by the package.json `zerobias.import-artifact` key — ~40 types registered in `platform/dataloader/src/importer/loaderRegistry.ts:156-228` (`module`, `framework`, `kb`, `product`, `schema`, `collectorbot`, `pipeline`, `segment`, `sharedobject`, …). `.yml`/`.json` auto-deserialize into `importDictionary`.
9. `validateImport()` → `postValidation()` → commit → publish events (`DataLoader.ts:1381-1388,1731-1737`)
10. `setCompleted` / `setFailure` with duration and error stack (`DataloaderJobEventHandler.ts:57,79`). On partial failure the committed subset is recovered and still auto-updated (`:72-90`).

Loader registries and tokens (`platform/image/dataloader/.npmrc`, set from
Dockerfile build args at `platform/image/dataloader/Dockerfile:7-10`):
`@zerobias-com` → `npm.pkg.github.com` with `NPM_TOKEN`; `@zerobias-org` →
`pkg.zerobias.org` with `ZB_TOKEN`.

**The content-master skip.** `DataloaderJobEventHandler.ts:103-119` is the
clearest statement of intent in the codebase:

> Org-private artifacts (versions like `1.0.2-rc.<orgIdHex32>.<n>`, produced by
> `zbb publishOrg`) MUST NOT touch content-master… The env-DB load above already
> stamped `owner_id = <orgId>` on the rows so the org sees their content via RLS.

### 7.6 Tenancy — how "org-scoped" is enforced

An Org is a `hydra.principal` of type `ORG`, extended by side tables sharing the
same UUID primary key:

| Table | Location |
|---|---|
| `hydra.org (id, slug UNIQUE, admin_group_id, member_group_id, visibility, membership_policy, …)` | `hydra/schema/sql/baseline/hydra/schema.sql:6799`; slug uniqueness `:7644` |
| `hydra.org_email_domain` | `hydra/schema/sql/baseline/hydra/schema.sql:6827` |
| `dana.org (hostname, default_app, session_timeout, …)` | `hydra/schema/sql/baseline/dana/schema.sql:542` |
| `app.org_profile` | `hydra/schema/sql/baseline/platform/schema.sql:46922` |
| `portal.organization` (has `organization_code`) | `:62581` |

Schema: `hydra/core/schemas/principal/Org.yml:1-69`. **Org ids are deterministic
UUIDv5 from the slug** — `hydra/dao/src/principal/PrincipalDAO.ts:554-566`,
namespace `da6e5d7c-27ed-4749-8f5e-e330d89cc44f`
(`hydra/dao/src/constants.ts:16`).

**`zerobias.orgId` → server-side.** Exactly one reader in the entire tree:

```ts
// platform/dataloader/src/importer/ZerobiasConfig.ts:129,143
const section = pkg.zerobias ?? pkg.auditmation;
cfg.orgId = new UUID(section.orgId);

// :88-91 — the whole tenancy model in one line
effectiveOwnerId() { return this.orgId ?? getNilUUID(); }
```

It flows to `DataLoader.ts:1496,1676` and is stamped as `ownerId` on artifact
rows (`DataLoader.ts:764`) and content rows across ~20 processors, e.g.
`platform/dataloader/src/processors/module/ModuleFileHandler.ts:244,300`.

**"Org-scoped artifact" = `owner_id = <orgId>` instead of the NIL UUID**, enforced
by Postgres row-level security:

- `hydra.owners_filter()` returns `{uuid_nil(), coalesce(get_org(), current_user)}` (`hydra/schema/sql/baseline/hydra/schema.sql:3331-3347`)
- `hydra.get_org()` reads the session GUC `dspg.org_id` (`:1786-1795`), set per-connection at `util/packages/pg/src/Database.ts:214-216`
- Policies at `hydra/schema/sql/policies/resource.sql:35-37,71-74,136-140`

So the org sees its own rows **plus** the public catalog (NIL-owned).

**Module-specific semantics.** The shared module row stays NIL-owned while the
org's *version* row is org-owned — `resolveModuleOwner` in
`platform/dataloader/src/processors/module/ModuleFileHandler.ts:314-352`
(NIL→NIL ok, org→NIL is promotion to catalog, orgA→orgB rejected) and
`hydra/dao/src/store/ModuleDAO.ts:277-286`.

The dataloader-service connects as `role: NilUUID` deliberately so the loader can
write arbitrary `owner_id` values (comment at
`platform/dataloader-service/src/server.ts:205-215`).

Concept docs: `com/zerobias/Concepts.md:18-53` ("Organizations and Tenancy"),
`com/zerobias/ContentArtifacts.md:33-36` (Private / Open Source /
Licensed-Commercial). **Neither documents `zerobias.orgId` or the `-rc.<hex>`
scheme** — that model exists only in code and code comments.

### 7.7 Gateway / routing chain

Confirmed end to end:

1. ALB → **Istio external gateway** (`devops/charts/istio-gateway/templates/gateway.yaml:1-33`, ALB ingress at `templates/alb-ingress.yaml`)
2. Everything (`prefix: /`) → `gateway.default.svc.cluster.local:5050` (`devops/charts/istio-gateway/templates/dana-routing.yaml:12-19`)
3. **`gateway` IS dana** — `devops/modules/k8s/platform-base/gateway.tf:45` (`service_name = "gateway"`), port 5050, `image.tag = var.dana_version` (`:160-166`). There is no separate API-gateway product.
4. Dana authenticates, mints the internal JWT, stamps `dana-org-id` / `dana-request-id` / `dana-locale` on the upstream request (`dana/app/src/proxy.ts:699-704`), resolves the target app from the **first path segment** (`dana/app/src/RequestContext.ts:210-227,275-297`), then proxies to `DEFAULT_UPSTREAM_URL` (`gateway.tf:221-222`; default `http://ingress-internal` at `dana/app/src/server.ts:76`)
5. Istio internal gateway → per-service VirtualServices generated by the `app-routing` chart (`devops/charts/app-routing/templates/routing.yaml:54-105`), matching `prefix: /{{ .path }}` and, with `rewrite: true`, rewriting to `/`. The chart can additionally match on the `dana-org-id` header for per-org deployments (`:18-22,58-62`).
6. **`/dataloader`** — `devops/modules/k8s/platform/platform-dataloader.tf:169-187`: `path: dataloader`, `rewrite: true`, `loginEnabled: false`. So `/dataloader/jobs` → rewritten to `/jobs` → `platform-dataloader-service`. This is why the service spec declares `/jobs`.
7. **`/dana`** — the internal gateway routes `prefix: /dana` back to `gateway:5050` (`dana-routing.yaml:49-56`); dana serves it from its own Express router at basePath `/dana`.

**Open question on the `/api` prefix.** The SDK canonicalizes every base URL to
`{proto}://{host}/api` and appends the service path
(`@zerobias-com/zerobias-sdk/dist/index.js:32-44`, `danaPathMap` at `:16-30`),
producing `https://app.zerobias.com/api/dana/me`. Dana strips that prefix via
`DANA_STRIP_PREFIX` (`dana/app/src/proxy.ts:737-746` — the comment literally
reads `/api/dana/me -> /dana/me`), which defaults to `api` in `dana/zbb.yaml:156-158`
and in every docker-compose. **However `DANA_STRIP_PREFIX` does not appear
anywhere in `devops/`** (`.tf`/`.yaml`/`.hcl` all grepped). Prod may instead rely
on the `api.{hostname}` form special-cased at `proxy.ts:756,767`, or the
terraform variable may simply be missing. Unresolved from the repos present.

---

## 8. Environment variable reference

### 8.1 Read by org-mode Kotlin

| Var | Read at | Default when unset | Consequence if absent |
|---|---|---|---|
| `ZB_TOKEN` | `OrgPublish.kt:74` (`requireToken`) | **none — hard failure** | `"<task>: ZB_TOKEN must be set."` (`:75`). Also `${ZB_TOKEN}` in `.npmrc:6` silently expands to empty → 401 from pkg.zerobias.org. |
| `PUBLISH_ORG_REGISTRY_URL` | `OrgPublish.kt:57` (`registryUrl`), `:216` (`npmPublishArgs`) | `https://pkg.zerobias.org` (`:45`) | version classification queries prod verdaccio; `npm publish` gets no `--registry`. **Read at configuration time** (`args.set` at `zb.typescript:1310`). |
| `PUBLISH_ORG_NPM_TOKEN` | `OrgPublish.kt:71` (`resolveNpmToken`) | falls back to `ZB_TOKEN` | temp `.npmrc` for `npm view` is authed with `ZB_TOKEN`. Sole call site `:103`. |
| `ZB_PLATFORM_URL` | `OrgPublish.kt:62` (`platformUrl`) | `https://app.zerobias.com/api` (`:46`) | dana `/me` and dataloader `/jobs` both go to prod. |
| `DATALOADER_SERVICE_URL` | **`NeonDataloaderTask.kt:477` only** | `https://app.zerobias.com/api/dataloader` (`:470`) | **Not read by any org-mode task.** `DataloaderOrgJobTask` builds its URL from `OrgPublish.platformUrl()` instead (`:59,73`). The two coincide in prod but diverge under any override. |
| `DATALOADER_SPEC` | **`NeonDataloaderTask.kt:248` only** | `@zerobias-com/platform-dataloader@prod` (`:249`) | **Not read by any org-mode task** — belongs to `testDataloader`/gate. |

### 8.2 Required by shared tasks that org mode still runs

| Var | Consumer | Citation |
|---|---|---|
| `NPM_TOKEN` | `preflightChecks` hard requirement; GHCR push password (username hardcoded `auditlogic`) | `zb.base:518`, `:714-720`; `zb.typescript:2045-2046,2055` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `aws sts`, `aws ecr get-login-password`, ECR push. Vault-sourced with `refresh: true` | `module/zbb.yaml:16-25`; `zb.base:610-707`; `zb.typescript:2014` |
| `AWS_REGION` | ECR | `zb.base:611-618` |
| `ECR_REGISTRY` | ECR push target | `zb.typescript:1975-2001` |
| `GHCR_REGISTRY` | GHCR push target | `zb.base:710-713`; `zb.typescript:2041-2042` |
| `DISPATCH_TOKEN` | `dispatchGenerateKb` — see §10.1 | `zb.typescript-connector:73-74,114` |
| `READ_TOKEN` / `GITHUB_TOKEN` | **plugin resolution only** from `maven.pkg.github.com` — not used by any publish task | `module/settings.gradle.kts:15-17` |
| `NEON_*` | `testDataloader` only | `module/zbb.yaml` |

### 8.3 The zbb env contract

`zbb/lib/env/effective.ts:66-71`:

> Deliberately NOT in any contract: the publish-endpoint OVERRIDES
> (`PUBLISH_ORG_*`, `ZB_PLATFORM_URL`, `DATALOADER_SERVICE_URL`,
> `DATALOADER_SPEC`) — they default to prod and stay strippable so a stale shell
> value can't silently redirect a prod publish… (use `ZBB_HERMETIC=0` for
> local-verdaccio / loader-dev testing).

`ZB_TOKEN` **is** in the contract (`effective.ts:90`), and `publishOrg` maps to
the full `PUBLISH_CONTRACT` (`:100-106`) precisely because the org path still
needs the AWS/ECR/GHCR vars.

**Consequence:** under `zbb publishOrg` the four overrides are stripped and
everything targets **prod**. Setting them in your shell has no effect unless you
also set `ZBB_HERMETIC=0`.

---

## 9. Failure and rollback semantics

The rollback block is gated off — `zb.base:1465-1471`:

```kotlin
gradle.buildFinished {
    // !isOrgPublish: an org publish never promotes, so promoteAllSucceeded is
    // false on the SUCCESS path too. Without this guard a clean org publish
    // would end by stripping a 'next' tag it never set and reverting a
    // package.json restorePackageJson already restored.
    if (!isDryRun && branch == "main" && !isOrgPublish
        && stagedPackages.isNotEmpty() && !promoteAllSucceeded) {
```

The guard is correct. Its consequence is that **in org mode nothing is rolled
back at all**:

| Concern | Behavior |
|---|---|
| `npm dist-tag rm <pkg> next` (`zb.base:1477-1481`) | does not run — correct and harmless, org mode sets no dist-tag |
| `git checkout -- package.json` (`:1496-1500`) | does not run — but the working tree is restored anyway by `restorePackageJson`, a finalizer of `patchPackageJson` (`zb.typescript:1162,1137-1154`), which fires on every failure path after the patch. Same for `restoreConnectionProfile` (`:1204`) and `restoreHubSdkPackageJson` (`:1915`). |
| published npm tarball | **not unpublished.** If `publishHubSdkExec` or either image push fails after `publishNpmExec` succeeded, the module package stays on the registry at that rc version. A re-run resolves the *next* increment (`OrgPublish.kt:196`), so the orphaned rc version persists permanently. |
| ECR / GHCR images | **not deleted.** A `publishImageGhcr` failure leaves the ECR image pushed. There is no skip-if-published guard on docker at all — a repushed `:version` silently overwrites. |
| `dataloaderOrgJob` failure | leaves the npm artifact and both images published with **no catalog row referencing them** |
| git | nothing to undo — commit/tag/push are all skipped (`zb.base:1557,365,1684,1792`) |

The one guard that does exist is at the npm layer: `isAlreadyPublished()`
(`zb.typescript:1288-1299`) is checked in `publishNpmExec.doFirst`
(`:1321-1325`), `publishSdkExec` (`:1871-1875`) and `publishHubSdkExec`
(`:1940-1944`). On a hit the task throws `StopExecutionException` but still
records the package as staged.

---

## 10. Known gaps and inconsistencies

Ordered roughly by operational impact.

### 10.1 `dispatchGenerateKb` has no org guard

`zb.typescript-connector.gradle.kts:63-79` gates only on `isDryRunKb`,
`changedSinceTagKb`, and `DISPATCH_TOKEN`. There is **no `isOrgPublish` check
anywhere in the file** (grep: zero hits). With `DISPATCH_TOKEN` set, the task's
action executes during an org publish and is stopped only incidentally by a
pre-release check inside `doLast` (`:97-100`):

```kotlin
if (ver.contains("-")) {
    logger.lifecycle("[dispatchGenerateKb] $name@$ver is a pre-release — skipping KB dispatch")
    return@doLast
}
```

It works today only because every org version contains a hyphen. Every other
org-mode exclusion is explicit; this one is accidental.

### 10.2 Superusers are blocked by the client but accepted by the server

`/dana/me` returns `isAdmin: false` for a superuser who is not in the org's admin
group (`MeProducerImpl.ts:60-71` — no superuser OR), while `queueJob` lets that
same superuser publish anything (`JobProducerImpl.ts:43-45`). Since
`verifyOrgPublish` hard-requires `isAdmin == true`, a superuser who is not an
org-group member cannot run `zbb publishOrg` even though the platform would
accept the job.

### 10.3 The version hex and `package.json` orgId are never cross-checked

The service authorizes on the hex extracted from the version string
(`JobProducerImpl.ts:47,58`). The loader stamps `owner_id` from the tarball's
`zerobias.orgId` (`ZerobiasConfig.ts:129,143` → `DataLoader.ts:764`). Nothing
reconciles them. zbb always derives one from the other so they agree for
artifacts it publishes, but a hand-assembled tarball could authorize as org A and
write rows owned by org B.

### 10.4 `npm view` failures read as "brand new"

`npmViewVersions` treats empty stdout as an empty version list
(`OrgPublish.kt:115`), and `ExecUtils.execCapture` discards stderr
(`ExecUtils.kt:63-64`). npm writes most errors to stderr, so an auth failure or a
network error against `pkg.zerobias.org` yields `[]` →
`classifyExistingVersions` returns `null` → `n = 0` (`:196`) → the publish
attempts an increment that may already exist, which then fails at `npm publish`
or is silently skipped by `isAlreadyPublished` (`zb.typescript:1321-1325`).

Related: `parseVersionsArray` (`:126-134`) handles only two of npm's three output
shapes. An object-shaped response (`{"1.0.0":…}`) falls through to `emptyList()`
at `:133` — again reading as "brand new".

### 10.5 No timeouts anywhere on the HTTP path

Neither `CurlUtils` nor `OrgPublish` sets `--max-time` or `--connect-timeout`, and
`pollJob` is an unbounded `while (true)` (`DataloaderOrgJobTask.kt:78`). A hung
dana, or a job stuck in `queued` because event publishing silently failed (see
10.10), hangs the build forever.

### 10.6 Three registries consulted for the same artifact in one run

| Step | Registry used | Auth |
|---|---|---|
| `resolveOrgVersion` classification | `OrgPublish.registryUrl()` = `pkg.zerobias.org` (`OrgPublish.kt:108`) | temp `.npmrc` with `PUBLISH_ORG_NPM_TOKEN` ?: `ZB_TOKEN` |
| `isAlreadyPublished` | `npm view "<name>@<version>" version` with **no `--registry`, no `--userconfig`** (`zb.typescript:1288-1299`) → package `.npmrc` scope map → `pkg.zerobias.org` | `${ZB_TOKEN}` |
| `npm publish` | `publishConfig.registry` — `npm.pkg.github.com` for avigilon and interface-dataproducer | **no `_authToken` for that host exists in the repo** |

Nothing reconciles these three.

### 10.7 "Fail before gate should cost seconds" is not guaranteed

The comment at `zb.base:1405-1406` claims `verifyOrgPublish` fails fast, but
`dependsOn` imposes no ordering between `verifyOrgPublish` and gate's other
dependencies (`zb.base:943`) — only that all of them precede gate's own (empty)
action. With `org.gradle.parallel=true` set in `module/gradle.properties:26`,
`validate`/`lint`/`compile` can run **concurrently** with the dana check. There is
no `mustRunAfter`/`shouldRunAfter` forcing it first.

### 10.8 Org tasks are registered unconditionally

`zb.base:1370,1374,1386` are outside the `if (isOrgPublish)` block. So:

- `./gradlew resolveOrgVersion` (no flag) runs and mutates `project.version` with nothing consuming it
- `./gradlew dataloaderOrgJob` (no flag) **POSTs a real dataloader job** for whatever `project.version` currently is — i.e. the plain catalog version

Only the `publishOrg` *alias* is protected by the `whenReady` guard
(`zb.base:1838-1846`).

### 10.9 401/403 fast-fail uses brittle exact substrings

`CurlUtils.kt:92,98` test `stdout.contains("\"statusCode\":401")` — **no space
after the colon**. A response body formatted as `"statusCode": 401` does not
match, so an auth failure instead burns all 5 retries with exponential backoff
(≈32s) before surfacing as the generic "failed after 5 attempts" message.

### 10.10 A publish can 500 with a `failed` job already persisted

If event publishing fails, `JobProducerImpl.ts:134-148` flips the row to `failed`
and throws `UnexpectedError` (500) instead of returning the job — so the client
never learns the id. This depends on `EVENT_HTTP_THROW_ON_FAILURE=true`; without
it the row silently sits in `queued` forever (comment at `:114-121`), and the
gradle poller never gets an id to poll in the first place.

### 10.11 `skipObjects` is a silent no-op

`DataloaderJobEventHandler.ts:41` passes `--skip-shared`, but
`platform/dataloader/src/importer/CliArgs.ts:55-190` parses `--skip-dynamo` and
`--skip-pgboss` and has no `--skip-shared`. The flag is accepted, stored, and
ignored. (Not reachable from gradle, which sends neither flag.)

### 10.12 Stale "--tag next" wording in org mode

`publishNpmExec.description` says "Publish npm package to registry with --tag
next (staging)" (`zb.typescript:1303`), and the dry-run log says "Would publish
${name}@${ver} with --tag next" (`:1317`, also `:1868`, `:1937`). In org mode no
dist-tag is used. `zb.content.gradle.kts:317-318,336` *does* branch the wording
on `isOrgPublish`; `zb.typescript` does not.

### 10.13 Org tasks fingerprint the entire package directory

All three declare `@get:InputDirectory abstract val packageDir`
(`VerifyOrgPublishTask.kt:28-29`, `ResolveOrgVersionTask.kt:30-31`,
`DataloaderOrgJobTask.kt:28-29`) set to `project.layout.projectDirectory`
(`zb.base:1371,1375,1387`) — which contains `node_modules/` and `dist/`.
`outputs.upToDateWhen { false }` stops the *result* being reused but does not stop
Gradle snapshotting the declared input.

### 10.14 `PUBLISH_ORG_REGISTRY_URL` is read at configuration time

`args.set(OrgPublish.npmPublishArgs(isOrgPublish))` (`zb.typescript:1310`) calls
`System.getenv` during configuration, inside the Gradle daemon. A daemon started
before the var was exported will not see it, and the value is baked into the task
for the whole build. `zbb`'s daemon-drift check (`zbb/lib/gradleDaemon.ts:61-131`)
only covers vars declared in `zbb.yaml`, and these four overrides deliberately
are not.

### 10.15 A divergent rc-version convention exists elsewhere

`platform/api/src/utils/PublishUtils.ts:27,33` and
`platform/events/src/common.ts:631-655` mint
`` `1.0.0-rc${ownerId.replaceAll('-','')}` `` — **no dot before the hex and no
trailing increment**. That form does **not** match `ORG_VERSION_RE` and would not
be recognized as org-private by either consumer. The dotted
`-rc.<hex32>.<n>` form is produced only by `zbb publishOrg`. Same-shaped strings
are also used as UUIDv5 salts in
`platform/api/src/producers/ProductProducerImpl.ts:154,195,588,1205`,
`CrosswalkProducerImpl.ts:51`, `SegmentProducerImpl.ts:100`.

Also relevant: `platform/dataloader/src/importer/ArtifactHandler.ts:360` excludes
`-rc.*` versions from the dev→qa→uat→latest promotion flow.

### 10.16 `ZB_TOKEN` is doing double duty

It is the npm `_authToken` for `pkg.zerobias.org` (`module/.npmrc:6`,
`platform/image/dataloader/.npmrc`, `dana/.github/workflows/publish.yml:21`,
`dana/GRADLE.md:69`) **and** the platform `APIKey` for dana and the
dataloader-service (`OrgPublish.kt:73-75` → `Authorization: APIKey`). That works
if Verdaccio delegates authentication to the platform, which is the plausible
design — but it is undocumented and it is the single credential the whole org
path hangs on. Worth confirming explicitly.

### 10.17 `zb.workspace.gradle.kts` has no org counterpart

Grep: zero `orgPublish` references. `versionStandardPackages`
(`zb.workspace:47-211`) — the CI single-writer that collapses N per-package bumps
into one commit — is entirely catalog-mode. There is no batched/CI form of org
publish.

---

## 11. Prerequisites to make this work in `zerobias-org/module`

The path is **currently unreachable** in that repo. To run it:

1. **Add `zerobias.orgId` to the target package's `package.json`.** No package under `module/package/` declares it today (all four checked), so `verifyOrgPublish` throws at `OrgPublish.kt:89-91` every time. Must be a hyphenated UUID, and — because of the `[^}]*?` regex at `PackageJsonReader.kt:74` — must appear **before any nested object** inside the `zerobias` block.
2. **Ensure the package version is plain semver.** `resolveOrgVersion` rejects any prerelease or build metadata (`OrgPublish.kt:181-184`), so effectively publish from `main`.
3. **Get an org-admin credential.** `ZB_TOKEN` must belong to a principal in that org's `admin_group_id` (`isOrgAdmin.sql`). Superuser alone is not sufficient — see §10.2.
4. **Confirm the npm registry and auth line up.** For `avigilon/alta/access` and `interface/dataproducer`, `publishConfig.registry` points at `npm.pkg.github.com` while the repo `.npmrc` only carries a token for `pkg.zerobias.org` — see §10.6.
5. **Have the full publishing toolchain available.** `preflightChecks` is not weakened: `NPM_TOKEN`, docker daemon, buildx with amd64+arm64, a working arm64 emulation probe, valid AWS creds with ECR push permission, and GHCR login — see §3.3.
6. **Expect a prod target.** `ZB_PLATFORM_URL` and `PUBLISH_ORG_REGISTRY_URL` are stripped by the zbb hermetic seal; use `ZBB_HERMETIC=0` to point at a local verdaccio or a loader dev environment — see §8.3.
7. **Check your zbb version** — `npm i -g @zerobias-org/zbb` for 1.0.8 semantics (§1.5).

A safe first pass: `zbb publishOrg --dry-run`. `-PdryRun=true` skips
`preflightChecks` entirely (`zb.base:501`) and makes each publish exec log
"[DRY RUN] Would publish…" then throw `StopExecutionException` — but note
`verifyOrgPublish`, `resolveOrgVersion`, and `dataloaderOrgJob` have **no dry-run
guard**, so the dana check and the version classification still make live calls,
and `dataloaderOrgJob` would still POST a real job.

---

## Appendix A — File index

### Build-tools (Kotlin plugins)

| File | Role |
|---|---|
| `BT/zb.base.gradle.kts` | mode flag, task registration and wiring, preflight, changed-detection, rollback |
| `BT/zb.typescript.gradle.kts` | npm publish, hub-sdk publish, image build and push, promote |
| `BT/zb.typescript-connector.gradle.kts` | connector validation, `dispatchGenerateKb` |
| `BT/zb.java-module.gradle.kts` | java flavor — no org awareness |
| `BT/zb.workspace.gradle.kts` | root plugin, `versionStandardPackages` — no org awareness |
| `BT/com/zerobias/buildtools/tasks/OrgPublish.kt` | shared org helpers: token, orgId, version math, classification, curl, temp `.npmrc` |
| `BT/com/zerobias/buildtools/tasks/VerifyOrgPublishTask.kt` | dana admin precheck |
| `BT/com/zerobias/buildtools/tasks/ResolveOrgVersionTask.kt` | version resolution driver |
| `BT/com/zerobias/buildtools/tasks/DataloaderOrgJobTask.kt` | catalog-load POST + poll |
| `BT/com/zerobias/buildtools/util/CurlUtils.kt` | retry, backoff, 401/403 detection, exit-code hints |
| `BT/com/zerobias/buildtools/util/PackageJsonReader.kt` | regex extraction, UUID stripping, JSON escaping |
| `BT/com/zerobias/buildtools/util/ExecUtils.kt` | process capture (stdout only) |

### zbb CLI

| File | Role |
|---|---|
| `zbb/lib/cli.ts` | dispatch, slot/stack preconditions, `prepareSlot` |
| `zbb/lib/lifecycle.ts` | verb set, flag parsing |
| `zbb/lib/standardLifecycle.ts` | the spawn, cwd→project scoping |
| `zbb/lib/env/effective.ts` | env contracts, hermetic seal |
| `zbb/lib/env/VaultResolver.ts` | Vault fetch and caching |
| `zbb/lib/stack/refresh.ts` | which vars refresh and when |
| `zbb/lib/gradleDaemon.ts` | daemon env-drift detection |

### Platform (receiving side)

| File | Role |
|---|---|
| `platform/dataloader-service/src/producers/JobProducerImpl.ts` | queue/get/list authorization |
| `platform/dataloader-service/src/util/orgVersion.ts` | `ORG_VERSION_RE` — the parser |
| `platform/dataloader-service/src/handlers/DataloaderJobEventHandler.ts` | SQS consumer, status transitions, content-master skip |
| `platform/dataloader/src/importer/ZerobiasConfig.ts` | `zerobias.orgId` → `effectiveOwnerId()` |
| `platform/dataloader/src/importer/ArtifactHandler.ts` | registry resolve, `npm pack`, extract |
| `platform/dataloader/src/importer/DataLoader.ts` | transactions, `setArtifact`, owner stamping |
| `platform/dataloader/src/importer/loaderRegistry.ts` | processor dispatch table |
| `dana/app/src/producers/MeProducerImpl.ts` | `isAdmin` computation |
| `dana/app/src/proxy.ts` | auth schemes, org membership check, org auto-select, prefix strip |
| `dana/app/src/RequestContext.ts` | `dana-org-id` resolution order |
| `hydra/schema/sql/baseline/hydra/schema.sql` | `hydra.org`, `owners_filter()`, `get_org()` |
| `hydra/schema/sql/policies/resource.sql` | RLS policies |

### Config

| File | Relevance |
|---|---|
| `module/zbb.yaml` | lifecycle map (`publishOrg` at `:81`), env declarations |
| `module/.npmrc` | scope map + `ZB_TOKEN` auth for `pkg.zerobias.org` only |
| `module/gradle.properties` | `org.gradle.parallel=true` (`:26`); `npmRegistry` (`:9`) is dead config |
| `module/settings.gradle.kts` | plugin resolution, package auto-discovery |
| `devops/.github/workflows/zbb-publish-reusable.yml` | CI publish — **catalog only, never invokes `publishOrg`** |

---

## Appendix B — Contrast with catalog publish

| Concern | `zbb publish` (catalog) | `zbb publishOrg` |
|---|---|---|
| Version source | `bumpVersion` walks patch forward past published versions | `resolveOrgVersion` → `X.Y.(Z+1)-rc.<hex32>.<n>` |
| Version written to package.json + committed | yes (`commitVersion`) | no — transient patch only, then restored |
| npm dist-tag | `--tag next`, later promoted | none |
| git commit / tag / push | yes | **no** |
| Slack release announcement | yes | **no** |
| Promotion | `promoteAll` | **no** |
| Docker ECR + GHCR push | yes | **yes, unchanged** |
| `changedSinceTag` gate | enforced | **forced `true`** |
| Admin precheck | none | `verifyOrgPublish` → dana `/me` |
| Catalog load | via CI / content pipeline | `dataloaderOrgJob` → `/dataloader/jobs`, polled |
| Failure rollback | dist-tag removal + package.json revert | **none** |
| Row ownership | `owner_id = NIL` (public catalog) | `owner_id = <orgId>`, RLS-scoped |
| content-master load | yes (prod) | **explicitly skipped** |
| Invoked by CI | yes (`zbb publish -PversionAlreadyCommitted=true`) | **never** |
