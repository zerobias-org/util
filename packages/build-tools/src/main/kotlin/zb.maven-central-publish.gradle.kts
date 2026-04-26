/**
 * Project plugin — publish a Java library to Maven Central, GitHub
 * Packages Maven, and local ~/.m2/ in one `./gradlew publish`.
 *
 * Applies Vanniktech's com.vanniktech.maven.publish with SonatypeHost
 * CENTRAL_PORTAL (stages the deployment; release is manual at
 * central.sonatype.com, or pass automaticRelease=true to Vanniktech
 * for full automation).
 *
 * Coordinates are auto-derived by Vanniktech from project metadata:
 *   groupId    = project.group
 *   artifactId = project.name  (use `base.archivesName` to override in
 *                the consumer if it must differ from the project name)
 *   version    = project.version
 *
 * POM defaults target the util repo. Override in the consumer via the
 * standard Vanniktech `mavenPublishing { pom { ... } }` block if needed.
 *
 * Credentials flow in through zbb's slot env via the `zb.slot-env`
 * SETTINGS plugin (apply in the consumer's settings.gradle.kts). This
 * project plugin reads them via providers.gradleProperty().
 *
 * Usage in a consumer's build.gradle.kts:
 *
 *   plugins {
 *       `java-library`
 *       id("zb.maven-central-publish")
 *   }
 *
 *   group = "com.zerobias"
 *   version = "1.0.2"
 *   description = "..."
 *
 * `publish` runs all three targets:
 *   publishToMavenLocal
 *   publishToMavenCentral   (stages only; manual release)
 *   publishToGithub         (alias for publishMavenPublicationToGithubRepository)
 */

import com.vanniktech.maven.publish.JavaLibrary
import com.vanniktech.maven.publish.JavadocJar
import com.vanniktech.maven.publish.SonatypeHost
import com.zerobias.buildtools.util.MavenCentralPublishExtension
import com.zerobias.buildtools.util.VersionResolver

plugins {
    id("com.vanniktech.maven.publish")
}

// ── Extension: `mavenCentralPublish { baseVersion = "1.0" }` ─────────
//
// When baseVersion is set, the plugin resolves project.version by
// querying both Maven Central + GitHub Packages metadata for the
// artifact and picking the next available patch in <baseVersion>.* .
// This pushes auto-bump responsibility into the plugin so consumer
// build files don't import VersionResolver (which isn't on the root
// monorepo's buildscript classpath when the package is a subproject).
//
// Consumer usage:
//
//   plugins { `java-library`; id("zb.maven-central-publish") }
//   group = "com.zerobias"
//   mavenCentralPublish { baseVersion = "1.0" }
//
// If baseVersion is NOT set, project.version is left to the consumer
// (back-compat for anyone pinning an explicit version).
//
// MavenCentralPublishExtension must be a top-level class — see
// com/zerobias/buildtools/util/MavenCentralPublishExtension.kt for why.
val mcpExt = extensions.create<MavenCentralPublishExtension>("mavenCentralPublish")

afterEvaluate {
    if (!mcpExt.baseVersion.isPresent) return@afterEvaluate

    // Artifact id defaults to base.archivesName when set (e.g. codegen
    // overrides to `hub-module-codegen`), else project.name.
    val artifact = project.extensions.findByType<BasePluginExtension>()
        ?.archivesName?.orNull
        ?: project.name

    val resolved = VersionResolver.autoBumpPatch(
        project.group.toString(),
        artifact,
        mcpExt.baseVersion.get(),
    )
    project.version = resolved
    logger.lifecycle("[zb.maven-central-publish] resolved version for $artifact: $resolved")
}

// Diagnostic: log whether the signing credentials are visible at plugin
// apply time. If signingInMemoryKey is NULL here, Vanniktech's
// signAllPublications() won't configure the signatory, and signing
// tasks fail with "no configured signatory".
listOf(
    "mavenCentralUsername",
    "signingInMemoryKey",
    "signingInMemoryKeyPassword",
).forEach { propName ->
    val v = project.findProperty(propName) as? String
    val status = when {
        v == null -> "NULL"
        v.isEmpty() -> "EMPTY"
        else -> "SET (${v.length} chars)"
    }
    println("[zb.maven-central-publish] $propName = $status")
}

