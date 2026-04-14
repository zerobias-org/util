import com.zerobias.buildtools.module.ConnectionProfileFlattener
import com.zerobias.buildtools.module.OpenApiSpecAssembler
import com.zerobias.buildtools.module.ZbExtension

plugins {
    id("zb.typescript")
}

val zb = extensions.getByType<ZbExtension>()

zb.hasConnectionProfile.convention(true)
zb.includeConnectionProfileInDist.convention(true)

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

// ── Prepublish: flatten connectionProfile.yml ────────────────────────
// Ports the legacy npm `prepublishOnly` / `resolve:connectionProfile` chain
// (swagger-cli bundle + scripts/fixAllOfs/fixAllOfs.js) that used to rewrite
// connectionProfile.yml in place right before `npm publish` packed it.
// The platform dataloader (com/platform/dataloader ModuleFileHandler.ts:294)
// reads {package}/connectionProfile.yml and pulls `description` and
// `x-oauth-providers` from the schema root — so the shipped file must be
// flattened, not a raw allOf composition.
//
// Source of truth for flattening is the already-bundled dist/{module}.yml
// produced by copyDistributionSpec (zb.typescript.gradle.kts), so we don't
// re-run bundling here. Backup + restore mirror the existing patchPackageJson
// / restorePackageJson pattern used by publishNpmExec.

val cpBackupFile = project.layout.buildDirectory.file("prepublish-backup/connectionProfile.yml")

// Forward-declare restoreConnectionProfile so flattenConnectionProfileForPublish
// can reference it as its finalizer — attaching the finalizer to the FLATTEN
// task (not to publishNpmExec) guarantees restore fires even if a downstream
// task (preflightChecks, patchPackageJson, publishNpmExec itself) fails or
// gets skipped. Gradle finalizers only run if the finalized task actually
// executed, so anchoring to flatten — the task that dirties the file — is the
// only location that's both "early enough to have run" and "late enough to
// have work to undo".
val restoreConnectionProfile by tasks.registering {
    group = "publish"
    description = "Restore original connectionProfile.yml after npm publish"
    // Delay restore until after publishNpmExec in the success case, so the
    // flattened file is still on disk when `npm publish` packs the tarball.
    // In the failure case (publishNpmExec skipped due to upstream failure)
    // this mustRunAfter becomes a no-op and the finalizer fires right after
    // flatten — which is fine, there's nothing left that needs the flat file.
    mustRunAfter(tasks.named("publishNpmExec"))
    doLast {
        val backup = cpBackupFile.get().asFile
        if (!backup.exists()) return@doLast
        val cp = project.file("connectionProfile.yml")
        backup.copyTo(cp, overwrite = true)
        backup.delete()
        logger.lifecycle("[restoreConnectionProfile] restored connectionProfile.yml")
    }
}

val flattenConnectionProfileForPublish by tasks.registering {
    group = "publish"
    description = "Flatten connectionProfile.yml allOf composition before npm publish"
    // The flattener reads the bundled dist yml produced by copyDistributionSpec,
    // so it must run after that task. Using mustRunAfter (not dependsOn) because
    // copyDistributionSpec is already pulled in transitively via publishNpmExec's
    // other build deps — we just need the ordering.
    mustRunAfter(tasks.named("copyDistributionSpec"))
    // Finalizer on flatten (not on publishNpmExec) so restore runs even if a
    // task between flatten and publish fails — see the restoreConnectionProfile
    // comment above for the reasoning.
    finalizedBy(restoreConnectionProfile)
    doFirst {
        val cp = project.file("connectionProfile.yml")
        if (!cp.exists()) {
            logger.lifecycle("[flattenConnectionProfileForPublish] no connectionProfile.yml — skipping")
            return@doFirst
        }
        val moduleName = OpenApiSpecAssembler.resolveModuleName(project.projectDir)
        val distYml = project.file("dist/${moduleName}.yml")
        if (!distYml.exists()) {
            throw GradleException(
                "[flattenConnectionProfileForPublish] expected $distYml to exist — " +
                    "copyDistributionSpec must run before this task"
            )
        }

        val backup = cpBackupFile.get().asFile
        backup.parentFile.mkdirs()
        cp.copyTo(backup, overwrite = true)

        ConnectionProfileFlattener.flattenToStandaloneFile(distYml, cp)
        logger.lifecycle(
            "[flattenConnectionProfileForPublish] flattened connectionProfile.yml from ${distYml.name}"
        )
    }
}

tasks.named("publishNpmExec") {
    dependsOn(flattenConnectionProfileForPublish)
}
