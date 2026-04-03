plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.grantex.gemma.example"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.grantex.gemma.example"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // JWT verification — parse and verify RS256 JWTs against a JWKS snapshot
    implementation("com.nimbusds:nimbus-jose-jwt:9.37.3")

    // Encrypted storage — EncryptedSharedPreferences backed by Android Keystore
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Ed25519 signing for audit log entries
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")

    // HTTP client for online phases (bundle fetch + audit sync)
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Android core
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")

    // Coroutines for async operations
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
}
