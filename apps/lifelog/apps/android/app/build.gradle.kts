plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.ericedouard.lifelog"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.ericedouard.lifelog"
        // Android 13: the Bluetooth, notification and foreground-service rules this app follows, without older branches.
        minSdk = 33
        targetSdk = 36
        versionCode = 1
        versionName = "0.1"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures.compose = true
}

dependencies {
    implementation(project(":api"))
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.foundation)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.compose)
    implementation(libs.code.scanner)
    implementation(libs.coroutines.android)
    implementation(libs.coroutines.play)
    testImplementation(libs.junit)
}
