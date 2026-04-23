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

plugins {
    id("com.vanniktech.maven.publish")
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
                password = System.getenv("NPM_TOKEN") ?: System.getenv("GITHUB_TOKEN") ?: ""
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
    dependsOn("publishMavenPublicationToGithubRepository")
}

// `publish` runs all three targets.
tasks.named("publish") {
    dependsOn("publishToMavenLocal", "publishToMavenCentral", "publishToGithub")
}
