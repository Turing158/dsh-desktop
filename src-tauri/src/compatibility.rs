//! Host-owned capability report. Unknown is intentional until the same
//! feature selector and provider used by the operation supplies evidence.
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Availability { Checking, Available, Limited, Unavailable, Unknown }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Implementation { Upstream, Desktop, Hybrid }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observation {
    pub feature_id: String,
    pub availability: Availability,
    pub implementation: Option<Implementation>,
    pub plugin_state: String,
    pub reason_codes: Vec<String>,
    pub evidence: Vec<String>,
}
impl Observation {
    pub fn valid(&self) -> bool {
        matches!(self.plugin_state.as_str(), "enabled" | "user-disabled" | "pending-restart" | "load-failed" | "unknown")
            && self.reason_codes.len() <= 8 && self.evidence.len() <= 8
            && self.reason_codes.iter().chain(self.evidence.iter()).all(|id| !id.is_empty() && id.len() <= 100 && id.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c)))
    }
}
#[derive(Clone, Debug)]
pub struct Observed { pub report: Observation, pub backend_instance: u64, pub observed_at: u64, pub document: Option<crate::remote_control::Identity> }

pub fn record(state: &mut crate::state::AppState, report: Observation, instance: u64, source: &str) -> Result<(), String> {
    let permitted = match source {
        "host" => matches!(report.feature_id.as_str(), "plugin-management" | "appearance-settings" | "terminal-dock" | "session-changes-git" | "window-notifications"),
        "client" => matches!(report.feature_id.as_str(), "terminal-dock" | "file-editor" | "ui-recovery" | "session-changes-git" | "session-links-export"),
        _ => false,
    };
    if !permitted || !report.valid() || state.ui.backend_instance != instance { return Err("capability-invalid-report".into()); }
    let document = (source == "client").then(|| crate::remote_control::identity(state));
    let reports=if source=="host" && matches!(report.feature_id.as_str(),"terminal-dock"|"session-changes-git"|"window-notifications") {&mut state.plugin_capabilities} else {&mut state.capabilities};
    reports.insert(report.feature_id.clone(), Observed { report, backend_instance: instance, observed_at: crate::maintenance::now_ms(), document });
    Ok(())
}

#[tauri::command]
pub fn desktop_capabilities_report(window: tauri::WebviewWindow, identity: crate::remote_control::Identity, report: Observation) -> Result<(), String> {
    crate::remote_control::caller(&window, identity).map_err(|error| error.message)?;
    let shared = window.state::<crate::state::Shared>();
    let mut state = shared.lock().map_err(|_| "capability-state")?;
    if crate::remote_control::identity(&state) != identity { return Err("capability-stale-document".into()); }
    record(&mut state, report, identity.backend_instance, "client")
}

