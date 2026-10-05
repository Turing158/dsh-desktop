fn main() {
    if std::env::var_os("CARGO_FEATURE_SINGLE").is_some() {
        assert!(
            std::env::var_os("CARGO_FEATURE_OFFLINE").is_none(),
            "single and offline are separate distribution modes; build them separately"
        );
        embed_plugins();
    }
    // Tauri embeds its manifest into the application binary only. The native
    // lifecycle example also needs Common Controls v6 (TaskDialogIndirect).
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-arg-examples=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-examples=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
    tauri_build::build()
}

/// Use the same resource map as portable/NSIS so new plugins cannot be omitted
/// from single-file builds. The Tauri CLI builds terminal assets before this runs.
fn embed_plugins() {
    use std::{fmt::Write, path::PathBuf};
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let config = root.join("tauri.conf.json");
    println!("cargo:rerun-if-changed={}", config.display());
    let config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(config).unwrap()).unwrap();
    let resources = config["bundle"]["resources"]
        .as_object()
        .expect("resource map");
    let mut source = String::from("const FILES: &[(&str, &[u8])] = &[\n");
    let mut has_patch = false;
    for (file, destination) in resources {
        let destination = destination.as_str().expect("resource destination");
        assert!(
            destination.starts_with("dsh-plugin/")
                && destination
                    .split('/')
                    .all(|part| !part.is_empty() && part != ".." && part != ".")
                && !destination.contains(['\\', ':']),
            "invalid plugin resource destination"
        );
        has_patch |= destination == "dsh-plugin/desktop-notify.patch.yml";
        let file = root
            .join(file)
            .canonicalize()
            .expect("plugin resource missing; run npm run build:terminal first");
        println!("cargo:rerun-if-changed={}", file.display());
        writeln!(
            source,
            "    ({destination:?}, include_bytes!({:?})),",
            file.to_str().unwrap()
        )
        .unwrap();
    }
    assert!(has_patch, "desktop plugin patch must be embedded");
    source.push_str("];\n");
    std::fs::write(
        PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("embedded_plugins.rs"),
        source,
    )
    .unwrap();
}
