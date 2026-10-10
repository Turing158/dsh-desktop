//! Delivering notifications to Windows.
//!
//! Windows uses a registered shortcut and direct WinRT calls, so portable and
//! single-file builds have an identity and actual submission errors reach us.
//! The event sources remain independent of the native transport.

#[cfg(windows)]
mod windows;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
#[cfg(not(windows))]
use tauri_plugin_notification::NotificationExt;

#[cfg(windows)]
struct NativeNotifications(Result<windows::NotificationService, String>);

pub fn initialize(app: &AppHandle) {
    #[cfg(windows)]
    {
        match windows::register(&app.config().identifier) {
            Ok(registration) => crate::debug_log(&format!(
                "[notify/registration] {} {}",
                if registration.changed {
                    "updated"
                } else {
                    "unchanged"
                },
                registration.shortcut.display(),
            )),
            Err(error) => {
                crate::debug_log(&format!("[notify/registration-failed] {error}"));
                if let Ok(mut state) = app.state::<crate::state::Shared>().lock() {
                    state.push_log(format!("通知注册失败：{error}"));
                }
            }
        }
        let state = app.state::<crate::state::Shared>().inner().clone();
        app.manage(NativeNotifications(windows::NotificationService::start(
            app.config().identifier.clone(),
            move |event| match event {
                windows::DeliveryEvent::Failed(error) => {
                    crate::debug_log(&format!("[notify/failed] {error}"));
                    if let Ok(mut state) = state.lock() {
                        state.push_log(format!("通知发送失败：{error}"));
                    }
                }
                windows::DeliveryEvent::Dismissed => crate::debug_log("[notify/dismissed]"),
                windows::DeliveryEvent::Activated => crate::debug_log("[notify/activated]"),
            },
        )));
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// Something that can raise an OS notification.
pub trait Notifier: Send + Sync {
    /// Submit one notification. Success does not guarantee a visible banner:
    /// Windows notification settings and Do Not Disturb still apply.
    fn notify(&self, title: &str, body: &str) -> Result<(), String>;
}

/// The production notifier, using WinRT on Windows.
pub struct ToastNotifier {
    app: AppHandle,
}

impl ToastNotifier {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl Notifier for ToastNotifier {
    fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        // Windows toasts render a single short paragraph; an empty body would
        // leave a title-only toast, which is fine, but a very long one is
        // truncated by the shell anyway, so trim it deliberately here.
        let english = match title {
            "DSH 需要你的选择" => "DSH needs your choice",
            "DSH 计划待确认" => "DSH plan awaiting approval",
            "DSH 任务完成" => "DSH task completed",
            "DSH 任务出错" => "DSH task failed",
            "DSH 额度不足，任务已中断" => "DSH quota exhausted; task interrupted",
            "DSH 任务已中止" => "DSH task aborted",
            _ => title,
        };
        let title = crate::locale::text(&self.app, title, english);
        let body = truncate(body, MAX_BODY_CHARS);
        #[cfg(windows)]
        {
            let notifications = self.app.state::<NativeNotifications>();
            notifications
                .0
                .as_ref()
                .map_err(Clone::clone)?
                .submit(&title, &body)
        }
        #[cfg(not(windows))]
        {
            self.app
                .notification()
                .builder()
                .title(title)
                .body(body)
                .show()
                .map_err(|error| error.to_string())
        }
    }
}

/// A notifier that records calls instead of displaying them, for tests.
#[cfg(test)]
#[derive(Default)]
pub struct RecordingNotifier {
    pub calls: std::sync::Mutex<Vec<(String, String)>>,
}

#[cfg(test)]
impl Notifier for RecordingNotifier {
    fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        self.calls
            .lock()
            .map_err(|error| error.to_string())?
            .push((title.to_string(), body.to_string()));
        Ok(())
    }
}

/// Body budget for a toast.
const MAX_BODY_CHARS: usize = 200;

/// How long an identical notification is suppressed after being shown.
const DEDUPE_WINDOW: Duration = Duration::from_secs(3);

/// Truncate on a character boundary, appending an ellipsis when shortened.
pub fn truncate(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Suppresses duplicate notifications raised close together.
///
/// A single logical event can be reported twice — a question re-dispatched after
/// a UI reconnect, for instance — and two identical toasts in quick succession
/// read as a bug. Keyed by session, kind and outcome, so an error immediately
/// after completion still shows.
#[derive(Default)]
pub struct Dedupe {
    seen: HashMap<String, Instant>,
}

impl Dedupe {
    /// Record a notification, returning `false` when it duplicates a recent one.
    pub fn should_show(&mut self, key: &str) -> bool {
        let now = Instant::now();
        // Bound the table: entries older than the window can never suppress.
        self.seen
            .retain(|_, at| now.duration_since(*at) < DEDUPE_WINDOW);
        if self.seen.contains_key(key) {
            return false;
        }
        self.seen.insert(key.to_string(), now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_leaves_short_text_alone() {
        assert_eq!(truncate("short", 200), "short");
    }

    #[test]
    fn truncate_marks_the_cut() {
        let long = "x".repeat(300);
        let out = truncate(&long, 10);
        assert_eq!(out.chars().count(), 10);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn truncate_counts_characters_not_bytes() {
        // Multi-byte text must not be split mid-character.
        let text = "计划的详细说明".repeat(50);
        let out = truncate(&text, 20);
        assert_eq!(out.chars().count(), 20);
    }

    #[test]
    fn truncate_trims_surrounding_whitespace() {
        assert_eq!(truncate("  padded  ", 200), "padded");
    }

    #[test]
    fn dedupe_suppresses_an_immediate_repeat() {
        let mut dedupe = Dedupe::default();
        assert!(dedupe.should_show("s-1:question"));
        assert!(!dedupe.should_show("s-1:question"));
    }

    #[test]
    fn dedupe_allows_a_different_event() {
        let mut dedupe = Dedupe::default();
        assert!(dedupe.should_show("s-1:question"));
        assert!(dedupe.should_show("s-1:task-end"));
        assert!(dedupe.should_show("s-2:question"));
    }

    #[test]
    fn completion_does_not_suppress_a_following_error_in_the_same_session() {
        let completed: crate::dsh::NotifyPayload = serde_json::from_str(
            r#"{"kind":"task-end","title":"DSH 任务完成","reason":"completed","sessionId":"s-1"}"#,
        )
        .unwrap();
        let failed: crate::dsh::NotifyPayload = serde_json::from_str(
            r#"{"kind":"task-end","title":"DSH 任务出错","reason":"error","sessionId":"s-1"}"#,
        )
        .unwrap();
        let mut dedupe = Dedupe::default();
        assert!(dedupe.should_show(&completed.dedupe_key()));
        assert!(dedupe.should_show(&failed.dedupe_key()));
        assert!(!dedupe.should_show(&failed.dedupe_key()));
    }

    #[test]
    fn recording_notifier_captures_both_fields() {
        let notifier = RecordingNotifier::default();
        notifier.notify("标题", "正文").expect("notify");
        let calls = notifier.calls.lock().expect("lock");
        assert_eq!(calls.as_slice(), [("标题".to_string(), "正文".to_string())]);
    }
}
