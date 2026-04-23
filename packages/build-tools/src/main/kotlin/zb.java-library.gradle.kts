// ════════════════════════════════════════════════════════════════════════════
// zb.java-library — Convention plugin for standalone Java libraries
//
// Provides:
//   - java-library + maven-publish + signing plugins
//   - Java 21 toolchain with --release 11 for broad compatibility
//   - Source JAR + Javadoc JAR generation
//   - JUnit 5 test platform
//   - Maven Central publishing via Sonatype Central Portal
//   - GPG signing (in-memory key support for CI)
//   - zbJavaLibrary extension for POM metadata
// ════════════════════════════════════════════════════════════════════════════

plugins {
    `java-library`
    `maven-publish`
    signing
}

// ── Extension for POM metadata ──────────────────────────────────────────────

interface ZbJavaLibraryExtension {
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

val zbJavaLibrary = extensions.create<ZbJavaLibraryExtension>("zbJavaLibrary")

// ── Java toolchain ──────────────────────────────────────────────────────────

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
    withSourcesJar()
    withJavadocJar()
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(11)
}

tasks.withType<Javadoc>().configureEach {
    (options as StandardJavadocDocletOptions).apply {
        addStringOption("Xdoclint:none", "-quiet")
        encoding = "UTF-8"
        source = "11"
    }
}

// ── Testing ─────────────────────────────────────────────────────────────────

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
}

// ── Repositories ────────────────────────────────────────────────────────────

repositories {
    mavenCentral()
}

// ── Lifecycle tasks (matching zb.base naming) ───────────────────────────────

val validate by tasks.registering {
    group = "lifecycle"
    description = "Validate project configuration"
}

val gate by tasks.registering {
    group = "lifecycle"
    description = "Full CI gate: compile + test + build artifacts"
    dependsOn(tasks.named("build"))
}

// ── Maven Central publishing ────────────────────────────────────────────────

publishing {
    publications {
        create<MavenPublication>("mavenCentral") {
            from(components["java"])

            afterEvaluate {
                groupId = project.group.toString()
                artifactId = project.name
                version = project.version.toString()
            }

            pom {
                afterEvaluate {
                    this@pom.name.set(project.name)
                    this@pom.description.set(project.description)
                    this@pom.url.set(zbJavaLibrary.pomUrl)
                }

                licenses {
                    license {
                        name.set(zbJavaLibrary.pomLicenseName)
                        url.set(zbJavaLibrary.pomLicenseUrl)
                        distribution.set("repo")
                    }
                }

                developers {
                    developer {
                        id.set(zbJavaLibrary.pomDeveloperId)
                        name.set(zbJavaLibrary.pomDeveloperName)
                        email.set(zbJavaLibrary.pomDeveloperEmail)
                        organization.set(zbJavaLibrary.pomDeveloperOrganization)
                        organizationUrl.set(zbJavaLibrary.pomDeveloperOrganizationUrl)
                    }
                }

                scm {
                    url.set(zbJavaLibrary.pomScmUrl)
                    connection.set(zbJavaLibrary.pomScmConnection)
                    developerConnection.set(zbJavaLibrary.pomScmDeveloperConnection)
                }
            }
        }
    }

    repositories {
        maven {
            name = "sonatypeCentralPortal"
            url = uri("https://central.sonatype.com/api/v1/publisher/deployments/download")
            credentials {
                username = providers.gradleProperty("sonatypeUsername")
                    .orElse(providers.environmentVariable("SONATYPE_USERNAME"))
                    .orNull
                password = providers.gradleProperty("sonatypePassword")
                    .orElse(providers.environmentVariable("SONATYPE_PASSWORD"))
                    .orNull
            }
        }
        maven {
            name = "localStaging"
            url = uri(layout.buildDirectory.dir("staging-deploy"))
        }
    }
}

// ── GPG signing ─────────────────────────────────────────────────────────────

// Signing is required for Maven Central but optional for local development.
// Only configure signing when credentials are available.
val signingKey = providers.gradleProperty("signingKey")
    .orElse(providers.environmentVariable("GPG_SIGNING_KEY"))
    .orNull
val hasGpgKeyName = providers.gradleProperty("signing.gnupg.keyName").isPresent

if (signingKey != null || hasGpgKeyName) {
    signing {
        if (signingKey != null) {
            val signingPassword = providers.gradleProperty("signingPassword")
                .orElse(providers.environmentVariable("GPG_SIGNING_PASSWORD"))
                .orNull
            useInMemoryPgpKeys(signingKey, signingPassword)
        } else {
            useGpgCmd()
        }
        sign(publishing.publications["mavenCentral"])
    }
}

// ── Convenience tasks ───────────────────────────────────────────────────────

val publishToMavenCentral by tasks.registering {
    group = "publish"
    description = "Publish signed artifacts to Maven Central (Sonatype Central Portal)"
    dependsOn("publishMavenCentralPublicationToSonatypeCentralPortalRepository")
}

val publishToLocalStaging by tasks.registering {
    group = "publish"
    description = "Publish signed artifacts to local staging directory for inspection"
    dependsOn("publishMavenCentralPublicationToLocalStagingRepository")
}
