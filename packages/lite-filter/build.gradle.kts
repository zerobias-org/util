plugins {
    `java-library`
    id("zb.maven-central-publish")
}

group = "com.zerobias"
version = "1.0.2"
description = "A lightweight library for RFC4515 LDAP-style filters with extensions"

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
