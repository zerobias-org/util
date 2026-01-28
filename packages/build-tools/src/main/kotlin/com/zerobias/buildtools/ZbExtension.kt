package com.zerobias.buildtools

import org.gradle.api.provider.Property

interface ZbExtension {
    val vendor: Property<String>
    val product: Property<String>
    val hasConnectionProfile: Property<Boolean>
    val hasOpenApiSdk: Property<Boolean>
    val dockerImageName: Property<String>
}
