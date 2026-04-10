// build.gradle.kts for org/util
// Phase 3: applies the same monorepo Gradle plugins as the consumer
// repos. This is the meta-repo that contains build-tools and zbb.

plugins {
    id("zb.monorepo-base")
    id("zb.monorepo-gate")
    id("zb.monorepo-build")
    id("zb.monorepo-publish")
}
