//! Delivering notifications to Windows.
//!
//! Kept behind a small trait so the transport can change (the Tauri plugin today,
//! a direct WinRT call later) without touching the call sites that decide *when*
//! to notify.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// Something that can raise an OS notification.
pub trait Notifier: Send + Sync {
    /// Show one notification. Implementations must not panic on failure.
    fn notify(&self, title: &str, body: &str) -> Result<(), String>;
}

/// The production notifier, backed by `tauri-plugin-notification`.
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
        self.app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| error.to_string())
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
