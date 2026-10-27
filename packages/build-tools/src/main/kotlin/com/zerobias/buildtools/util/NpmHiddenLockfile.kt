package com.zerobias.buildtools.util

import com.fasterxml.jackson.databind.ObjectMapper
import org.gradle.api.Task
import java.io.File

/**
 * npm's hidden lockfile, `node_modules/.package-lock.json`. npm ≥7 rewrites it at the end of
 * every install with each installed package's version, integrity and link target, so its content
 * changes whenever npm changes the tree and stays byte-identical when an install changes nothing.
 */
object NpmHiddenLockfile {

    const val FILE_NAME = ".package-lock.json"

    /**
     * True when [nodeModules] holds a readable hidden lockfile and every package folder it lists,
     * links included, still resolves on disk. Keys outside a `node_modules` segment are workspace
     * sources (reached through their links) or extraneous leftovers, so they are skipped.
     */
    fun packagesPresent(nodeModules: File): Boolean {
        val lockfile = nodeModules.resolve(FILE_NAME)
        if (!lockfile.isFile) return false
        val packages = try {
            ObjectMapper().readTree(lockfile)?.get("packages")
        } catch (_: Exception) {
            null
        }
        if (packages == null || !packages.isObject) return false
        val root = nodeModules.parentFile
        return packages.fieldNames().asSequence()
            .filter { it.startsWith("node_modules/") || it.contains("/node_modules/") }
            .all { File(root, it).exists() }
    }
}

/**
 * Declares the output of an `npm install` task as npm's hidden lockfile rather than the whole
 * [nodeModules] tree.
 *
 * A directory output makes Gradle fingerprint every file under `node_modules` after each run and
 * on every up-to-date check. A workspace root holds hundreds of thousands of files (com/clients:
 * ~420k); their snapshots fill most of the daemon's default 512 MB heap, and ran `zbb gate` out of it.
 *
 * The task stays up to date while the hidden lockfile is unchanged and every package it lists is
 * on disk ([NpmHiddenLockfile.packagesPresent]), so deleting `node_modules`, the hidden lockfile, or
 * a single package folder (by hand, or the way `zbb registry clear` taints packages without touching
 * a lockfile) still re-runs the install, as the directory output did. Edits made inside an installed
 * package without npm no longer re-run it; `npm install` keeps such edits anyway.
 */
fun Task.declareNodeModulesOutput(nodeModules: File) {
    outputs.file(nodeModules.resolve(NpmHiddenLockfile.FILE_NAME)).withPropertyName("npmHiddenLockfile")
    outputs.upToDateWhen { NpmHiddenLockfile.packagesPresent(nodeModules) }
}
