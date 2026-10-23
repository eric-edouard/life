// The server's client, generated from its whole contract (`apps/voice/openapi.json`) at build time: nothing generated
// is committed, so a changed contract only needs a rebuild.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.openapi.generator)
}

val generated = layout.buildDirectory.dir("generated/openapi")

openApiGenerate {
    generatorName.set("kotlin")
    library.set("jvm-okhttp4")
    inputSpec.set(rootDir.resolve("../voice/openapi.json").path)
    outputDir.set(generated.get().asFile.path)
    packageName.set("com.ericedouard.lifelog.api")
    configOptions.set(mapOf("serializationLibrary" to "kotlinx_serialization", "omitGradleWrapper" to "true"))
    // Page indices reach 2^40 (the flash life band); tuples (`prefixItems`) are read as JSON.
    typeMappings.set(mapOf("integer" to "kotlin.Long", "number" to "kotlin.Double", "AnyType" to "JsonElement"))
    importMappings.set(mapOf("JsonElement" to "kotlinx.serialization.json.JsonElement"))
    generateApiTests.set(false)
    generateModelTests.set(false)
    generateApiDocumentation.set(false)
    generateModelDocumentation.set(false)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions.jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    sourceSets.main { kotlin.srcDir(generated.map { it.dir("src/main/kotlin") }) }
}

tasks.compileKotlin { dependsOn(tasks.openApiGenerate) }

dependencies {
    api(libs.okhttp)
    api(libs.serialization.json)
}
