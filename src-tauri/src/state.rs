//! Shared application state and the boot state machine.
//!
//! The UI is a small local page that asks this state what to render and calls
//! commands to act. All mutation goes through the mutex, so the boot sequence
//! (probe → install if needed → spawn → navigate) has exactly one owner.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::dsh::{DshProcess, DshSource};
use crate::notify::Dedupe;
use crate::npm::InstallHandle;

/// Where the app is in its startup sequence; drives which page the UI shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Phase {
    /// Looking for node and dsh.
    Probing,
    /// Node is missing or too old for DSH.
    NeedsNode {
        /// The version found, when one was found but rejected.
        found: Option<String>,
        required_major: u32,
    },
    /// The automatic install is running. This is a page the user sees on a first
    /// launch, so it reports progress rather than asking anything.
    Installing {
        /// The version being requested, when one is pinned; `None` means the
        /// `latest` dist-tag, which is what the app installs.
        version: Option<String>,
    },
    /// A dsh exists and the child is starting up.
    Starting { version: Option<String> },
    /// The GUI URL is known; the window is (or is about to be) showing it.
    Running {
        url: String,
        version: Option<String>,
    },
    /// Something went wrong; `hint` is what the user can do about it.
    ///
    /// `manual_install` marks the one failure whose remedy is a command the user
    /// runs themselves. It is a flag rather than part of `kind` because the
    /// screen is otherwise the generic error screen, and the UI needs to know
    /// only whether to render the command block.
    Failed {
        message: String,
        hint: String,
        details: Vec<String>,
        #[serde(default)]
        manual_install: bool,
    },
}

/// The application state, shared across commands and threads.
pub struct AppState {
    pub remote: crate::remote_control::Runtime,
    pub phase: Phase,
    /// Located runtime, once known.
    pub runtime: Option<crate::dsh::Runtime>,
    /// The running child, if any.
    pub process: Option<DshProcess>,
    /// A stop handle for the running install, if any.
    ///
    /// A handle rather than the `Installer` itself: the installer owns the child
    /// and stays on the boot thread, which is the only place that waits for it.
    pub installer: Option<InstallHandle>,
    /// The web app's appearance preference, as last reported by the UI plugin.
    /// Drives the native title bar's colors.
    pub appearance: crate::dsh::ThemePreference,
    /// Old DSH colors until an update has restored the new interface.
    pub update_presentation: Option<crate::boot_bar::UpdatePresentation>,
    /// Visibility compatibility flag. The confirmed lifecycle lives in `ui.phase`.
    /// In-memory only; a restart starts with the full interface.
    pub minimal: bool,
    /// Separate from backend Phase: zero windows must not stop the runtime.
    pub ui: crate::ui_snapshot::UiState,
    /// A deep link waiting to be activated once the page can receive it.
    /// Single-slot: a newer link replaces an older one. See `deep_link`.
    pub pending_deep_link: Option<crate::deep_link::PendingLink>,
    pub boot_in_progress: bool,
    /// Recent child output, for the error screen.
    pub log: Vec<String>,
    /// Notification de-duplication.
    pub dedupe: Dedupe,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            remote: crate::remote_control::Runtime::default(),
            phase: Phase::Probing,
            runtime: None,
            process: None,
            installer: None,
            appearance: crate::dsh::ThemePreference::default(),
            update_presentation: None,
            minimal: false,
            ui: crate::ui_snapshot::UiState::default(),
            pending_deep_link: None,
            boot_in_progress: false,
            log: Vec::new(),
            dedupe: Dedupe::default(),
        }
    }
}

impl AppState {
    /// Append a line to the bounded diagnostic log.
    pub fn push_log(&mut self, line: impl Into<String>) {
        const LIMIT: usize = 200;
        if self.log.len() >= LIMIT {
            self.log.remove(0);
        }
        self.log.push(crate::remote_control::redact(&line.into()));
    }

    /// The most recent `count` log lines.
    pub fn log_tail(&self, count: usize) -> Vec<String> {
        let start = self.log.len().saturating_sub(count);
        self.log[start..].to_vec()
    }
}

/// Shared handle used by commands and background threads.
pub type Shared = Arc<Mutex<AppState>>;

/// Wrap a fresh state for Tauri's managed-state storage.
pub fn shared() -> Shared {
    Arc::new(Mutex::new(AppState::default()))
}

