import com.zerobias.buildtools.module.ZbExtension

plugins {
    id("zb.typescript")
}

val zb = extensions.getByType<ZbExtension>()

// hasConnectionProfile and includeConnectionProfileInDist are auto-detected from
// connectionProfile.yml on disk by zb.base. Spec shape must not depend on the
// language plugin in use, so we don't override them here.

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
