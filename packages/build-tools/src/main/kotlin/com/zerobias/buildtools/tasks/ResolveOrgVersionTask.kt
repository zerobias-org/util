package com.zerobias.buildtools.tasks

import com.zerobias.buildtools.util.PackageJsonReader
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction

/**
 * Resolves the org-private version for this publish and exposes it via
 * [orgVersion]. The registration site assigns it to `project.version`, which
 * is what every downstream publish task reads at execution time — the npm
 * publish, the SDK publishes, and the ECR/GHCR image tags all pick it up
 * without further wiring.
 *
 * This is the org-mode counterpart of `resolvePublishVersion` in
 * `zb.base.gradle.kts`, and occupies the same slot in the graph
 * (`mustRunAfter(buildArtifacts)`): late enough that a build failure never
 * leaves a resolved version behind, early enough that everything that
 * publishes sees it.
 *
 * Refuses names that already carry catalog versions, or rc versions owned by
 * a different org — see [OrgPublish.classifyExistingVersions].
 */
abstract class ResolveOrgVersionTask : DefaultTask() {

    @get:InputDirectory
    abstract val packageDir: DirectoryProperty

    /** `X.Y.(Z+1)-rc.<orgIdHex32>.<n>`, populated by the task action. */
    @get:Internal
    abstract val orgVersion: Property<String>

    init {
        group = "publish"
        description = "Resolve the org-private version for this publish"
        // Reads live registry state; a cached result would collide on the
        // next publish of the same base version.
        outputs.upToDateWhen { false }
    }

    @TaskAction
    fun execute() {
        val pkgDir = packageDir.get().asFile
        val token = OrgPublish.requireToken(name)
        val pkgRaw = OrgPublish.readPackageJson(name, pkgDir)

        val pkgName = PackageJsonReader.extractString(pkgRaw, "name")
            ?: throw GradleException("$name: package.json missing 'name'.")
        val pkgVersion = PackageJsonReader.extractString(pkgRaw, "version")
            ?: throw GradleException("$name: package.json missing 'version'.")

        val orgId = OrgPublish.readOrgId(name, pkgRaw)
        val orgIdStripped = PackageJsonReader.stripUuidHyphens(orgId)

        logger.lifecycle("$name: classifying existing versions of $pkgName in ${OrgPublish.registryUrl()}...")
        val existing = OrgPublish.npmViewVersions(pkgName, token, pkgDir)
        val maxOwnIncrement = OrgPublish.classifyExistingVersions(name, pkgName, existing, orgIdStripped)
        if (maxOwnIncrement == null) {
            logger.lifecycle("$name: no existing versions — brand new.")
        } else {
            logger.lifecycle(
                "$name: ${existing.size} existing org-owned version(s); max increment = $maxOwnIncrement."
            )
        }

        val resolved = OrgPublish.computeOrgVersion(name, pkgVersion, orgIdStripped, maxOwnIncrement)
        orgVersion.set(resolved)
        logger.lifecycle("$name: resolved org version = $resolved")
    }
}
