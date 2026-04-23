import com.vanniktech.maven.publish.JavaLibrary
import com.vanniktech.maven.publish.JavadocJar
import com.vanniktech.maven.publish.SonatypeHost

plugins {
    `java-library`
    id("com.vanniktech.maven.publish") version "0.30.0"
}

group = "com.zerobias"
version = "1.0.2"
description = "A lightweight library for RFC4515 LDAP-style filters with extensions"

// ── Env var → Gradle property mapping ────────────────────────────────
// Readable env vars in the shell (SONATYPE_USERNAME, GPG_SIGNING_KEY, …)
// get mapped here to the property names Vanniktech + Gradle's signing
// plugin expect. Keeps the env surface clean; all name-coupling lives
// in this one file.
listOf(
    "SONATYPE_USERNAME"        to "mavenCentralUsername",
    "SONATYPE_PASSWORD"        to "mavenCentralPassword",
    "GPG_SIGNING_KEY"          to "signingInMemoryKey",
    "GPG_SIGNING_KEY_PASSWORD" to "signingInMemoryKeyPassword",
).forEach { (envVar, propName) ->
    System.getenv(envVar)?.takeIf { it.isNotEmpty() }?.let { extra[propName] = it }
}

java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(21)) }
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(11)
}

tasks.withType<Javadoc>().configureEach {
    (options as StandardJavadocDocletOptions).apply {
        addStringOption("Xdoclint:none", "-quiet")
        encoding = "UTF-8"
    }
}

// Source lives in java/ subdirectory (dual-language project: java/ + npm/)
sourceSets {
    main { java.srcDir("java/src/main/java") }
    test { java.srcDir("java/src/test/java") }
}

repositories {
    mavenCentral()
}

dependencies {
    // Fuzzy matching for ~= operator
    implementation("me.xdrop:fuzzywuzzy:1.4.0")
    // JSON processing for nested property access
    implementation("com.google.code.gson:gson:2.10.1")

    testImplementation(platform("org.junit:junit-bom:5.10.0"))
    testImplementation("org.junit.jupiter:junit-jupiter-api")
    testRuntimeOnly("org.junit.jupiter:junit-jupiter-engine")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
}

// ── Maven Central publishing (Vanniktech) ────────────────────────────
// publishToMavenCentral — stages the bundle on Central Portal; release
// confirmation is manual at central.sonatype.com (automaticRelease=false).
mavenPublishing {
    publishToMavenCentral(SonatypeHost.CENTRAL_PORTAL, automaticRelease = false)
    signAllPublications()
    configure(JavaLibrary(javadocJar = JavadocJar.Javadoc(), sourcesJar = true))

    coordinates("com.zerobias", "lite-filter", project.version.toString())

    pom {
        name.set("lite-filter")
        description.set(project.description)
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

// ── GitHub Packages (second publish target) ──────────────────────────
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

// Convenience alias — the underlying auto-generated task is named
// publishMavenPublicationToGithubRepository; publishToGithub reads cleaner.
tasks.register("publishToGithub") {
    group = "publishing"
    description = "Publish to GitHub Packages Maven repository"
    dependsOn("publishMavenPublicationToGithubRepository")
}

// `zbb publish` (or `./gradlew publish`) runs all three targets: local,
// Maven Central (stages only), GitHub Packages. Order isn't enforced —
// Gradle parallelizes where possible.
tasks.named("publish") {
    dependsOn("publishToMavenLocal", "publishToMavenCentral", "publishToGithub")
}
