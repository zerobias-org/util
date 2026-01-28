import com.zerobias.buildtools.ZbExtension

plugins {
    id("zb.typescript")
}

val zb = extensions.getByType<ZbExtension>()

zb.hasConnectionProfile.convention(true)

val validateConnector by tasks.registering {
    group = "lifecycle"
    description = "Validate connector-specific requirements"
    doLast {
        require(project.file("connectionProfile.yml").exists()) {
            "Connector modules must have connectionProfile.yml"
        }
    }
}

tasks.named("validate") {
    dependsOn(validateConnector)
}
