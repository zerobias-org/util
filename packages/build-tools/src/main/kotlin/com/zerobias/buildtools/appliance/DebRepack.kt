package com.zerobias.buildtools.appliance

import org.apache.commons.compress.archivers.ar.ArArchiveEntry
import org.apache.commons.compress.archivers.ar.ArArchiveInputStream
import org.apache.commons.compress.archivers.ar.ArArchiveOutputStream
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.apache.commons.compress.compressors.gzip.GzipCompressorInputStream
import org.apache.commons.compress.compressors.gzip.GzipCompressorOutputStream
import org.apache.commons.compress.compressors.gzip.GzipParameters
import org.apache.commons.compress.compressors.xz.XZCompressorInputStream
import org.apache.commons.compress.compressors.xz.XZCompressorOutputStream
import org.apache.commons.compress.compressors.zstandard.ZstdCompressorInputStream
import org.apache.commons.compress.compressors.zstandard.ZstdCompressorOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.Date
import java.util.Comparator

// ────────────────────────────────────────────────────────────────────────
// DebRepack — pure-JVM deterministic deb post-processor.
//
// Replaces the historical com/node/scripts/repack-deb-deterministic.sh.
// The shell script depended on GNU tar (`tar --sort=name --mtime=@0 ...`),
// which doesn't ship by default on macOS — making local builds fail with
// "GNU tar required". This impl uses Apache commons-compress and runs
// identically on any host with a JVM.
//
// What "deterministic" means here:
//   1. Outer ar: zero mtime, root uid/gid, fixed mode in member headers.
//      Member order: debian-binary, control.tar.*, data.tar.* (deb(5)
//      requires this).
//   2. Inner control.tar.* and data.tar.*: sorted by entry name, mtime=0,
//      uid/gid=0, uname/gname empty, GNU long-file format (matches
//      --format=gnu --numeric-owner from the shell script).
//   3. Recompression strips header metadata (gzip filename + mtime, etc.).
//
// Idempotent: running on an already-normalised deb produces identical
// bytes. Same property the shell script provided.
//
// Memory model: all heavy data flows through temp files. Peak heap is
// dominated by tar-entry metadata (a few hundred bytes per entry) plus a
// single 8 KiB stream buffer per active stream. The `shared` deb bundles
// ~200 MiB of decompressed node_modules and processes in well under
// 100 MiB of heap.
// ────────────────────────────────────────────────────────────────────────

/**
 * Post-process a built .deb so its bytes are a pure function of the source
 * file content (no filesystem mtimes, no traversal-order surprises).
 *
 * Why: nebula.ospackage / jdeb pass file mtimes through to data.tar
 * verbatim; the AbstractArchiveTask `setPreserveFileTimestamps(false)`
 * flag is silently ignored by nebula's DebCopyAction. Without this
 * post-process, two consecutive builds of identical sources produce
 * different data.tar bytes, breaking the tag-time → publish-time
 * payload-sha contract that :publishRelease enforces.
 */
internal fun repackDebDeterministicJvm(deb: File) {
    require(deb.exists()) { "repackDebDeterministicJvm: ${deb.absolutePath} does not exist" }

    val workDir: Path = Files.createTempDirectory("debrepack-")
    try {
        // Stream the input deb's ar members to temp files. We don't hold
        // member bytes in memory — only (name, tempPath) pairs.
        val members: MutableList<Pair<String, Path>> = mutableListOf()
        deb.inputStream().use { fileIn ->
            ArArchiveInputStream(fileIn).use { ar ->
                var idx = 0
                while (true) {
                    val entry = ar.nextEntry ?: break
                    val raw = workDir.resolve("member-$idx.raw")
                    Files.newOutputStream(raw).use { ar.copyTo(it) }
                    members += entry.name to raw
                    idx++
                }
            }
        }

        // Repack tar members in place (replaces the temp file with the
        // normalised version). debian-binary has no inner archive — left
        // alone.
        for ((name, path) in members) {
            if (isInnerTar(name)) repackTarTempFile(path, tarExt(name), workDir)
        }

        // deb(5) member order: debian-binary, control.*, data.*
        val ordered = orderDebMembers(members)

        // Atomic replace via rename(2) on same filesystem.
        val tmpDeb = File(deb.parentFile, "${deb.name}.repack.tmp")
        tmpDeb.outputStream().use { fileOut ->
            ArArchiveOutputStream(fileOut).use { ar ->
                for ((memberName, memberPath) in ordered) {
                    val size = Files.size(memberPath)
                    // Deterministic ar header: mtime=0, uid=gid=0,
                    // mode 100644 (regular file). Same values as `ar -rcD`.
                    val newEntry = ArArchiveEntry(
                        memberName,
                        size,
                        0,                  // userId
                        0,                  // groupId
                        "100644".toInt(8),  // mode (octal 100644)
                        0L,                 // lastModified (epoch ms)
                    )
                    ar.putArchiveEntry(newEntry)
                    Files.newInputStream(memberPath).use { it.copyTo(ar) }
                    ar.closeArchiveEntry()
                }
            }
        }
        if (!tmpDeb.renameTo(deb)) {
            // Fall back: copy + delete (cross-fs or other rename failure).
            Files.move(
                tmpDeb.toPath(),
                deb.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
            )
        }
    } finally {
        deleteRecursively(workDir)
    }
}

private data class TarEntryMeta(
    val name: String,
    val mode: Int,
    val linkFlag: Byte,
    val linkName: String,
    val isFile: Boolean,
    val payload: Path?,   // null for non-file entries (dirs, symlinks, etc.)
    val payloadSize: Long,
)

/**
 * Decompress the tar member at `path`, stream entries to per-entry temp
 * files, sort by name, and rewrite as a normalised tar at the same path.
 * Replaces the historical shell `tar --sort=name --mtime=@0 ...` pipeline.
 */
