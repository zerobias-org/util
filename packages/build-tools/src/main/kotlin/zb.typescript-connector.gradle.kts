import com.zerobias.buildtools.module.ZbExtension

plugins {
    id("zb.typescript")
}

val zb = extensions.getByType<ZbExtension>()

// hasConnectionProfile and includeConnectionProfileInDist are auto-detected from
// connectionProfile.yml on disk by zb.base. Spec shape must not depend on the
// language plugin in use, so we don't override them here.

val validateConnector by tasks.registering {
    group = "lifecycle"
    description = "Validate connector-specific requirements"
    doLast {
        require(project.file("connectionProfile.yml").exists()) {
            "Connector modules must have connectionProfile.yml"
        }
    }
}

tasks.named("validate") {
    dependsOn(validateConnector)
}

// ── generate-kb dispatch (Connect-to KB regeneration) ────────────────────────
//
// Pluggable publish side-effect, modelled on zb.schema's TS-twin: register a
// task gated on the shared publish-pipeline state exposed via `extra[...]`, then
// graft it onto the publish graph so it fires once the module has actually
// shipped a new release.
//
// This restores the behaviour of the legacy lerna `scripts/postpublish.sh`,
// which fired a `generate-kb` repository_dispatch at the kb repo after every
// module publish so the module's "Connect to <X>" KB (`kb-ct-<module>`) got
// regenerated and re-published. That hook was dropped in the gradle migration,
// so KB regeneration silently stopped for modules published via gradle.
//
// Connector-only on purpose: agents / java-modules (which also apply
// `zb.typescript`) do not get "Connect to" KBs, so the dispatch lives here in
// `zb.typescript-connector` rather than in `zb.typescript`.
//
// Token: the reusable publish workflow exports the Vault `dispatchToken` as
// DISPATCH_TOKEN (the same purpose-built cross-repo repository_dispatch token
// the old script used and that `content-release-reusable.yml` still uses). When
// absent (local runs) the task self-skips.
val isDryRunKb: Boolean = extra["isDryRun"] as Boolean
val changedSinceTagKb: Boolean = extra["changedSinceTag"] as Boolean
val stagedPackagesKb = extra["stagedPackages"] as MutableList<Pair<String, java.io.File>>

val dispatchGenerateKb by tasks.registering {
    group = "publish"
    description = "Dispatch generate-kb to the kb repo so the module's 'Connect to' KB is regenerated"
    // Order after the actual publish+promote, NOT after publishReleaseEvent:
    // in the CI `-PversionAlreadyCommitted=true` flow, publishReleaseEvent is
    // only ordered after tagVersion/pushVersion/pushTag (all skipped in that
    // mode), so it runs early and skips — anchoring on it made this task fire
    // BEFORE publishNpmExec, leaving `stagedPackages` empty. promoteAll
    // transitively runs after publishNpmExec (which populates stagedPackages),
    // so by the time this runs the module is staged and the guard below sees it.
    mustRunAfter(tasks.named("promoteAll"))
    onlyIf {
        when {
            isDryRunKb -> {
                logger.lifecycle("[dispatchGenerateKb] dry run — skipping")
                false
            }
            !changedSinceTagKb -> {
                logger.lifecycle("[dispatchGenerateKb] no changes since last tag — skipping")
                false
            }
            System.getenv("DISPATCH_TOKEN").isNullOrBlank() -> {
                logger.lifecycle("[dispatchGenerateKb] DISPATCH_TOKEN not set — skipping (local run)")
                false
            }
            else -> true
        }
    }
    doLast {
        val name = Regex(""""name"\s*:\s*"([^"]+)"""")
            .find(project.file("package.json").readText())?.groupValues?.get(1)
            ?: throw GradleException("[dispatchGenerateKb] cannot read 'name' from package.json")

        // Only dispatch for the module package itself, and only when it actually
        // shipped this run. hub-sdk / sdk twins are staged under their own names
        // and must not trigger KB generation.
        if (stagedPackagesKb.none { it.first == name }) {
            logger.lifecycle("[dispatchGenerateKb] $name not in staged packages — nothing published, skipping")
            return@doLast
        }

        val ver = project.version.toString()
        // Only regenerate KB for clean releases. Pre-release branch builds carry
        // a semver suffix (e.g. 1.2.3-uat.0); a KB pinned to a pre-release module
        // version is undesirable, so skip them.
        if (ver.contains("-")) {
            logger.lifecycle("[dispatchGenerateKb] $name@$ver is a pre-release — skipping KB dispatch")
            return@doLast
        }

        // @auditlogic/* modules → auditlogic/kb ; everything else → zerobias-org/kb
        val kbRepo = if (name.startsWith("@auditlogic/")) "auditlogic/kb" else "zerobias-org/kb"
        val payload = """{"event_type":"generate-kb","client_payload":""" +
            """{"code_prefix":"ct","title_prefix":"Connect to","packages":["$name@$ver"]}}"""

        logger.lifecycle("[dispatchGenerateKb] Dispatching generate-kb → $kbRepo for $name@$ver")
        // Best-effort: a dispatch hiccup must not fail an otherwise-good publish.
        // throwOnError=false also keeps ExecUtils from logging the command (which
        // carries the token) on a non-zero exit.
        com.zerobias.buildtools.util.ExecUtils.exec(
            command = listOf(
                "curl", "-sS", "--fail", "-X", "POST",
                "-H", "Authorization: token ${System.getenv("DISPATCH_TOKEN")}",
                "-H", "Accept: application/vnd.github.v3+json",
                "-H", "Content-Type: application/json",
                "https://api.github.com/repos/$kbRepo/dispatches",
                "-d", payload,
            ),
            throwOnError = false,
        )
    }
}

// Graft onto the publish graph. The top-level `publish` aggregate (zb.base)
// pulls this in; `mustRunAfter(promoteAll)` keeps it after the npm publish.
tasks.named("publish") {
    dependsOn(dispatchGenerateKb)
}
