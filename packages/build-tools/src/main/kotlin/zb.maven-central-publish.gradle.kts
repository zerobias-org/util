/**
 * Project plugin — publish a Java library to Maven Central, GitHub
 * Packages Maven, and the local ~/.m2/ in one `./gradlew publish`.
 *
 * Applies Vanniktech's com.vanniktech.maven.publish with SonatypeHost
 * CENTRAL_PORTAL (stages the deployment; release is manual at
 * central.sonatype.com, or set automaticRelease via Vanniktech directly
 * if you want full automation).
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
 *   zbMavenCentral {
 *       artifactId.set("lite-filter")
 *       // pomUrl/pomScmUrl/etc overrideable — defaults match the util repo
 *   }
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

// ── DSL extension ───────────────────────────────────────────────────
interface ZbMavenCentralExtension {
    val artifactId: Property<String>
    val pomUrl: Property<String>
    val pomLicenseName: Property<String>
    val pomLicenseUrl: Property<String>
    val pomDeveloperId: Property<String>
    val pomDeveloperName: Property<String>
    val pomDeveloperEmail: Property<String>
    val pomDeveloperOrganization: Property<String>
    val pomDeveloperOrganizationUrl: Property<String>
    val pomScmUrl: Property<String>
    val pomScmConnection: Property<String>
    val pomScmDeveloperConnection: Property<String>
}

val zbExt = extensions.create<ZbMavenCentralExtension>("zbMavenCentral").apply {
    // Util-repo defaults — most packages just set artifactId and go.
    pomUrl.convention("https://github.com/zerobias-org/util")
    pomLicenseName.convention("Apache License, Version 2.0")
    pomLicenseUrl.convention("http://www.apache.org/licenses/LICENSE-2.0.txt")
    pomDeveloperId.convention("kmccarthy")
    pomDeveloperName.convention("Kevin McCarthy")
    pomDeveloperEmail.convention("kmccarthy@zerobias.com")
    pomDeveloperOrganization.convention("Zerobias")
    pomDeveloperOrganizationUrl.convention("https://github.com/zerobias-org")
    pomScmUrl.convention("https://github.com/zerobias-org/util/tree/main")
    pomScmConnection.convention("scm:git:git://github.com/zerobias-org/util.git")
    pomScmDeveloperConnection.convention("scm:git:ssh://github.com:zerobias-org/util.git")
}

// ── Vanniktech Maven Central config ─────────────────────────────────
// afterEvaluate so the consumer's `zbMavenCentral { artifactId.set(...) }`
// has run. Vanniktech's coordinates() takes eager Strings.
afterEvaluate {
    mavenPublishing {
        publishToMavenCentral(SonatypeHost.CENTRAL_PORTAL, automaticRelease = false)
        signAllPublications()
        configure(JavaLibrary(javadocJar = JavadocJar.Javadoc(), sourcesJar = true))

        coordinates(
            project.group.toString(),
            zbExt.artifactId.get(),
            project.version.toString(),
        )

        pom {
            name.set(zbExt.artifactId)
            description.set(project.description ?: zbExt.artifactId.get())
            url.set(zbExt.pomUrl)
            licenses {
                license {
                    name.set(zbExt.pomLicenseName)
                    url.set(zbExt.pomLicenseUrl)
                    distribution.set("repo")
                }
            }
            developers {
                developer {
                    id.set(zbExt.pomDeveloperId)
                    name.set(zbExt.pomDeveloperName)
                    email.set(zbExt.pomDeveloperEmail)
                    organization.set(zbExt.pomDeveloperOrganization)
                    organizationUrl.set(zbExt.pomDeveloperOrganizationUrl)
                }
            }
            scm {
                url.set(zbExt.pomScmUrl)
                connection.set(zbExt.pomScmConnection)
                developerConnection.set(zbExt.pomScmDeveloperConnection)
            }
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
