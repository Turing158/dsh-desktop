//! Persist intent outside bundled resources and freeze it for each DSH process.
use std::{io::{self, Write}, path::Path};

pub fn boot_patch(file: &Path) -> io::Result<tempfile::NamedTempFile> {
    let catalog: Vec<serde_json::Value> = serde_json::from_str(include_str!("../../dsh-plugin/plugin-control/catalog.json"))?;
    let saved = match std::fs::read(file) {
        Ok(bytes) => {
            let value: serde_json::Value = serde_json::from_slice(&bytes)?;
            if value["version"] != 1 || !value["enabled"].as_object().is_some_and(|rows| rows.values().all(|v| v.is_boolean())) {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "内置插件配置格式错误"));
            }
            value["enabled"].clone()
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => serde_json::json!({}),
        Err(error) => return Err(error),
    };
    let mut patches: Vec<_> = catalog.iter().flat_map(|row| {
        let id = row["id"].as_str().expect("bundled plugin id");
        let modules = row["modules"].as_array().cloned().unwrap_or_else(|| vec![serde_json::json!(id)]);
        modules.into_iter().map(|module| serde_json::json!({ "id": module, "disabled": saved[id] == false })).collect::<Vec<_>>()
    }).collect();
    let core: Vec<String> = serde_json::from_str(include_str!("../../dsh-plugin/plugin-control/core.json"))?;
    patches.extend(core.iter().map(|id| serde_json::json!({ "id": id, "disabled": false })));
    if let Some(parent) = file.parent() { std::fs::create_dir_all(parent)?; }
    let mut patch = tempfile::Builder::new().prefix("desktop-plugins-").suffix(".json").tempfile()?;
    patch.write_all(serde_json::to_string(&patches)?.as_bytes())?;
    patch.flush()?;
    Ok(patch)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_appearance_and_core_switches_migrate_at_boot() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("desktop-plugins.json");
        for overlay in [Some(true), Some(false), None] {
            for appearance in [true, false] {
                let mut enabled = serde_json::json!({
                    "desktop-appearance": appearance, "desktop-title-bar": false,
                    "desktop-ui-state": false, "desktop-remote-control": false, "desktop-i18n": false,
                    "desktop-sidebar-terminal": false
                });
                if let Some(value) = overlay { enabled["desktop-ui"] = value.into(); }
                std::fs::write(&file, serde_json::to_vec(&serde_json::json!({"version":1,"enabled":enabled})).unwrap()).unwrap();
                let patch = boot_patch(&file).unwrap();
                let rows: Vec<serde_json::Value> = serde_json::from_slice(&std::fs::read(patch.path()).unwrap()).unwrap();
                assert_eq!(rows.len(), 9);
                for id in ["desktop-ui", "desktop-appearance"] {
                    assert_eq!(rows.iter().find(|row| row["id"] == id).unwrap()["disabled"], overlay == Some(false));
                }
                for id in ["desktop-title-bar", "desktop-ui-state", "desktop-remote-control", "desktop-i18n"] {
                    assert_eq!(rows.iter().find(|row| row["id"] == id).unwrap()["disabled"], false);
                }
                assert_eq!(rows.iter().find(|row| row["id"] == "desktop-sidebar-terminal").unwrap()["disabled"], true);
            }
        }
    }
    #[test]
    fn startup_applies_only_known_switches_and_does_not_modify_saved_intent() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("desktop-plugins.json");
        let initial = boot_patch(&file).unwrap();
        let rows: Vec<serde_json::Value> = serde_json::from_slice(&std::fs::read(initial.path()).unwrap()).unwrap();
        assert!(rows.iter().all(|row| row["disabled"] == false));
        let saved = r#"{"version":1,"enabled":{"desktop-notify":false,"desktop-settings":false}}"#;
        std::fs::write(&file, saved).unwrap();
        let patch = boot_patch(&file).unwrap();
        let rows: Vec<serde_json::Value> = serde_json::from_slice(&std::fs::read(patch.path()).unwrap()).unwrap();
        assert!(rows.iter().any(|row| row["id"] == "desktop-notify" && row["disabled"] == true));
        assert!(!rows.iter().any(|row| row["id"] == "desktop-settings"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), saved);
        std::fs::write(&file, r#"{"version":1,"enabled":{"desktop-notify":"false"}}"#).unwrap();
        assert!(boot_patch(&file).is_err());
    }
}
