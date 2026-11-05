import com.android.build.api.dsl.ApplicationExtension

// Tauri rewrites identifiers in build.gradle.kts. Keep the debug suffix in a
// separate script so test builds retain their own database and credentials.
extensions.configure<ApplicationExtension>("android") {
    buildTypes.getByName("debug").applicationIdSuffix = ".lan"
}
