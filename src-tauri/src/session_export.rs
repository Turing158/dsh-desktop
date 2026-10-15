//! Stream Session ZIPs through WebView2's authenticated download manager.
//! Choose a native destination before starting WebView2's authenticated download.

use crate::directory_picker::pick_directory;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{webview::DownloadEvent, Manager, Webview};

struct PreparedExport {
    session: String,
    origin: String,
    path: PathBuf,
    created: Instant,
}

#[derive(Default)]
pub struct ExportDestinations(Mutex<HashMap<String, PreparedExport>>);

impl ExportDestinations {
    fn prepare(&self, session: String, origin: String, path: PathBuf) -> Result<String, String> {
        let mut pending = self.0.lock().map_err(|e| e.to_string())?;
        // A failed HEAD request or a closed page may never start its download.
        pending.retain(|_, export| export.created.elapsed() < Duration::from_secs(300));
        let request = uuid::Uuid::new_v4().to_string();
        pending.insert(
            request.clone(),
            PreparedExport {
                session,
                origin,
                path,
                created: Instant::now(),
            },
        );
        Ok(request)
    }

    fn take(&self, request: &str, session: &str, origin: &str) -> Result<PathBuf, String> {
        let mut pending = self.0.lock().map_err(|e| e.to_string())?;
        let export = pending
            .remove(request)
            .ok_or("请重新选择 Session 日志的保存文件夹。")?;
        if export.session != session
            || export.origin != origin
            || export.created.elapsed() >= Duration::from_secs(300)
        {
            return Err("Session 日志保存位置已失效，请重试。".into());
        }
        Ok(export.path)
    }
}

/// Run the modal dialog outside WebView2 callbacks: a nested message loop in
/// DownloadStarting can deadlock WebView2. No download starts until it returns.
#[tauri::command]
pub async fn prepare_session_export(
    window: tauri::WebviewWindow,
    session_id: String,
) -> Result<Option<String>, String> {
    if session_id.is_empty() {
        return Err("Session ID 不能为空".into());
    }
    let page = window.url().map_err(|e| e.to_string())?;
    let identity = {
        let shared = window.state::<crate::state::Shared>();
        let state = shared.lock().map_err(|e| e.to_string())?;
        if window.label() != "main" || !crate::remote_control::allowed_origin(&page, &state.phase) {
            return Err("仅允许从当前桌面会话导出日志".into());
        }
        crate::remote_control::identity(&state)
    };
    let owner = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
    let directory = tauri::async_runtime::spawn_blocking(move || {
        pick_directory(owner, "选择 Session 日志保存文件夹", "保存到此文件夹")
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("无法选择 Session 日志保存文件夹：{e}"))?;
    let Some(directory) = directory else {
        return Ok(None);
    };
    {
        let shared = window.state::<crate::state::Shared>();
        let state = shared.lock().map_err(|e| e.to_string())?;
        if crate::remote_control::identity(&state) != identity
            || !crate::remote_control::allowed_origin(&page, &state.phase)
        {
            return Err("当前会话页面已变化，请重新导出日志。".into());
        }
    }
    let path =
        destination(&directory, &session_id).map_err(|e| format!("无法保存 Session 日志：{e}"))?;
    window
        .state::<ExportDestinations>()
        .prepare(session_id, page.origin().ascii_serialization(), path)
        .map(Some)
}

fn session_id(url: &tauri::Url) -> Option<String> {
    if url.path() != "/api/session.export" {
        return None;
    }
    url.query_pairs()
        .find(|(key, value)| key == "sessionId" && !value.is_empty())
        .map(|(_, value)| value.into_owned())
}

fn destination(directory: &Path, session: &str) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(directory)?;
    let safe: String = session
        .chars()
        .take(100)
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    // Every export gets a fresh name, including concurrent exports of one Session.
    Ok(directory.join(format!("dsh-session-{safe}-{}.zip", uuid::Uuid::new_v4())))
}

fn report(
    webview: &Webview,
    session: &str,
    request: &str,
    status: &str,
    path: Option<&Path>,
    error: Option<String>,
) {
    let detail = serde_json::json!({
        "sessionId": session,
        "requestId": request,
        "status": status,
        "path": path.map(|p| p.to_string_lossy()),
        "error": error,
    });
    let _ = webview.eval(format!(
        "window.dispatchEvent(new CustomEvent('dsh-desktop:session-export',{{detail:{detail}}}))"
    ));
}

