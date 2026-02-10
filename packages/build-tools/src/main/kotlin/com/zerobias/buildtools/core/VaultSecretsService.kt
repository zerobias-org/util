package com.zerobias.buildtools.core

import io.github.jopenlibs.vault.Vault
import io.github.jopenlibs.vault.VaultConfig
import org.gradle.api.GradleException
import org.gradle.api.provider.Property
import org.gradle.api.services.BuildService
import org.gradle.api.services.BuildServiceParameters
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Gradle BuildService for lazy, cached Vault secret resolution.
 *
 * Authentication precedence:
 * 1. VAULT_TOKEN environment variable (CI)
 * 2. ~/.vault-token file (developer after `vault login`)
 *
 * Secrets are cached per path for the duration of the build.
 * Connection is established lazily on first secret access.
 */
abstract class VaultSecretsService : BuildService<VaultSecretsService.Params>, AutoCloseable {

    interface Params : BuildServiceParameters {
        val vaultAddress: Property<String>
    }

    private val cache = ConcurrentHashMap<String, Map<String, String>>()

    @Volatile
    private var vault: Vault? = null

    private fun getVaultClient(): Vault {
        vault?.let { return it }
        synchronized(this) {
            vault?.let { return it }

            val address = parameters.vaultAddress.get()
            val token = resolveToken()

            val config = VaultConfig()
                .address(address)
                .token(token)
                .engineVersion(2)
                .build()

            return Vault.create(config).also { vault = it }
        }
    }

    private fun resolveToken(): String {
        // 1. Environment variable (CI)
        System.getenv("VAULT_TOKEN")?.let { return it }

        // 2. Token file (developer)
        val tokenFile = File(System.getProperty("user.home"), ".vault-token")
        if (tokenFile.exists()) {
            val token = tokenFile.readText().trim()
            if (token.isNotEmpty()) return token
        }

        throw GradleException(
            "No Vault token found. Set VAULT_TOKEN env var or run 'vault login' to create ~/.vault-token"
        )
    }

    /**
     * Read a secret field from Vault. Results are cached per path.
     *
     * @param path Vault secret path (e.g., "operations-kv/ci/github")
     *             KV v2 /data/ prefix is added automatically.
     * @param field Field name within the secret (e.g., "readPackagesToken")
     */
    fun getSecret(path: String, field: String): String {
        val secrets = cache.computeIfAbsent(path) { fetchFromVault(it) }
        return secrets[field]
            ?: throw GradleException("Field '$field' not found at Vault path '$path'")
    }

    private fun fetchFromVault(path: String): Map<String, String> {
        val client = getVaultClient()
        try {
            val response = client.logical().read(path)
            return response.data
                ?: throw GradleException("No data returned from Vault path '$path'")
        } catch (e: GradleException) {
            throw e
        } catch (e: Exception) {
            throw GradleException("Failed to read Vault path '$path': ${e.message}", e)
        }
    }

    override fun close() {
        cache.clear()
        vault = null
    }
}
