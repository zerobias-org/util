package com.zerobias.buildtools.tasks

import com.zerobias.buildtools.util.PackageJsonReader
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction

/**
 * Queues a dataloader-service job for the artifact this build just published,
 * and blocks until the job reaches a terminal status.
 *
 * A normal publish gets its catalog load from the release-event pipeline; an
 * org-private publish is not a repo release, so it drives the load directly
 * via `POST /dataloader/jobs`. dataloader-service recognises the
 * `-rc.<orgIdHex32>.<n>` version shape and loads org-tenanted rows without
 * touching the shared `content-master` snapshot.
 *
 * MUST run after the image push for container-backed artifacts (modules):
 * once the load completes the module is deployable, and a deploy that lands
 * before the image is in the registry fails at `docker pull` on the node.
 */
abstract class DataloaderOrgJobTask : DefaultTask() {

    @get:Internal
    abstract val packageDir: DirectoryProperty

    /**
     * The version actually published. Read from `project.version` rather than
     * package.json, because the on-disk version is restored to its original
     * value by `restorePackageJson` before this task runs.
     */
    @get:Internal
    abstract val artifactVersion: Property<String>

    init {
        group = "publish"
        description = "Queue a dataloader load for the org-published artifact and wait for it to finish"
        outputs.upToDateWhen { false }
    }

    @TaskAction
    fun execute() {
        val pkgDir = packageDir.get().asFile
        val token = OrgPublish.requirePlatformKey(name)
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
            body,
            token,
            pkgDir,
        ) { msg -> logger.lifecycle(msg) }

        val jobId = PackageJsonReader.extractString(jobJson, "id")
            ?: throw GradleException("$name: dataloader /jobs response missing 'id':\n$jobJson")
        logger.lifecycle("$name: job id = $jobId")

        pollJob(jobId, token, pkgDir)
    }

    private fun pollJob(jobId: String, token: String, workingDir: java.io.File) {
        val url = "${OrgPublish.platformUrl()}/dataloader/jobs/$jobId"
        val startMs = System.currentTimeMillis()
        var lastStatus = ""
        var lastHeartbeatMs = startMs
        logger.lifecycle("$name: polling job $jobId for completion...")
        while (true) {
            val resp = OrgPublish.curlGet(
                name,
                url,
                listOf(
                    "-H", "Authorization: APIKey $token",
                    "-H", "Accept: application/json"
                ),
                workingDir,
            ) { msg -> logger.lifecycle(msg) }

            val status = (PackageJsonReader.extractString(resp, "status") ?: "").lowercase()
            val elapsedStr = OrgPublish.elapsed(startMs)

            if (status != lastStatus) {
                logger.lifecycle("$name: status = $status ($elapsedStr)")
                lastStatus = status
                lastHeartbeatMs = System.currentTimeMillis()
            } else if (System.currentTimeMillis() - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
                logger.lifecycle("$name: still $status... ($elapsedStr)")
                lastHeartbeatMs = System.currentTimeMillis()
            }

            if (status == "completed") {
                logger.lifecycle("$name: dataloader job completed in $elapsedStr.")
                return
            }
            if (status == "failed" || status == "errored") {
                PackageJsonReader.extractString(resp, "errorMessage")
                    ?.let { logger.lifecycle("$name: error: $it") }
                throw GradleException("$name: dataloader job $status ($elapsedStr).")
            }

            Thread.sleep(POLL_INTERVAL_MS)
        }
    }

    companion object {
        private const val POLL_INTERVAL_MS = 10_000L
        private const val HEARTBEAT_INTERVAL_MS = 60_000L
    }
}
