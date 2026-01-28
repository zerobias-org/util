import com.zerobias.buildtools.HubModuleExtension

plugins {
    id("hub.module-typescript")
}

val hubModule = extensions.getByType<HubModuleExtension>()

hubModule.hasConnectionProfile.convention(true)

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
