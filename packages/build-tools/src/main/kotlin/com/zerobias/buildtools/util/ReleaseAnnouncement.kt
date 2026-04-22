package com.zerobias.buildtools.util

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import org.gradle.api.logging.Logger
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Post-publish release announcement: Slack webhook + Lambda event.
 *
 * Ported from:
 *   - devops/nx-actions/release-announcement (Slack message generation)
 *   - devops/nx-actions/publish-release-event (Lambda invocation)
 *
 * Both channels are gated on environment variables — when they're absent
 * (e.g. local `zbb publish`) the step is silently skipped.
 */
object ReleaseAnnouncement {

    private val mapper = ObjectMapper().registerKotlinModule()
    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(java.time.Duration.ofSeconds(10))
        .build()

    data class PublishedPackage(
        val name: String,
        val version: String,
        val location: String,
    )

    /**
     * Run both announcement channels. Call after tag + push.
     *
     * @param packages  list of published packages from the publish plan
     * @param repoRoot  root directory of the repo (for reading CHANGELOGs)
     * @param branch    current git branch name
     * @param githubRepo  "owner/repo" slug (from git remote), or null
     * @param logger    Gradle logger for lifecycle/warn output
     */
    fun announce(
        packages: List<PublishedPackage>,
        repoRoot: File,
        branch: String,
        githubRepo: String?,
        logger: Logger,
    ) {
        if (packages.isEmpty()) return

        sendSlack(packages, repoRoot, branch, githubRepo, logger)
        sendLambdaEvents(packages, repoRoot, branch, githubRepo, logger)
    }

    // ── Slack ───────────────────────────────────────────────────────────

    /**
     * Post a release announcement to Slack via incoming webhook.
     *
     * Requires env: SLACK_RELEASES_WEBHOOK
     */
    private fun sendSlack(
        packages: List<PublishedPackage>,
        repoRoot: File,
        branch: String,
        githubRepo: String?,
        logger: Logger,
    ) {
        val webhookUrl = System.getenv("SLACK_RELEASES_WEBHOOK")
        if (webhookUrl.isNullOrBlank()) {
            logger.lifecycle("[announce] SLACK_RELEASES_WEBHOOK not set — skipping Slack notification")
            return
        }

        val messageText = buildSlackText(packages, repoRoot, githubRepo)
        val distTag = distTagForBranch(branch)

        val branchSuffix = if (branch.isNotBlank() && branch != "unknown") " ($branch)" else ""
        val tagSuffix = if (distTag.isNotBlank()) " [tag: $distTag]" else ""
        val title = ":robot: New Packages Published :tada:$branchSuffix$tagSuffix"
        val repoName = githubRepo ?: "unknown"
        val runId = System.getenv("GITHUB_RUN_ID") ?: ""
        val footer = buildString {
            append("<https://github.com/$repoName|$repoName>")
            if (runId.isNotBlank()) {
                append(" • <https://github.com/$repoName/actions/runs/$runId|View run>")
            }
        }

        // Slack incoming-webhook payload with attachment
        val payload = mapOf(
            "text" to "New $repoName Published",
            "attachments" to listOf(
                mapOf(
                    "color" to "#36a64f",
                    "fallback" to "New Packages Published",
                    "title" to title,
                    "text" to messageText,
                    "footer" to footer,
                    "mrkdwn_in" to listOf("text", "footer"),
                )
            ),
        )

        try {
            val body = mapper.writeValueAsString(payload)
            val request = HttpRequest.newBuilder()
                .uri(URI.create(webhookUrl))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .timeout(java.time.Duration.ofSeconds(15))
                .build()
            val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
            if (response.statusCode() == 200) {
                logger.lifecycle("[announce] Slack notification sent")
            } else {
                logger.warn("[announce] Slack webhook returned ${response.statusCode()}: ${response.body().take(200)}")
            }
        } catch (e: Exception) {
            logger.warn("[announce] Slack notification failed: ${e.message}")
        }
    }

    /**
     * Build the Slack message body text.
     *
     * Mirrors generate_slack_message.sh output format:
     *   Published by *@actor*
     *
     *   *:package: Packages*
     *   • `name@version` <changelog-url|changelog>
     */
    private fun buildSlackText(
        packages: List<PublishedPackage>,
        @Suppress("UNUSED_PARAMETER") repoRoot: File,
        githubRepo: String?,
    ): String {
        val sb = StringBuilder()

        val actor = System.getenv("GITHUB_ACTOR")
        if (!actor.isNullOrBlank()) {
            sb.append("Published by *@$actor*\n\n")
        }

        sb.append("*:package: Packages*\n")
        for (pkg in packages) {
            val changelogUrl = if (githubRepo != null) {
                "https://github.com/$githubRepo/blob/main/${pkg.location}/CHANGELOG.md"
            } else null

            sb.append("• `${pkg.name}@${pkg.version}`")
            if (changelogUrl != null) {
                sb.append(" <$changelogUrl|changelog>")
            }
            sb.append('\n')
        }

        return sb.toString().trimEnd()
    }

    // ── Lambda events ───────────────────────────────────────────────────

