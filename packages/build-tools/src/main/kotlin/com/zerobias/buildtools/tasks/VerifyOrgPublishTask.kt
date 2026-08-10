package com.zerobias.buildtools.tasks

import com.zerobias.buildtools.util.PackageJsonReader
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.TaskAction

/**
 * Preconditions for an org-private publish. Runs BEFORE `gate` so a bad org
 * id or a non-admin token fails in seconds instead of after a full
 * validate/build/test/dataloader cycle.
 *
 * Checks, in order:
 *   1. `ZB_TOKEN` is set.
 *   2. package.json declares a well-formed `zerobias.orgId`.
 *   3. the token's principal is an admin of that org, per dana `/me`.
 *
 * Registry-state checks (is this name free? which increment is next?) live in
 * [ResolveOrgVersionTask] instead — those depend on what the build produces
 * and belong next to version resolution.
 *
 * @see OrgPublish for the env contract.
 */
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
