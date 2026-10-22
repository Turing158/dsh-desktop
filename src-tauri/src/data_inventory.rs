//! Logical inventory, not a directory-copy allowlist. Providers must verify
//! effective locations and consistency before backup or rollback is enabled.
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRoots {
    pub schema: u32,
    pub profile_home: PathBuf,
    pub profile_directory: PathBuf,
    pub session_root: PathBuf,
    pub session_schema: Option<u32>,
    pub session_flush: bool,
    pub attachment_root: Option<PathBuf>,
    pub install_anchor: PathBuf,
    #[serde(default)]
    pub desktop_preferences: Option<PathBuf>,
    #[serde(default)]
    pub plugin_intent: Option<PathBuf>,
    #[serde(default)]
    pub profile_switches: Option<PathBuf>,
    #[serde(default)]
    pub upstream_settings: Option<PathBuf>,
    #[serde(default)]
    pub credential_classification: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observed_preferences_remain_limited_and_legacy_reports_still_load() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().to_path_buf();
        let mut roots = ProviderRoots {schema:1,profile_home:path.clone(),profile_directory:path.clone(),session_root:path.clone(),
            session_schema:Some(4),session_flush:true,attachment_root:Some(path.clone()),install_anchor:path.clone(),
            desktop_preferences:Some(path.clone()),plugin_intent:Some(path.clone()),profile_switches:Some(path.clone()),upstream_settings:Some(path),
            credential_classification:Some("schema-declared-only".into())};
        assert!(roots.valid());
        let mut inventory = DataInventory::unresolved(None);
        inventory.observe(&ObservedStorage { roots:roots.clone(),backend_instance:1,observed_at:1 });
        let preferences = inventory.components.iter().find(|c| c.id == "desktop-preferences").unwrap();
        assert_eq!(preferences.availability,"limited");
        assert_eq!(preferences.format_schema,Some(1));
        assert!(inventory.warnings.iter().any(|w| w == "storage-consistency-unverified"));
        let mut legacy = serde_json::to_value(&roots).unwrap();
        for key in ["desktopPreferences","pluginIntent","profileSwitches","upstreamSettings","credentialClassification"] { legacy.as_object_mut().unwrap().remove(key); }
        assert!(serde_json::from_value::<ProviderRoots>(legacy).unwrap().valid());
        roots.desktop_preferences = Some(PathBuf::from("relative"));
        assert!(!roots.valid());
    }
}
impl ProviderRoots {
    pub fn valid(&self) -> bool {
        self.schema == 1 && self.session_schema.map_or(true, |version| version <= 100)
            && [&self.profile_home, &self.profile_directory, &self.session_root, &self.install_anchor].into_iter()
                .chain(self.attachment_root.iter()).chain(self.desktop_preferences.iter()).chain(self.plugin_intent.iter())
                .chain(self.profile_switches.iter()).chain(self.upstream_settings.iter()).all(|path| path.is_absolute() && path.as_os_str().len() <= 2048)
            && self.credential_classification.as_deref().map_or(true, |value| matches!(value, "schema-declared-only" | "unverified"))
    }
}
#[derive(Clone, Debug)]
pub struct ObservedStorage { pub roots: ProviderRoots, pub backend_instance: u64, pub observed_at: u64 }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedRoots {
    pub schema: u32,
    pub data_root: PathBuf,
    pub profile: String,
    pub profile_home: PathBuf,
    pub profile_directory: Option<PathBuf>,
    pub resolver: String,
    pub runtime_version: String,
    pub consistency: String,
    pub migration_scope: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: &'static str,
    pub provider: &'static str,
    pub credential_policy: &'static str,
    pub availability: &'static str,
    pub reason_codes: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format_schema: Option<u32>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataInventory {
    pub schema: u32,
    pub roots: Option<ResolvedRoots>,
    pub app_data_root: Option<PathBuf>,
    pub components: Vec<Component>,
    pub warnings: Vec<String>,
}
impl DataInventory {
    pub fn unresolved(app_data_root: Option<PathBuf>) -> Self {
        let components = [
            ("sessions", "upstream-session-persistence", "mixed-content"),
            ("attachments", "upstream-attachment-store", "private-content"),
            ("upstream-settings", "upstream-config", "mixed-credentials"),
            ("desktop-preferences", "desktop-settings", "structured-filter-required"),
            ("plugin-intent", "desktop-plugin-control", "exclude-credentials"),
            ("profile-plugins", "profile-plugin-control", "mixed-credentials"),
            ("changes", "desktop-changes", "private-content"),
            ("remote-preferences", "desktop-remote-control", "disable-listener-on-migration"),
            ("drafts", "ui-state-providers", "private-content"),
            ("credentials", "upstream-credentials-local", "excluded-by-default"),
        ].into_iter().map(|(id, provider, credential_policy)| Component { id, provider, credential_policy, availability: "unknown", reason_codes: vec!["storage-adapter-unverified"], path: None, format_schema: None }).collect();
        Self { schema: 1, roots: None, app_data_root, components, warnings: vec!["storage-consistency-unverified".into(), "runtime-migration-scope-unverified".into()] }
    }
    pub fn probe(runtime: &crate::dsh::Runtime, app_data_root: Option<PathBuf>, helper: &Path) -> Result<Self, String> {
        let mut command = std::process::Command::new(&runtime.node_exe);
        command.arg(crate::dsh::node_script_path(helper)).arg(crate::dsh::node_script_path(&runtime.dsh_bin));
        let text = crate::dsh_update::output(&mut command, "inventory-probe", std::time::Duration::from_secs(8))?;
        let roots: ResolvedRoots = serde_json::from_str(&text).map_err(|_| "inventory-invalid-response")?;
        if roots.schema != 1 || roots.profile != "web" || !roots.data_root.is_absolute() || !roots.profile_home.is_absolute() || roots.profile_directory.as_ref().is_some_and(|path| !path.is_absolute()) {
            return Err("inventory-invalid-roots".into());
        }
        let mut inventory = Self::unresolved(app_data_root);
        inventory.roots = Some(roots);
        Ok(inventory)
    }
    pub fn observe(&mut self, observed: &ObservedStorage) {
        for component in &mut self.components {
            let path = match component.id {
                "sessions" => Some(observed.roots.session_root.clone()),
                "attachments" => observed.roots.attachment_root.clone(),
                "desktop-preferences" => observed.roots.desktop_preferences.clone(),
                "plugin-intent" => observed.roots.plugin_intent.clone(),
                "profile-plugins" => observed.roots.profile_switches.clone(),
                "upstream-settings" => observed.roots.upstream_settings.clone(),
                _ => None,
            };
            if path.is_some() {
                component.path = path;
                component.availability = "limited";
                component.reason_codes = vec!["provider-root-confirmed", "storage-consistency-unverified"];
                if component.id == "sessions" { component.format_schema = observed.roots.session_schema; }
                if matches!(component.id, "desktop-preferences" | "plugin-intent" | "profile-plugins") {
                    component.format_schema = Some(1);
                    component.reason_codes = vec!["structured-provider-confirmed", "storage-consistency-unverified"];
                }
                if component.id == "upstream-settings" && observed.roots.credential_classification.as_deref() == Some("schema-declared-only") {
                    component.reason_codes = vec!["schema-secret-classification-partial", "storage-consistency-unverified"];
                }
            }
        }
    }
}