private fun repackTarTempFile(path: Path, ext: String, workDir: Path) {
    val entryDir = Files.createTempDirectory(workDir, "tar-entries-")
    val decompressed = workDir.resolve("${path.fileName}.tar")
    try {
        // Step 1: decompress to a plain tar temp file (streamed).
        Files.newInputStream(path).use { rawIn ->
            decompress(rawIn, ext).use { dec ->
                Files.newOutputStream(decompressed).use { out -> dec.copyTo(out) }
            }
        }

        // Step 2: stream-read entries; payload bytes go to disk.
        val entries: MutableList<TarEntryMeta> = mutableListOf()
        Files.newInputStream(decompressed).use { tarIn ->
            TarArchiveInputStream(tarIn).use { tar ->
                var idx = 0
                while (true) {
                    val e = tar.nextEntry ?: break
                    val payload: Path? = if (e.isFile && e.size > 0) {
                        val p = entryDir.resolve("$idx.bin")
                        Files.newOutputStream(p).use { tar.copyTo(it) }
                        p
                    } else null
                    entries += TarEntryMeta(
                        name = e.name,
                        mode = e.mode,
                        linkFlag = e.linkFlag,
                        linkName = e.linkName ?: "",
                        isFile = e.isFile,
                        payload = payload,
                        payloadSize = if (e.isFile) e.size else 0L,
                    )
                    idx++
                }
            }
        }

        // Step 3: sort by entry name (matches `tar --sort=name`).
        entries.sortBy { it.name }

        // Step 4: write normalised tar + recompress in one stream pipeline.
        Files.newOutputStream(path).use { rawOut ->
            compress(rawOut, ext).use { compOut ->
                TarArchiveOutputStream(compOut).use { tar ->
                    // GNU format + numeric owner: matches the shell
                    // script's --format=gnu --numeric-owner. LONGFILE_GNU
                    // lets long paths flow through unchanged.
                    tar.setLongFileMode(TarArchiveOutputStream.LONGFILE_GNU)
                    tar.setBigNumberMode(TarArchiveOutputStream.BIGNUMBER_STAR)
                    tar.setAddPaxHeadersForNonAsciiNames(false)
                    for (m in entries) {
                        val out = TarArchiveEntry(m.name, m.linkFlag)
                        out.setSize(m.payloadSize)
                        out.setMode(m.mode)
                        if (m.linkName.isNotEmpty()) out.linkName = m.linkName
                        out.userId = 0
                        out.groupId = 0
                        out.userName = ""
                        out.groupName = ""
                        // Date(0) = 1970-01-01T00:00:00Z. Matches
                        // `--mtime=@0`.
                        out.modTime = Date(0)
                        tar.putArchiveEntry(out)
                        m.payload?.let { p ->
                            Files.newInputStream(p).use { it.copyTo(tar) }
                        }
                        tar.closeArchiveEntry()
                    }
                    tar.finish()
                }
            }
        }
    } finally {
        deleteRecursively(entryDir)
        Files.deleteIfExists(decompressed)
    }
}

private fun isInnerTar(name: String): Boolean =
    name == "control.tar" ||
        name.startsWith("control.tar.") ||
        name == "data.tar" ||
        name.startsWith("data.tar.")

private fun tarExt(name: String): String =
    if (name == "control.tar" || name == "data.tar") ""
    else name.substringAfterLast('.', missingDelimiterValue = "")

private fun decompress(input: InputStream, ext: String): InputStream = when (ext) {
    "gz" -> GzipCompressorInputStream(input)
    "xz" -> XZCompressorInputStream(input)
    "zst", "zstd" -> ZstdCompressorInputStream(input)
    "tar", "" -> input  // uncompressed inner tar (rare, but legal)
    else -> error("DebRepack: unsupported compression extension '.$ext'")
}

private fun compress(output: OutputStream, ext: String): OutputStream = when (ext) {
    "gz" -> {
        // Strip the gzip header timestamp (matches `gzip -n`). Filename
        // and comment are also nulled — anything stored there would vary
        // across hosts.
        val params = GzipParameters().apply {
            modificationTime = 0L
            fileName = null
            comment = null
        }
        GzipCompressorOutputStream(output, params)
    }
    "xz" -> XZCompressorOutputStream(output)
    "zst", "zstd" -> ZstdCompressorOutputStream(output)
    "tar", "" -> output
    else -> error("DebRepack: unsupported compression extension '.$ext'")
}

/**
 * deb(5) member order: debian-binary, then control.tar.*, then data.tar.*.
 * Anything unrecognised goes after data (preserves source order).
 */
private fun orderDebMembers(
    members: List<Pair<String, Path>>,
): List<Pair<String, Path>> {
    val ordered = mutableListOf<Pair<String, Path>>()
    members.firstOrNull { it.first == "debian-binary" }?.let(ordered::add)
    members
        .filter { it.first == "control.tar" || it.first.startsWith("control.tar.") }
        .forEach(ordered::add)
    members
        .filter { it.first == "data.tar" || it.first.startsWith("data.tar.") }
        .forEach(ordered::add)
    val seen = ordered.map { it.first }.toSet()
    members
        .filter { it.first !in seen && it.first != "debian-binary" }
        .forEach(ordered::add)
    return ordered
}

private fun deleteRecursively(dir: Path) {
    if (!Files.exists(dir)) return
    try {
        Files.walk(dir).use { walk ->
            walk.sorted(Comparator.reverseOrder()).forEach { p ->
                try { Files.deleteIfExists(p) } catch (_: Exception) {}
            }
        }
    } catch (_: Exception) {
        // best-effort; leaving temp files is annoying but not fatal
    }
}
