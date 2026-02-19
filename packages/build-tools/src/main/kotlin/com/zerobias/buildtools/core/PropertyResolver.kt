package com.zerobias.buildtools.core

import org.gradle.api.GradleException
import org.gradle.api.provider.Provider

/**
 * Resolves property values containing {{driver.path}} references.
 *
 * Supported drivers:
 * - Literal: values without {{}} pass through unchanged
 * - env: {{env.VAR_NAME}} reads System.getenv()
 * - vault: {{vault.mount/path.field}} reads from Vault via VaultSecretsService
 *
 * Unknown drivers and missing values produce fatal GradleException errors (fail fast).
 */
class PropertyResolver(
    private val vaultService: Provider<VaultSecretsService>
) {
    companion object {
        private val REFERENCE_PATTERN = Regex("""\{\{(\w+)\.(.+?)}}""")
    }

    /**
     * Resolve a property value. Literals pass through unchanged.
     * {{driver.path}} references are resolved via the appropriate driver.
     */
    fun resolve(value: String): String {
        val match = REFERENCE_PATTERN.matchEntire(value.trim()) ?: return value
        val driver = match.groupValues[1]
        val path = match.groupValues[2]

        return when (driver) {
            "env" -> resolveEnv(path)
            "vault" -> resolveVault(path)
            else -> throw GradleException("Unknown property driver: '$driver' in reference '{{$driver.$path}}'")
        }
    }

    private fun resolveEnv(varName: String): String {
        return System.getenv(varName)
            ?: throw GradleException("Environment variable not found: '$varName'")
    }

    private fun resolveVault(path: String): String {
        // Path format: mount/secret/path.fieldName
        // Split on last dot to separate secret path from field name
        val lastDot = path.lastIndexOf('.')
        if (lastDot <= 0) {
            throw GradleException(
                "Invalid vault reference: '$path'. Expected format: mount/path.field"
            )
        }
        val secretPath = path.substring(0, lastDot)
        val field = path.substring(lastDot + 1)
        return vaultService.get().getSecret(secretPath, field)
    }
}