/// What the UI needs to render the current page.
#[derive(Debug, Clone, Serialize)]
pub struct StatusReport {
    pub phase: PublicPhase,
    pub updating_dsh: bool,
    pub node_path: Option<PathBuf>,
    pub node_version: Option<String>,
    pub dsh_path: Option<PathBuf>,
    pub dsh_source: Option<DshSource>,
    /// The command the app would run to install dsh, for the failure screen.
    ///
    /// Served from the backend rather than hard-coded in the page so the
    /// instruction and the install cannot drift apart: both come from
    /// [`crate::npm::install_command`].
    pub install_command: String,
}

/// Assemble the report for the UI.
pub fn status(
    state: &AppState,
    node_path: Option<PathBuf>,
    node_version: Option<String>,
) -> StatusReport {
    StatusReport {
        phase: PublicPhase::from(&state.phase),
        updating_dsh: state.update_presentation.is_some(),
        node_path,
        node_version,
        dsh_path: state
            .runtime
            .as_ref()
            .map(|runtime| runtime.dsh_bin.clone()),
        dsh_source: state.runtime.as_ref().map(|runtime| runtime.source),
        install_command: crate::npm::install_command(),
    }
}

/// Ordinary status broadcasts never serialize the internal navigation URL.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PublicPhase {
    Probing,
    NeedsNode {
        found: Option<String>,
        required_major: u32,
    },
    Installing {
        version: Option<String>,
    },
    Starting {
        version: Option<String>,
    },
    Running {
        version: Option<String>,
    },
    Failed {
        message: String,
        hint: String,
        details: Vec<String>,
        manual_install: bool,
    },
}
impl From<&Phase> for PublicPhase {
    fn from(phase: &Phase) -> Self {
        match phase {
            Phase::Probing => Self::Probing,
            Phase::NeedsNode {
                found,
                required_major,
            } => Self::NeedsNode {
                found: found.clone(),
                required_major: *required_major,
            },
            Phase::Installing { version } => Self::Installing {
                version: version.clone(),
            },
            Phase::Starting { version } => Self::Starting {
                version: version.clone(),
            },
            Phase::Running { version, .. } => Self::Running {
                version: version.clone(),
            },
            Phase::Failed {
                message,
                hint,
                details,
                manual_install,
            } => Self::Failed {
                message: crate::remote_control::redact(message),
                hint: crate::remote_control::redact(hint),
                details: details
                    .iter()
                    .map(|s| crate::remote_control::redact(s))
                    .collect(),
                manual_install: *manual_install,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_is_bounded() {
        let mut state = AppState::default();
        for index in 0..500 {
            state.push_log(format!("line {index}"));
        }
        assert_eq!(state.log.len(), 200);
        // The newest line survives and the oldest is gone.
        assert_eq!(state.log.last().map(String::as_str), Some("line 499"));
        assert_eq!(state.log.first().map(String::as_str), Some("line 300"));
    }

    #[test]
    fn log_tail_returns_the_end() {
        let mut state = AppState::default();
        for index in 0..10 {
            state.push_log(format!("line {index}"));
        }
        assert_eq!(state.log_tail(2), vec!["line 8", "line 9"]);
    }

    #[test]
    fn log_tail_handles_a_short_log() {
        let mut state = AppState::default();
        state.push_log("only");
        assert_eq!(state.log_tail(50), vec!["only"]);
    }

    #[test]
    fn phases_serialize_with_a_kind_tag_for_the_ui() {
        let json = serde_json::to_string(&Phase::Installing {
            version: Some("0.1.5-rc.3".into()),
        })
        .expect("serialize");
        assert!(json.contains("\"kind\":\"installing\""), "got {json}");
        assert!(json.contains("0.1.5-rc.3"), "got {json}");
    }

    #[test]
    fn a_latest_install_serializes_with_a_null_version() {
        // `null` is the UI's cue to say "latest" instead of naming a version.
        let json = serde_json::to_string(&Phase::Installing { version: None }).expect("serialize");
        assert!(json.contains("\"version\":null"), "got {json}");
    }

    #[test]
    fn the_generic_failure_is_not_a_manual_install() {
        // The field exists so the UI can render one extra block; a generic failure
        // must not tell the user to run an install command.
        let json = serde_json::to_string(&Phase::Failed {
            message: "boom".into(),
            hint: "retry".into(),
            details: vec![],
            manual_install: false,
        })
        .expect("serialize");
        assert!(json.contains("\"manual_install\":false"), "got {json}");
    }
}
