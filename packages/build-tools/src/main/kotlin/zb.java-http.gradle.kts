import com.zerobias.buildtools.ZbExtension

plugins {
    id("zb.base")
}

val zb = extensions.getByType<ZbExtension>()

// ── VALIDATE ──

val validatePom by tasks.registering {
    group = "lifecycle"
    description = "Validate pom.xml exists in java/ directory"
    doLast {
        require(project.file("java/pom.xml").exists()) {
            "Java HTTP modules must have java/pom.xml"
        }
    }
}

tasks.named("validate") {
    dependsOn(validatePom)
}

// ── GENERATE ──

val generateJava by tasks.registering(Exec::class) {
    group = "lifecycle"
    description = "Generate Java interfaces from OpenAPI"
    dependsOn(tasks.named("validate"))
    workingDir(project.projectDir)
    commandLine("npx", "hub-generator", "generate", "-g", "java-http",
        "-i", "api.yml", "-o", "java/src/generated/")
}

tasks.named("generate") {
    dependsOn(generateJava)
}

// ── COMPILE ──

val mavenBuild by tasks.registering(Exec::class) {
    group = "lifecycle"
    description = "Build Java module with Maven"
    dependsOn(tasks.named("generate"))
    workingDir(project.file("java"))
    commandLine("mvn", "package", "-DskipTests")
}

tasks.named("compile") {
    dependsOn(mavenBuild)
}

// ── TEST ──

val mavenTest by tasks.registering(Exec::class) {
    group = "lifecycle"
    description = "Run Maven tests"
    dependsOn(tasks.named("compile"))
    workingDir(project.file("java"))
    commandLine("mvn", "test")
}

tasks.named("unitTest") {
    dependsOn(mavenTest)
}

// ── BUILD IMAGE ──

val buildJavaImage by tasks.registering(Exec::class) {
    group = "lifecycle"
    description = "Build Docker image for Java HTTP module"
    dependsOn(tasks.named("compile"))
    workingDir(project.projectDir)
    val registry = project.property("dockerRegistry") as String
    val imageName = zb.dockerImageName.get()
    val ver = project.version.toString()
    commandLine("docker", "build",
        "-t", "${imageName}:local",
        "-t", "${registry}/${imageName}:${ver}",
        ".")
}

tasks.named("buildImage") {
    dependsOn(buildJavaImage)
}

// ── PUBLISH IMAGE ──

val publishJavaImage by tasks.registering(Exec::class) {
    group = "publish"
    description = "Push Java HTTP Docker image to registry"
    dependsOn(tasks.named("buildImage"))
    workingDir(project.projectDir)
    val registry = project.property("dockerRegistry") as String
    val imageName = zb.dockerImageName.get()
    val ver = project.version.toString()
    commandLine("docker", "push", "${registry}/${imageName}:${ver}")
}

tasks.named("publishImage") {
    dependsOn(publishJavaImage)
}