pub fn on_download(webview: Webview, event: DownloadEvent<'_>) -> bool {
    let url = match &event {
        DownloadEvent::Requested { url, .. } | DownloadEvent::Finished { url, .. } => url,
        _ => return true,
    };
    let Some(session) = session_id(url) else {
        return true;
    };
    let request = url
        .query_pairs()
        .find(|(key, _)| key == "desktopExportId")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    let allowed = webview.label() == "main"
        && webview
            .url()
            .is_ok_and(|page| page.origin() == url.origin())
        && webview
            .app_handle()
            .state::<crate::state::Shared>()
            .lock()
            .is_ok_and(|state| crate::remote_control::allowed_origin(url, &state.phase));
    if !allowed {
        return false;
    }
    let origin = url.origin().ascii_serialization();

    match event {
        DownloadEvent::Requested {
            destination: target,
            ..
        } => {
            let path = webview
                .state::<ExportDestinations>()
                .take(&request, &session, &origin);
            match path {
                Ok(path) => {
                    *target = path;
                    report(&webview, &session, &request, "started", Some(target), None);
                    true
                }
                Err(error) => {
                    report(
                        &webview,
                        &session,
                        &request,
                        "error",
                        None,
                        Some(format!("无法保存 Session 日志：{error}")),
                    );
                    false
                }
            }
        }
        DownloadEvent::Finished { path, success, .. } => {
            if success && path.is_some() {
                report(
                    &webview,
                    &session,
                    &request,
                    "success",
                    path.as_deref(),
                    None,
                );
            } else {
                report(
                    &webview,
                    &session,
                    &request,
                    "error",
                    None,
                    Some("Session 日志下载未完成，请重试。".into()),
                );
            }
            true
        }
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_destinations_are_single_use_and_bound_to_the_export() {
        let destinations = ExportDestinations::default();
        let path = PathBuf::from(r"D:\Chosen folder\日志\session.zip");
        let request = destinations
            .prepare("s1".into(), "http://localhost:3080".into(), path.clone())
            .unwrap();
        assert_eq!(
            destinations
                .take(&request, "s1", "http://localhost:3080")
                .unwrap(),
            path
        );
        assert!(destinations
            .take(&request, "s1", "http://localhost:3080")
            .is_err());
        for (session, origin) in [
            ("s2", "http://localhost:3080"),
            ("s1", "http://localhost:3081"),
        ] {
            let request = destinations
                .prepare("s1".into(), "http://localhost:3080".into(), path.clone())
                .unwrap();
            assert!(destinations.take(&request, session, origin).is_err());
        }
        let request = destinations
            .prepare("s1".into(), "http://localhost:3080".into(), path)
            .unwrap();
        destinations
            .0
            .lock()
            .unwrap()
            .get_mut(&request)
            .unwrap()
            .created = Instant::now() - Duration::from_secs(301);
        assert!(destinations
            .take(&request, "s1", "http://localhost:3080")
            .is_err());
        assert!(destinations
            .take("unselected", "s1", "http://localhost:3080")
            .is_err());
    }

    #[test]
    fn export_routes_only() {
        assert_eq!(
            session_id(
                &"http://localhost/api/session.export?sessionId=abc&includeDescendants=true"
                    .parse()
                    .unwrap()
            )
            .as_deref(),
            Some("abc")
        );
        for route in [
            "/other?sessionId=abc",
            "/api/session.export",
            "/api/session.export?sessionId=",
        ] {
            assert!(session_id(&format!("http://localhost{route}").parse().unwrap()).is_none());
        }
    }

    #[test]
    fn filenames_stay_in_the_download_folder_and_preserve_previous_exports() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("Sessions");
        let first = destination(&directory, "../../会话\\CON:<test>").unwrap();
        std::fs::write(&first, b"previous ZIP").unwrap();
        let next = destination(&directory, "../../会话\\CON:<test>").unwrap();
        assert_eq!(first.parent(), Some(directory.as_path()));
        assert_eq!(next.parent(), Some(directory.as_path()));
        assert_ne!(first, next);
        assert_eq!(std::fs::read(first).unwrap(), b"previous ZIP");
        assert_eq!(next.extension().unwrap(), "zip");
        let blocked = temp.path().join("file");
        std::fs::write(&blocked, b"keep").unwrap();
        assert!(destination(&blocked, "abc").is_err());
        assert_eq!(std::fs::read(blocked).unwrap(), b"keep");
    }
}
