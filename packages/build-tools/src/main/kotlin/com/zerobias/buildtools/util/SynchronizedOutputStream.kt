package com.zerobias.buildtools.util

import java.io.OutputStream

/**
 * Thread-safe wrapper around an [OutputStream] that serializes all
 * write/flush/close calls under a single monitor.
 *
 * Why this exists:
 *
 * The per-task tee captures gradle Exec output by setting
 * `standardOutput` and `errorOutput` to OutputStreams that fan out to a
 * per-task log file, the central .zbb-gradle/gradle.log, and the
 * console. Gradle reads stdout and stderr from spawned processes on
 * SEPARATE threads, both of which call `write()` on those streams.
 *
 * The underlying [java.io.BufferedOutputStream] is not synchronized.
 * Two threads racing on its internal `count++` can read the same
 * offset, both write at that offset, then both increment count — the
 * second write overwrites the first AND advances `count` past
 * uninitialized buffer bytes. When the buffer is later flushed, the
 * gap (zero-filled by Java's default byte[] init) ends up on disk.
 *
 * Symptom: long runs of NULL bytes (\\0) appearing at random offsets
 * in gradle.log, especially under tasks with chatty stderr (eslint
 * warnings, tsc errors, npm progress).
 *
 * Wrapping the shared underlying streams in this class serializes all
 * writes through a single monitor, eliminating the race.
 */
class SynchronizedOutputStream(private val delegate: OutputStream) : OutputStream() {
    private val lock = Any()

    override fun write(b: Int) {
        synchronized(lock) { delegate.write(b) }
    }

    override fun write(b: ByteArray) {
        synchronized(lock) { delegate.write(b) }
    }

    override fun write(b: ByteArray, off: Int, len: Int) {
        synchronized(lock) { delegate.write(b, off, len) }
    }

    override fun flush() {
        synchronized(lock) { delegate.flush() }
    }

    override fun close() {
        synchronized(lock) { delegate.close() }
    }
}
