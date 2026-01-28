import com.zerobias.buildtools.HubModuleExtension

plugins {
    id("hub.module-typescript")
}

val hubModule = extensions.getByType<HubModuleExtension>()

hubModule.hasConnectionProfile.convention(false)

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
