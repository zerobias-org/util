package com.zerobias.buildtools.schema

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.databind.node.ObjectNode
import java.io.File

/**
 * Replaces the bash + jq patching done by the legacy `generate.sh`. Walks
 * the package-template / lock-template JSON and substitutes placeholder
 * strings with concrete values derived from the schema package's
 * `package.json` and the running build's project version.
 *
 * Placeholders supported (single-curly form, e.g. `{ARTIFACT_NAME}`):
 *   {ARTIFACT_NAME}  npm name of the schema package (e.g. @auditlogic/schema-github-github)
 *                    → emitted as `{ARTIFACT_NAME}-ts` in the template's `name` field
 *   {VERSION}        project.version (the schema package's resolved version — TS twin
 *                    publishes at the same version)
 *   {REPO_URL}       git remote URL of the consuming repo
 *                    (e.g. git@github.com:auditlogic/schema.git)
 *   {REPO_DIR}       package directory inside the repo, from package.json's
 *                    repository.directory (e.g. package/github/github)
 *   {PACKAGE_NAME}   zerobias.package (or auditmation.package fallback) — the
 *                    canonical schema identifier loaded by dataloader
 *                    (e.g. github.github.schema). Only appears inside
 *                    scripts.generate for `npx schema-ts-generator -p …`.
 */
object TsTemplatePatcher {

    /** Substitute placeholders in package-template.json text. */
    @JvmStatic
    fun patchPackageJson(
        templateText: String,
        artifactName: String,
        version: String,
        repoUrl: String,
        repoDir: String,
        packageName: String,
    ): String {
        var s = templateText
        s = s.replace("{ARTIFACT_NAME}", artifactName)
        s = s.replace("{VERSION}", version)
        s = s.replace("{REPO_URL}", repoUrl)
        s = s.replace("{REPO_DIR}", repoDir)
        s = s.replace("{PACKAGE_NAME}", packageName)
        return s
    }

    /**
     * Substitute placeholders in package-lock-template.json. npm
     * lockfiles carry name+version both at the top level and inside
     * `packages.""`; the legacy generate.sh patched both via a chained jq
     * expression. We do the same here with jackson so the JSON byte
     * shape stays consistent with what npm itself would produce.
     */
    @JvmStatic
    fun patchPackageLockJson(
        templateText: String,
        artifactName: String,
        version: String,
    ): String {
        val mapper = ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT)
        val root = mapper.readTree(templateText) as ObjectNode

        if (root.has("name")) root.put("name", "$artifactName-ts")
        if (root.has("version")) root.put("version", version)

        val packages = root.get("packages")
        if (packages is ObjectNode && packages.has("")) {
            val selfEntry = packages.get("") as? ObjectNode
            if (selfEntry != null) {
                if (selfEntry.has("name")) selfEntry.put("name", "$artifactName-ts")
                if (selfEntry.has("version")) selfEntry.put("version", version)
            }
        }
        return mapper.writeValueAsString(root)
    }

    /**
     * Resolve `{ARTIFACT_NAME}` / `{VERSION}` etc. and write the patched
     * `package.json` + `package-lock.json` into the given ts/ directory.
     *
     * @param tsDir          the destination `<pkg>/ts/` directory
     * @param templatePkg    raw `package-template.json` text
     * @param templateLock   raw `package-lock-template.json` text
     * @param artifactName   npm name of the schema package
     * @param version        project.version
     * @param repoUrl        git remote URL (auto-derived by caller)
     * @param repoDir        repository.directory from package.json
     * @param packageName    zerobias.package
     */
    @JvmStatic
    fun writePatchedTemplate(
        tsDir: File,
        templatePkg: String,
        templateLock: String,
        artifactName: String,
        version: String,
        repoUrl: String,
        repoDir: String,
        packageName: String,
    ) {
        tsDir.mkdirs()
        tsDir.resolve("package.json").writeText(
            patchPackageJson(templatePkg, artifactName, version, repoUrl, repoDir, packageName)
        )
        tsDir.resolve("package-lock.json").writeText(
            patchPackageLockJson(templateLock, artifactName, version)
        )
    }

    /**
     * Patch only the top-level `version` and `packages.""."version"` fields
     * in a package-lock.json — leaves all nested dependency versions alone.
     * Used at publish time when the lockfile was already staged with the
     * correct name during gate, and only the project version needs to
     * roll forward.
     */
    @JvmStatic
    fun patchPackageLockVersion(lockText: String, version: String): String {
        val mapper = ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT)
        val root = mapper.readTree(lockText) as ObjectNode
        if (root.has("version")) root.put("version", version)
        val packages = root.get("packages")
        if (packages is ObjectNode && packages.has("")) {
            val selfEntry = packages.get("") as? ObjectNode
            if (selfEntry != null && selfEntry.has("version")) {
                selfEntry.put("version", version)
            }
        }
        return mapper.writeValueAsString(root)
    }

    /** Extract the canonical `zerobias.package` (falling back to legacy `auditmation.package`). */
    @JvmStatic
    fun readPackageName(pkgDoc: Map<String, Any?>): String {
        val zb = pkgDoc["zerobias"] as? Map<*, *>
        val am = pkgDoc["auditmation"] as? Map<*, *>
        val pkg = (zb?.get("package") ?: am?.get("package")) as? String
            ?: throw IllegalStateException(
                "package.json missing zerobias.package (and legacy auditmation.package fallback)"
            )
        return pkg
    }

    /** Whether the schema is marked deprecated — TS gen + publish are skipped. */
    @JvmStatic
    fun isDeprecated(pkgDoc: Map<String, Any?>): Boolean {
        val zb = pkgDoc["zerobias"] as? Map<*, *>
        val am = pkgDoc["auditmation"] as? Map<*, *>
        return (zb?.get("deprecated") ?: am?.get("deprecated")) == true
    }

    // Unused but kept for completeness of the placeholder vocabulary.
    @Suppress("unused")
    private fun nodeAsObject(node: JsonNode?): ObjectNode? = node as? ObjectNode
}
