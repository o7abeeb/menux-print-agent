plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Version comes from the release tag (CI passes -PversionName=0.3.0 -PversionCode=300).
val appVersionName = (project.findProperty("versionName") as String?) ?: "0.0.0-dev"
val appVersionCode = ((project.findProperty("versionCode") as String?) ?: "1").toInt()
// Release signing key: a PKCS12 file whose path/passwords come from CI secrets.
// Without it (a local build) the debug key is used.
val keystoreFile = System.getenv("ANDROID_KEYSTORE_FILE")

android {
    namespace = "app.menux.print"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.menux.print"
        minSdk = 24
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        create("release") {
            if (keystoreFile != null) {
                storeFile = file(keystoreFile)
                storeType = "pkcs12"
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (keystoreFile != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}
