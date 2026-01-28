import com.zerobias.buildtools.ZbExtension

plugins {
    id("zb.typescript")
}

val zb = extensions.getByType<ZbExtension>()

zb.hasConnectionProfile.convention(false)

val validateAgent by tasks.registering {
    group = "lifecycle"
    description = "Validate agent module requirements"
    doLast {
        require(!project.file("connectionProfile.yml").exists()) {
            "Agent modules should not have connectionProfile.yml"
        }
    }
}

tasks.named("validate") {
    dependsOn(validateAgent)
}
