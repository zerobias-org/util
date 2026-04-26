package com.zerobias.buildtools.util

import org.gradle.api.provider.Property

/**
 * Extension registered by `zb.maven-central-publish`. When `baseVersion`
 * is set, the plugin resolves `project.version` by querying Maven Central
 * + GitHub Packages metadata and picking the next free patch in
 * `<baseVersion>.*` .
 *
 * Must be a top-level class. When this was declared as a nested abstract
 * class inside `zb.maven-central-publish.gradle.kts`, Gradle's managed-
 * type generator silently failed to register the extension on the
 * project — `extensions.create()` returned a usable instance but
 * consumer scripts hit "Could not find method mavenCentralPublish()".
 */
abstract class MavenCentralPublishExtension {
    abstract val baseVersion: Property<String>
}
