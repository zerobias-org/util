package com.zerobias.buildtools.monorepo

import java.io.File

/**
 * Locates the meta-repo checkout (the directory holding `com/`, `org/`, …).
 *
 * Tests used to hardcode `/root/nfa-repos`, which silently `assumeTrue`-skipped
 * on every checkout that wasn't at that exact path — so parity and integration
 * coverage quietly did nothing for most developers. Resolve it instead:
 *
 *  1. `-DmetaRepo=/path` / `META_REPO=/path` — explicit override
 *  2. walk up from the working dir looking for a `com/` + `org/` pair
 *  3. `/root/nfa-repos` — the historical default, for CI images that use it
 */
object MetaRepo {

    val root: File? by lazy { locate() }

    /** The devops checkout, source of the JS prepublish implementation. */
    val devops: File? get() = root?.resolve("org/devops")?.takeIf { it.isDirectory }

    fun repo(relative: String): File? = root?.resolve(relative)?.takeIf { it.isDirectory }

    private fun locate(): File? {
        val explicit = System.getProperty("metaRepo") ?: System.getenv("META_REPO")
        if (!explicit.isNullOrBlank()) {
            return File(explicit).takeIf { it.isDirectory }
        }

        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            if (looksLikeMetaRepo(dir)) return dir
            dir = dir.parentFile
        }

        return File("/root/nfa-repos").takeIf { looksLikeMetaRepo(it) }
    }

    private fun looksLikeMetaRepo(dir: File): Boolean =
        File(dir, "com").isDirectory && File(dir, "org").isDirectory
}
