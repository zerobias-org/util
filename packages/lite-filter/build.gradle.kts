plugins {
    id("zb.java-library")
}

group = "com.zerobias"
version = "1.0.1"
description = "A lightweight library for RFC4515 LDAP-style filters with extensions"

// Source lives in java/ subdirectory (dual-language project: java/ + npm/)
sourceSets {
    main {
        java.srcDir("java/src/main/java")
    }
    test {
        java.srcDir("java/src/test/java")
    }
}

dependencies {
    // Fuzzy matching for ~= operator
    implementation("me.xdrop:fuzzywuzzy:1.4.0")
    // JSON processing for nested property access
    implementation("com.google.code.gson:gson:2.10.1")

    // JUnit 5
    testImplementation(platform("org.junit:junit-bom:5.10.0"))
    testImplementation("org.junit.jupiter:junit-jupiter-api")
    testRuntimeOnly("org.junit.jupiter:junit-jupiter-engine")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

zbJavaLibrary {
    pomUrl.set("https://github.com/zerobias-org/util")
    pomLicenseName.set("Apache License, Version 2.0")
    pomLicenseUrl.set("http://www.apache.org/licenses/LICENSE-2.0.txt")
    pomDeveloperId.set("kmccarthy")
    pomDeveloperName.set("Kevin McCarthy")
    pomDeveloperEmail.set("kmccarthy@zerobias.com")
    pomDeveloperOrganization.set("Zerobias")
    pomDeveloperOrganizationUrl.set("https://github.com/zerobias-org")
    pomScmUrl.set("https://github.com/zerobias-org/util/tree/main")
    pomScmConnection.set("scm:git:git://github.com/zerobias-org/util.git")
    pomScmDeveloperConnection.set("scm:git:ssh://github.com:zerobias-org/util.git")
}