pub fn initialization_script() -> &'static str { include_str!("../../dsh-plugin/desktop-maintenance/capability-bridge.js") }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Verification {
    pub version: String,
    pub architecture: String,
    pub platform: String,
    pub date: String,
    pub evidence: String,
    pub checks: Vec<String>,
    pub native_host_mocked: bool,
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct ValidationRecord {
    #[serde(flatten)] verification: Verification,
    feature_ids: Vec<String>,
}
#[derive(Deserialize)]
struct Matrix { schema: u32, records: Vec<serde_json::Value> }
fn verifications(version: Option<&str>, architecture: &str, platform: &str, feature: &str) -> Vec<Verification> {
    let Ok(matrix) = serde_json::from_str::<Matrix>(include_str!("../../dsh-plugin/compatibility/compatibility-matrix.json")) else { return vec![] };
    if matrix.schema != 1 { return vec![]; }
    matrix.records.into_iter().filter_map(|value|serde_json::from_value::<ValidationRecord>(value).ok())
        .filter(|record|Some(record.verification.version.as_str())==version
            && record.verification.architecture==architecture && record.verification.platform==platform
            && record.feature_ids.iter().any(|id|id==feature))
        .map(|record|record.verification).collect()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub feature_id: &'static str,
    pub availability: &'static str,
    pub implementation: Option<&'static str>,
    pub reason_codes: Vec<String>,
    pub plugin_state: String,
    pub scope: &'static str,
    pub evidence: Vec<String>,
    pub observed_at: u64,
    pub backend_instance: u64,
    pub verification: Vec<Verification>,
}
pub fn host(state: &crate::state::AppState) -> Vec<Capability> {
    let now = crate::maintenance::now_ms();
    let instance = state.ui.backend_instance;
    let mut rows: Vec<_> = ["window-notifications", "terminal-dock", "session-changes-git", "file-editor", "appearance-settings", "plugin-management", "ui-recovery", "lan-mobile", "session-links-export", "backup-restore", "runtime-rollback"].into_iter().map(|feature_id| Capability {
        feature_id, availability: "unknown", implementation: None,
        reason_codes: vec!["feature-provider-unreported".into()], plugin_state: "unknown".into(),
        scope: "global", evidence: vec![], observed_at: now, backend_instance: instance, verification: vec![],
    }).collect();
    rows.push(Capability { feature_id: "diagnostics", availability: "available", implementation: Some("desktop"), reason_codes: vec![], plugin_state: "enabled".into(), scope: "global", evidence: vec!["host-diagnostics-api".into()], observed_at: now, backend_instance: instance, verification:vec![] });
    for row in &mut rows {
        row.verification=verifications(state.runtime.as_ref().and_then(|runtime|runtime.version.as_deref()), std::env::consts::ARCH, std::env::consts::OS,row.feature_id);
        if let Some(observed) = state.capabilities.get(row.feature_id).filter(|observed| observed.backend_instance == instance
            && observed.document.map_or(true, |document| document == crate::remote_control::identity(state)) && now.saturating_sub(observed.observed_at) <= 300_000) {
            row.availability = match observed.report.availability { Availability::Checking => "checking", Availability::Available => "available", Availability::Limited => "limited", Availability::Unavailable => "unavailable", Availability::Unknown => "unknown" };
            row.implementation = observed.report.implementation.as_ref().map(|implementation| match implementation { Implementation::Upstream => "upstream", Implementation::Desktop => "desktop", Implementation::Hybrid => "hybrid" });
            row.observed_at = observed.observed_at;
            row.plugin_state = observed.report.plugin_state.clone();
            row.reason_codes = observed.report.reason_codes.clone();
            row.evidence = observed.report.evidence.clone();
        } else if let Some(observed) = state.capabilities.get(row.feature_id).filter(|observed| observed.backend_instance == instance) {
            row.observed_at = observed.observed_at;
            row.reason_codes = vec![if observed.document.is_some_and(|document| document != crate::remote_control::identity(state)) {"capability-document-changed"} else {"capability-report-expired"}.into()];
        }
        if row.feature_id == "ui-recovery" { row.scope = "current-interface"; }
        if row.feature_id == "session-changes-git" { row.scope = "current-workspace"; }
        if row.feature_id == "session-links-export" { row.scope = "current-interface"; }
        if row.feature_id == "window-notifications" {
            let report=crate::notify::capability(&state.notification_transport);
            row.availability=match report.availability {Availability::Limited=>"limited",Availability::Unavailable=>"unavailable",_=>"unknown"};
            row.implementation=Some("desktop");row.plugin_state=report.plugin_state;row.reason_codes=report.reason_codes;row.evidence=report.evidence;
        }
        if row.feature_id == "lan-mobile" {
            let report=crate::remote_control::capability(state);
            row.availability=match report.availability {Availability::Checking=>"checking",Availability::Available=>"available",Availability::Limited=>"limited",Availability::Unavailable=>"unavailable",Availability::Unknown=>"unknown"};
            row.implementation=Some("hybrid");row.plugin_state=report.plugin_state;row.reason_codes=report.reason_codes;row.evidence=report.evidence;
        }
        // Optional plugin intent is independent of the feature's service
        // contract. Turning an enhancement off does not disable native DSH.
        if let Some(observed)=state.plugin_capabilities.get(row.feature_id).filter(|observed|observed.backend_instance==instance && now.saturating_sub(observed.observed_at)<=300_000) {
            row.plugin_state=observed.report.plugin_state.clone();
            if !row.evidence.iter().any(|id|id=="plugin-control-status") {row.evidence.push("plugin-control-status".into());}
            for code in &observed.report.reason_codes {if !row.reason_codes.contains(code) {row.reason_codes.push(code.clone());}}
        } else if state.plugin_capabilities.get(row.feature_id).is_some_and(|observed|observed.backend_instance==instance) {
            row.plugin_state="unknown".into();
            if !row.reason_codes.iter().any(|code|code=="capability-report-expired") {row.reason_codes.push("capability-report-expired".into());}
        }
        if row.feature_id == "backup-restore" {
            let partial = state.storage.as_ref().filter(|storage| storage.backend_instance == state.ui.backend_instance)
                .is_some_and(|storage| storage.roots.desktop_preferences.is_some() || storage.roots.plugin_intent.is_some());
            row.availability = if partial {"limited"} else {"unavailable"};
            row.reason_codes = if partial {vec!["partial-config-backup-available".into(),"storage-consistency-unverified".into()]} else {vec!["storage-adapter-unverified".into(), "storage-consistency-unverified".into()]};
            row.implementation = Some("desktop");
        } else if row.feature_id == "runtime-rollback" {
            row.availability = "unavailable";
            row.reason_codes = if state.runtime.as_ref().is_some_and(|r| r.source == crate::dsh::DshSource::Configured) { vec!["runtime-explicitly-pinned".into()] } else { vec!["runtime-snapshot-unverified".into(), "runtime-migration-scope-unverified".into()] };
            row.implementation = Some("desktop");
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_notifications_survive_backend_and_document_changes_and_reject_client_forgery() {
        let mut state=crate::state::AppState::default();
        state.notification_transport=crate::notify::TransportState {initialized:true,registration_ready:true,service_ready:true,delivery_failed:false};
        let row=host(&state).into_iter().find(|row|row.feature_id=="window-notifications").unwrap();
        assert_eq!(row.availability,"limited");assert_eq!(row.reason_codes,vec!["notification-display-preflight-required"]);
        let forged=Observation {feature_id:"window-notifications".into(),availability:Availability::Available,implementation:Some(Implementation::Desktop),plugin_state:"enabled".into(),reason_codes:vec![],evidence:vec![]};
        assert!(record(&mut state,forged,0,"client").is_err());
        state.ui.backend_instance+=1;state.ui.document_generation+=1;
        assert_eq!(host(&state).into_iter().find(|row|row.feature_id=="window-notifications").unwrap().availability,"limited");
        state.notification_transport.delivery_failed=true;
        assert_eq!(host(&state).into_iter().find(|row|row.feature_id=="window-notifications").unwrap().reason_codes,vec!["notification-delivery-failed"]);
        state.notification_transport.service_ready=false;
        assert_eq!(host(&state).into_iter().find(|row|row.feature_id=="window-notifications").unwrap().availability,"unavailable");
        state.notification_transport.service_ready=true;state.notification_transport.registration_ready=false;
        assert_eq!(host(&state).into_iter().find(|row|row.feature_id=="window-notifications").unwrap().reason_codes,vec!["notification-registration-unavailable"]);
    }
    #[test]
    fn session_reports_are_scoped_to_current_workspace_or_interface_and_invalidated_with_the_page() {
        let mut state=crate::state::AppState::default();
        for (id,scope) in [("session-changes-git","current-workspace"),("session-links-export","current-interface")] {
            record(&mut state,Observation {feature_id:id.into(),availability:Availability::Limited,implementation:Some(Implementation::Hybrid),plugin_state:"enabled".into(),reason_codes:vec![],evidence:vec![]},0,"client").unwrap();
            let row=host(&state).into_iter().find(|row|row.feature_id==id).unwrap();
            assert_eq!(row.availability,"limited");assert_eq!(row.scope,scope);
        }
        state.ui.document_generation+=1;
        assert!(host(&state).into_iter().filter(|row|matches!(row.feature_id,"session-changes-git"|"session-links-export")).all(|row|row.availability=="unknown"));
    }
    #[test]
    fn lan_report_observes_disabled_intent_and_transient_failures_without_mutating_settings() {
        let mut state=crate::state::AppState::default();
        state.phase=crate::state::Phase::Running {url:"http://127.0.0.1:3080/?token=must-not-export".into(),version:None};
        let before=serde_json::to_value(&state.remote.saved).unwrap();
        let row=host(&state).into_iter().find(|row|row.feature_id=="lan-mobile").unwrap();
        assert_eq!(row.availability,"available");assert_eq!(row.plugin_state,"user-disabled");
        assert_eq!(serde_json::to_value(&state.remote.saved).unwrap(),before);
        assert!(!serde_json::to_string(&row).unwrap().contains("must-not-export"));
        state.remote.applying=true;
        assert_eq!(host(&state).into_iter().find(|row|row.feature_id=="lan-mobile").unwrap().availability,"checking");
        state.remote.applying=false;state.remote.saved.enabled=true;
        state.remote.error=Some(crate::remote_control::Error::from("private network failure".to_string()));
        let row=host(&state).into_iter().find(|row|row.feature_id=="lan-mobile").unwrap();
        assert_eq!(row.availability,"limited");assert_eq!(row.plugin_state,"enabled");
        assert!(!serde_json::to_string(&row).unwrap().contains("private network failure"));
        state.phase=crate::state::Phase::Probing;
        assert_eq!(host(&state).into_iter().find(|row|row.feature_id=="lan-mobile").unwrap().availability,"unavailable");
    }
    #[test]
    fn optional_plugin_intent_does_not_certify_or_disable_the_native_terminal_contract() {
        let mut state=crate::state::AppState::default();state.ui.backend_instance=1;
        let report=Observation {feature_id:"terminal-dock".into(),availability:Availability::Unknown,implementation:Some(Implementation::Desktop),plugin_state:"user-disabled".into(),reason_codes:vec![],evidence:vec!["plugin-control-status".into()]};
        record(&mut state,report.clone(),1,"host").unwrap();
        let row=host(&state).into_iter().find(|row|row.feature_id=="terminal-dock").unwrap();
        assert_eq!(row.availability,"unknown");assert_eq!(row.plugin_state,"user-disabled");
        record(&mut state,Observation {availability:Availability::Limited,plugin_state:"enabled".into(),..report},1,"client").unwrap();
        let row=host(&state).into_iter().find(|row|row.feature_id=="terminal-dock").unwrap();
        assert_eq!(row.availability,"limited");assert_eq!(row.plugin_state,"user-disabled");
        state.plugin_capabilities.get_mut("terminal-dock").unwrap().observed_at=crate::maintenance::now_ms().saturating_sub(300_001);
        let row=host(&state).into_iter().find(|row|row.feature_id=="terminal-dock").unwrap();
        assert_eq!(row.availability,"limited");assert_eq!(row.plugin_state,"unknown");
        assert!(row.reason_codes.iter().any(|code|code=="capability-report-expired"));
        state.ui.backend_instance=2;
        assert_eq!(host(&state).into_iter().find(|row|row.feature_id=="terminal-dock").unwrap().plugin_state,"unknown");
    }
    #[test]
    fn validation_records_match_exact_version_architecture_and_feature_without_enabling_operations() {
        let verified=verifications(Some("0.2.1-rc.2"),"x86_64","windows","ui-recovery");
        assert!(verified.iter().any(|record|!record.native_host_mocked && record.checks.iter().any(|check|check=="cold-draft-attachment-recovery")));
        for (version,arch,platform,feature) in [(Some("0.2.1-rc.3"),"x86_64","windows","ui-recovery"),
            (Some("0.2.1-rc.2"),"x86","windows","ui-recovery"),(Some("0.2.1-rc.2"),"x86_64","linux","ui-recovery"),
            (Some("0.2.1-rc.2"),"x86_64","windows","runtime-rollback"),(None,"x86_64","windows","ui-recovery")] {
            assert!(verifications(version,arch,platform,feature).is_empty());
        }
        let mut state=crate::state::AppState::default();
        state.runtime=Some(crate::dsh::Runtime {node_exe:"node.exe".into(),dsh_bin:"bin.js".into(),source:crate::dsh::DshSource::Configured,version:Some("0.2.1-rc.2".into()),managed:None});
        let rows=host(&state);
        assert_eq!(rows.iter().find(|row|row.feature_id=="ui-recovery").unwrap().availability,"unknown");
        assert_eq!(rows.iter().find(|row|row.feature_id=="runtime-rollback").unwrap().availability,"unavailable");
    }
    #[test]
    fn a_running_backend_is_not_proof_of_backup_or_feature_compatibility() {
        let mut state = crate::state::AppState::default();
        state.phase = crate::state::Phase::Running { url: "http://localhost/?token=private".into(), version: Some("0.2.1-rc.2".into()) };
        state.ui.backend_instance = 9;
        let rows = host(&state);
        assert_eq!(rows.iter().find(|r| r.feature_id == "backup-restore").unwrap().availability, "unavailable");
        assert_eq!(rows.iter().find(|r| r.feature_id == "terminal-dock").unwrap().availability, "unknown");
        assert!(rows.iter().all(|r| r.backend_instance == 9));
    }

    #[test]
    fn client_evidence_cannot_override_host_environment_or_survive_backend_changes() {
        let mut state = crate::state::AppState::default();
        state.ui.backend_instance = 2;
        let mut report = Observation { feature_id: "runtime-rollback".into(), availability: Availability::Available, implementation: Some(Implementation::Desktop), plugin_state: "enabled".into(), reason_codes: vec![], evidence: vec!["terminal-selector".into()] };
        assert!(record(&mut state, report.clone(), 2, "client").is_err());
        report.feature_id = "terminal-dock".into();
        assert!(record(&mut state, report.clone(), 1, "client").is_err());
        record(&mut state, report, 2, "client").unwrap();
        assert_eq!(host(&state).iter().find(|row| row.feature_id == "terminal-dock").unwrap().availability, "available");
        state.ui.backend_instance = 3;
        assert_eq!(host(&state).iter().find(|row| row.feature_id == "terminal-dock").unwrap().availability, "unknown");
    }

    #[test]
    fn page_replacement_invalidates_client_evidence_but_preserves_live_host_reports() {
        let mut state = crate::state::AppState::default();
        state.ui.backend_instance = 2;
        let mut report = Observation { feature_id:"file-editor".into(), availability:Availability::Limited,
            implementation:Some(Implementation::Hybrid),plugin_state:"enabled".into(),reason_codes:vec![],evidence:vec!["file-editor-service-selector".into()] };
        record(&mut state,report.clone(),2,"client").unwrap();
        report.feature_id="plugin-management".into();
        record(&mut state,report,2,"host").unwrap();
        state.ui.document_generation+=1;
        let rows=host(&state);
        let file=rows.iter().find(|row|row.feature_id=="file-editor").unwrap();
        assert_eq!(file.availability,"unknown");
        assert_eq!(file.reason_codes,vec!["capability-document-changed"]);
        assert_eq!(rows.iter().find(|row|row.feature_id=="plugin-management").unwrap().availability,"limited");
        let refreshed=state.capabilities["file-editor"].report.clone();
        record(&mut state,refreshed,2,"client").unwrap();
        assert_eq!(host(&state).iter().find(|row|row.feature_id=="file-editor").unwrap().availability,"limited");
        state.capabilities.get_mut("file-editor").unwrap().observed_at=crate::maintenance::now_ms().saturating_sub(300_001);
        assert_eq!(host(&state).iter().find(|row|row.feature_id=="file-editor").unwrap().reason_codes,vec!["capability-report-expired"]);
        assert_eq!(host(&state).iter().find(|row|row.feature_id=="ui-recovery").unwrap().scope,"current-interface");
    }
}
