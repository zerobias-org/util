package com.zerobias.buildtools.util

import org.gradle.api.GradleException
import java.net.URI

/**
 * The ZeroBias environment a developer instance talks to, selected with `ZB_ENV`: `prod`, `uat`,
 * `qa` or `ci`, with `dev` accepted for `ci`. Unset or blank selects none, which leaves every
 * endpoint on its prod default.
 *
 * The selected environment supplies the defaults for the endpoints build-tools talks to: the
 * platform API (`ZB_PLATFORM_URL`), the dataloader-service (`DATALOADER_SERVICE_URL`) and the npm
 * registry an org publish targets (`PUBLISH_ORG_REGISTRY_URL`). A variable that is set explicitly
 * always wins over its ZB_ENV default.
 *
 * Only [current] reads the process env; everything else takes its input as an argument, so the
 * callers' precedence rules can be tested without one.
 *
 * @property platformBaseUrl The environment's app URL.
 * @property registryUrl     Its npm registry.
 * @property channel         The `dataloaderEnv` a gate stamp records for a dataloader check run
 *                           against this environment's dataloader-service
 *                           ([com.zerobias.buildtools.tasks.checkedDataloaderEnv]); null for prod,
 *                           whose checks the stamp records without one.
 */
enum class ZbEnv(val platformBaseUrl: String, val registryUrl: String, val channel: String?) {
    PROD("https://app.zerobias.com", "https://pkg.zerobias.org", null),
    UAT("https://uat.zerobias.com", "https://uat.pkg.zerobias.org", "uat"),
    QA("https://qa.zerobias.com", "https://qa.pkg.zerobias.org", "qa"),
    CI("https://ci.zerobias.com", "https://ci.pkg.zerobias.org", "dev");

    /** The platform API base, `ZB_PLATFORM_URL`'s default. */
    val platformApiUrl: String get() = "$platformBaseUrl/api"

    /** The dataloader-service base, `DATALOADER_SERVICE_URL`'s default. */
    val dataloaderServiceUrl: String get() = "$platformApiUrl/dataloader"

    companion object {
        /**
         * The environment a `ZB_ENV` value ([raw]) selects, or null when it is unset or blank.
         * Matching ignores case and surrounding whitespace, and `dev` selects [CI].
         *
         * @throws GradleException for any other value, so a typo fails rather than falling back
         *   to prod.
         */
        fun parse(raw: String?): ZbEnv? {
            val value = raw?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
            if (value == "dev") return CI
            return values().firstOrNull { it.name.lowercase() == value }
                ?: throw GradleException("ZB_ENV must be prod, uat, qa or ci (dev = ci), not '$raw'")
        }

        /** The environment this process's `ZB_ENV` selects; see [parse]. */
        fun current(): ZbEnv? = parse(System.getenv("ZB_ENV"))

        /**
         * The environment whose app host [url] is on: `app.zerobias.com` is [PROD], and
         * `uat.zerobias.com`, `qa.zerobias.com` and `ci.zerobias.com` are [UAT], [QA] and [CI].
         * Null for any other host (localhost, a port-forward, a registry) or a URL without one.
         * A URL without a scheme is read from its host, the way curl reads it.
         */
        fun forPlatformUrl(url: String): ZbEnv? {
            val host = hostOf(url) ?: return null
            return values().firstOrNull { hostOf(it.platformBaseUrl) == host }
        }

        /** The lower-cased host of [url], read as `https://` when it has no scheme; null without one. */
        private fun hostOf(url: String): String? {
            val trimmed = url.trim()
            val withScheme = if ("://" in trimmed) trimmed else "https://$trimmed"
            return runCatching { URI(withScheme).host }.getOrNull()?.lowercase()
        }
    }
}
