package com.zerobias.buildtools.monorepo

import org.gradle.api.provider.Property
import org.gradle.api.services.BuildService
import org.gradle.api.services.BuildServiceParameters
import java.util.concurrent.Semaphore

/**
 * Per-build semaphore that caps concurrent docker builds independently of
 * Gradle's global `--max-workers` setting.
 *
 * Docker builds are heavy on CPU, disk, and network (each one runs `npm install`
 * inside the container). Without a cap, parallel docker builds can saturate
 * the host even when overall Gradle parallelism is sane.
 *
 * Honors `DOCKER_BUILD_CONCURRENCY` env var (default: 2). Set higher for hosts
 * with more capacity.
 *
 * Per-build scope: a fresh semaphore for each Gradle invocation. Tasks acquire
 * a permit before running their docker build action and release it in a
 * try/finally.
 *
 * Usage:
 *   abstract class DockerBuildTask : DefaultTask() {
 *     @get:ServiceReference("dockerSemaphore")
 *     abstract val semaphore: Property<DockerSemaphore>
 *
 *     @TaskAction fun build() {
 *       semaphore.get().acquire()
 *       try { ... } finally { semaphore.get().release() }
 *     }
 *   }
 */
abstract class DockerSemaphore : BuildService<DockerSemaphore.Params> {
    interface Params : BuildServiceParameters {
        val maxConcurrent: Property<Int>
    }

    private val semaphore: Semaphore by lazy {
        val max = parameters.maxConcurrent.getOrElse(2)
        Semaphore(max)
    }

    fun acquire() = semaphore.acquire()
    fun release() = semaphore.release()

    /**
     * Convenience: run a block with a permit held.
     */
    fun <T> withPermit(block: () -> T): T {
        acquire()
        try {
            return block()
        } finally {
            release()
        }
    }
}