    /**
     * Invoke the auditmation-event-router-events Lambda for each published
     * package.
     *
     * Uses the `aws` CLI so we don't need the AWS SDK as a Gradle dependency.
     * Requires: `aws` CLI on PATH + valid AWS credentials in the environment.
     */
    private fun sendLambdaEvents(
        packages: List<PublishedPackage>,
        repoRoot: File,
        @Suppress("UNUSED_PARAMETER") branch: String,
        githubRepo: String?,
        logger: Logger,
    ) {
        // Gate on AWS_REGION — if not set, we're not in a CI environment
        // with AWS credentials configured.
        val awsRegion = System.getenv("AWS_REGION")
        if (awsRegion.isNullOrBlank()) {
            logger.lifecycle("[announce] AWS_REGION not set — skipping Lambda release events")
            return
        }

        // Verify aws CLI is available
        val awsAvailable = try {
            val proc = ProcessBuilder("aws", "--version")
                .redirectErrorStream(true)
                .start()
            proc.waitFor(5, TimeUnit.SECONDS) && proc.exitValue() == 0
        } catch (_: Exception) { false }

        if (!awsAvailable) {
            logger.lifecycle("[announce] aws CLI not available — skipping Lambda release events")
            return
        }

        val repository = if (githubRepo != null) {
            "${System.getenv("GITHUB_SERVER_URL") ?: "https://github.com"}/$githubRepo"
        } else null
        val commitHash = System.getenv("GITHUB_SHA") ?: ""
        val runId = System.getenv("GITHUB_RUN_ID") ?: ""
        val actionRunUrl = if (repository != null && runId.isNotBlank()) {
            "$repository/actions/runs/$runId"
        } else ""

        var sent = 0
        for (pkg in packages) {
            val pkgDir = File(repoRoot, pkg.location)
            val pkgJsonFile = File(pkgDir, "package.json")
            if (!pkgJsonFile.exists()) {
                logger.warn("[announce] package.json not found at ${pkgDir.absolutePath} — skipping event for ${pkg.name}")
                continue
            }

            @Suppress("UNCHECKED_CAST")
            val pkgJson = mapper.readValue(pkgJsonFile, Map::class.java) as Map<String, Any?>

            // Extract changelog (first version block)
            val changelogFile = File(pkgDir, "CHANGELOG.md")
            val changelog = if (changelogFile.exists()) {
                val text = changelogFile.readText()
                val match = Regex("^#+ \\[[\\s\\S]+?(?=^#+ \\[)", RegexOption.MULTILINE).find(text)
                match?.value?.trim() ?: ""
            } else ""

            val changelogUrl = if (repository != null) {
                "$repository/blob/main/${pkg.location}/CHANGELOG.md"
            } else ""

            // Fetch dist-tags (best-effort)
            val distTags = try {
                val proc = ProcessBuilder(
                    "npm", "view", "${pkg.name}@${pkg.version}", "dist-tags", "--json"
                )
                    .redirectErrorStream(true)
                    .start()
                val output = proc.inputStream.bufferedReader().readText()
                if (proc.waitFor(10, TimeUnit.SECONDS) && proc.exitValue() == 0) {
                    mapper.readValue(output, Map::class.java)
                } else emptyMap<String, Any>()
            } catch (_: Exception) {
                emptyMap<String, Any>()
            }

            val message = mapOf(
                "body" to mapOf(
                    "id" to UUID.randomUUID().toString(),
                    "service" to "release",
                    "eventType" to "release",
                    "name" to pkg.name,
                    "version" to pkg.version,
                    "repository" to (repository ?: ""),
                    "commitHash" to commitHash,
                    "actionRunUrl" to actionRunUrl,
                    "changelog" to changelog,
                    "changelogUrl" to changelogUrl,
                    "zerobias" to pkgJson["zerobias"],
                    "auditmation" to pkgJson["auditmation"],
                    "distTags" to distTags,
                )
            )

            val payload = mapper.writeValueAsString(message)
            logger.info("[announce] sending release event for ${pkg.name}@${pkg.version}")

            try {
                val proc = ProcessBuilder(
                    "aws", "lambda", "invoke",
                    "--function-name", "auditmation-event-router-events",
                    "--region", awsRegion,
                    "--payload", payload,
                    "--cli-binary-format", "raw-in-base64-out",
                    "/dev/null",
                )
                    .directory(repoRoot)
                    .redirectErrorStream(true)
                    .start()
                val output = proc.inputStream.bufferedReader().readText()
                if (proc.waitFor(15, TimeUnit.SECONDS) && proc.exitValue() == 0) {
                    sent++
                } else {
                    logger.warn("[announce] Lambda invoke failed for ${pkg.name}: ${output.take(300)}")
                }
            } catch (e: Exception) {
                logger.warn("[announce] Lambda invoke failed for ${pkg.name}: ${e.message}")
            }
        }
        if (sent > 0) {
            logger.lifecycle("[announce] sent $sent release event(s) to auditmation-event-router-events")
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    /**
     * Detect the "owner/repo" slug from the git remote origin URL.
     * Returns null if the remote can't be parsed (e.g. non-GitHub remote).
     */
    fun detectGithubRepo(repoRoot: File): String? {
        return try {
            val proc = ProcessBuilder("git", "remote", "get-url", "origin")
                .directory(repoRoot)
                .redirectErrorStream(false)
                .start()
            val output = proc.inputStream.bufferedReader().readText().trim()
            proc.waitFor(5, TimeUnit.SECONDS)
            // SSH: git@github.com:owner/repo.git
            val sshMatch = Regex("""github\.com[:/]([^/]+/[^/.]+)""").find(output)
            if (sshMatch != null) return sshMatch.groupValues[1]
            // HTTPS: https://github.com/owner/repo.git
            val httpsMatch = Regex("""github\.com/([^/]+/[^/.]+)""").find(output)
            if (httpsMatch != null) return httpsMatch.groupValues[1]
            null
        } catch (_: Exception) {
            null
        }
    }

    private fun distTagForBranch(branch: String): String = when (branch) {
        "main" -> "latest"
        "qa" -> "qa"
        "dev" -> "dev"
        "uat" -> "uat"
        else -> "uat"
    }
}