// ── Vanniktech Maven Central config ─────────────────────────────────
mavenPublishing {
    publishToMavenCentral(SonatypeHost.CENTRAL_PORTAL, automaticRelease = false)
    signAllPublications()
    configure(JavaLibrary(javadocJar = JavadocJar.Javadoc(), sourcesJar = true))
    // No coordinates() call — Vanniktech auto-derives from project.

    pom {
        // name/description auto-read from project.name / project.description
        url.set("https://github.com/zerobias-org/util")
        licenses {
            license {
                name.set("Apache License, Version 2.0")
                url.set("http://www.apache.org/licenses/LICENSE-2.0.txt")
                distribution.set("repo")
            }
        }
        developers {
            developer {
                id.set("kmccarthy")
                name.set("Kevin McCarthy")
                email.set("kmccarthy@zerobias.com")
                organization.set("Zerobias")
                organizationUrl.set("https://github.com/zerobias-org")
            }
        }
        scm {
            url.set("https://github.com/zerobias-org/util/tree/main")
            connection.set("scm:git:git://github.com/zerobias-org/util.git")
            developerConnection.set("scm:git:ssh://github.com:zerobias-org/util.git")
        }
    }
}

// ── GitHub Packages (second publish target) ─────────────────────────
publishing {
    repositories {
        maven {
            name = "github"
            url = uri("https://maven.pkg.github.com/zerobias-org/util")
            credentials {
                username = System.getenv("GITHUB_ACTOR") ?: "zerobias-org"
                password = System.getenv("GITHUB_TOKEN") ?: ""
            }
        }
    }
}

// Alias — the auto-generated task is publishMavenPublicationToGithubRepository;
// publishToGithub reads cleaner and matches the publishToMavenLocal /
// publishToMavenCentral naming.
tasks.register("publishToGithub") {
    group = "publishing"
    description = "Publish to GitHub Packages Maven repository"
    dependsOn(tasks.matching {
        it.name.startsWith("publish") && it.name.endsWith("PublicationToGithubRepository")
    })
}

// `publish` runs all three targets.
tasks.named("publish") {
    dependsOn("publishToMavenLocal", "publishToMavenCentral", "publishToGithub")
}

// Signing is only required by Maven Central. GitHub Packages and Maven
// Local accept unsigned artifacts. Skip sign tasks when signing creds
// aren't configured — lets local `./gradlew publishToGithub` work
// without needing a PGP key. In CI, vault provides the creds so signing
// runs normally as a prerequisite of publishToMavenCentral.
tasks.withType<Sign>().configureEach {
    onlyIf("signing creds present") {
        val key = providers.gradleProperty("signingInMemoryKey").orNull
        val pw = providers.gradleProperty("signingInMemoryKeyPassword").orNull
        !key.isNullOrBlank() && !pw.isNullOrBlank()
    }
}

// Idempotency: skip GitHub Packages upload when the artifact version already
// exists (409 Conflict otherwise). maven-publish registers its tasks lazily
// so we configure in afterEvaluate.
afterEvaluate {
    tasks.named("publishMavenPublicationToGithubRepository") {
        onlyIf("version not yet published to GitHub Packages") {
            val token = System.getenv("GITHUB_TOKEN")
            if (token.isNullOrEmpty()) {
                true
            } else {
                val groupPath = project.group.toString().replace('.', '/')
                val artifact = project.name
                val ver = project.version.toString()
                val url = "https://maven.pkg.github.com/zerobias-org/util/$groupPath/$artifact/$ver/$artifact-$ver.jar"
                try {
                    val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                    conn.requestMethod = "HEAD"
                    conn.setRequestProperty("Authorization", "Bearer $token")
                    conn.connectTimeout = 5000
                    conn.readTimeout = 5000
                    conn.connect()
                    val code = conn.responseCode
                    conn.disconnect()
                    if (code == 200) {
                        logger.lifecycle("[:$artifact:$ver] already on GitHub Packages — skipping")
                        false
                    } else {
                        true
                    }
                } catch (e: Exception) {
                    logger.warn("[:$artifact] GitHub Packages HEAD check failed — proceeding: ${e.message}")
                    true
                }
            }
        }
    }
}
