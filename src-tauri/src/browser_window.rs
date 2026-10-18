//! Hand browser login to the system's default browser. A hidden, short-lived
//! blank WebView preserves upstream's synchronous window.open() contract until
//! it supplies the authorization URL; no external page loads in this WebView.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{
    webview::{NewWindowFeatures, NewWindowResponse},
    AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder,
};

fn allowed_url(url: &Url) -> bool {
    url.as_str() == "about:blank"
        || matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
}

pub fn open(
    app: &AppHandle,
    url: Url,
    features: NewWindowFeatures,
) -> NewWindowResponse<tauri::Wry> {
    crate::debug_log(&format!("[browser] new window scheme={}", url.scheme()));
    let Some(main) = app.get_webview_window("main") else {
        return NewWindowResponse::Deny;
    };
    if crate::window_controls::validate_window(&main).is_err() || !allowed_url(&url) {
        crate::debug_log("[browser] rejected window origin or destination");
        return NewWindowResponse::Deny;
    }
    if url.as_str() != "about:blank" {
        handoff(app, None, url);
        return NewWindowResponse::Deny;
    }
    // Upstream preopens about:blank and later navigates that window. Keep its
    // handle valid only until we can hand the real URL to the default browser.
    // Authorization state and cancellation are owned by the DSH backend, so
    // they keep working after this temporary window is destroyed.
    let label = format!("browser-{}", uuid::Uuid::new_v4());
    let popup_app = app.clone();
    let popup_label = label.clone();
    let handed_off = Arc::new(AtomicBool::new(false));
    let result = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .window_features(features)
        .title("dsh browser handoff")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .on_navigation(move |url| {
            if url.as_str() == "about:blank" {
                return true;
            }
            if !handed_off.swap(true, Ordering::AcqRel) {
                handoff(&popup_app, Some(popup_label.clone()), url.clone());
            }
            false
        })
        .build();
    match result {
        Ok(window) => {
            crate::debug_log("[browser] created related window");
            bind_script_close(&window);
            window.on_window_event(|event| {
                if matches!(
                    event,
                    tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }
                ) {
                    crate::debug_log(&format!("[browser] window event {event:?}"));
                }
            });
            NewWindowResponse::Create { window }
        }
        Err(error) => {
            crate::debug_log(&format!("[browser] window creation failed: {error}"));
            NewWindowResponse::Deny
        }
    }
}

fn handoff(app: &AppHandle, label: Option<String>, url: Url) {
    let app = app.clone();
    // Defer both shell activation and destruction until outside WebView2's
    // navigation callback. run_on_main_thread executes inline on that thread,
    // so dispatch from a worker to ensure that the callback has returned first.
    std::thread::spawn(move || {
        let owned = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let popup = label
                .as_deref()
                .and_then(|label| owned.get_webview_window(label));
            if label.is_some() && popup.is_none() {
                return;
            }
            let result = owned
                .get_webview_window("main")
                .ok_or_else(|| "main window unavailable".to_owned())
                .and_then(|main| crate::window_controls::validate_window(&main))
                .and_then(|_| open_default_browser(&url));
            if let Err(error) = result {
                crate::debug_log(&format!(
                    "[browser] default browser handoff failed: {error}"
                ));
            }
            // Even if activation fails, leave no hidden window behind;
            // upstream's copy-link action remains available for manual login.
            if let Some(window) = popup {
                let _ = window.destroy();
            }
        }) {
            crate::debug_log(&format!("[browser] handoff dispatch failed: {error}"));
        }
    });
}

fn open_default_browser(url: &Url) -> Result<(), String> {
    if !allowed_url(url) || url.as_str() == "about:blank" {
        return Err("only HTTP(S) browser destinations are allowed".into());
    }
    // An explicit debug-only capture lets the real WebView smoke test open the
    // handed-off URL in a separate browser profile without changing the user's
    // default browser or borrowing its cookies. Release builds always use the OS.
    #[cfg(debug_assertions)]
    if std::env::var("DSH_DESKTOP_SMOKE_CAPTURE_BROWSER").as_deref() == Ok("1") {
        use std::io::Write;
        let root = std::env::var_os("DSH_DESKTOP_SMOKE_DIR").ok_or("missing smoke directory")?;
        let path = std::path::PathBuf::from(root).join("browser-open.jsonl");
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|error| error.to_string())?;
        return writeln!(file, "{}", serde_json::json!({ "url": url.as_str() }))
            .map_err(|error| error.to_string());
    }
    #[cfg(windows)]
    {
        use windows::{
            core::{w, PCWSTR},
            Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        };
        let destination: Vec<u16> = url.as_str().encode_utf16().chain(Some(0)).collect();
        // Pass the URL directly to the registered HTTP(S) handler, with no
        // command shell, executable choice or command-line interpolation.
        let result = unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                PCWSTR(destination.as_ptr()),
                None,
                None,
                SW_SHOWNORMAL,
            )
        };
        if result.0 as isize <= 32 {
            Err(format!(
                "Windows browser activation failed ({})",
                result.0 as isize
            ))
        } else {
            Ok(())
        }
    }
    #[cfg(not(windows))]
    Err("仅支持 Windows".into())
}

#[cfg(windows)]
fn bind_script_close(window: &tauri::WebviewWindow) {
    use webview2_com::WindowCloseRequestedEventHandler;

    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let result = window.with_webview(move |webview| {
        // Wry closes its child HWND for window.close(). The containing Tauri
        // window also needs to be destroyed when login is cancelled before
        // the authorization URL arrives.
        let result = (|| -> windows::core::Result<()> {
            unsafe {
                let core = webview.controller().CoreWebView2()?;
                let mut token = Default::default();
                core.add_WindowCloseRequested(
                    &WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
                        crate::debug_log("[browser] script close requested");
                        if let Some(window) = app.get_webview_window(&label) {
                            // destroy() queues the operation outside the COM callback.
                            let _ = window.destroy();
                        }
                        Ok(())
                    })),
                    &mut token,
                )?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            crate::debug_log(&format!("[browser] close handler failed: {error}"));
        }
    });
    if let Err(error) = result {
        crate::debug_log(&format!("[browser] close handler dispatch failed: {error}"));
    }
}

#[cfg(not(windows))]
fn bind_script_close(_: &tauri::WebviewWindow) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_launcher_rejects_nonweb_destinations_before_calling_the_os() {
        for url in [
            "about:blank",
            "file:///C:/secret.txt",
            "javascript:alert(1)",
            "deepseekharness://session/test",
            "https://user:pass@example.com/",
        ] {
            assert!(
                open_default_browser(&url.parse().unwrap()).is_err(),
                "{url}"
            );
        }
    }

    #[test]
    fn browser_destinations_allow_web_login_but_not_local_files_or_app_protocols() {
        for url in [
            "about:blank",
            "https://platform.deepseek.com/dsh/authorize?state=test",
            "http://127.0.0.1:3080/oauth/callback?code=test",
        ] {
            assert!(allowed_url(&url.parse().unwrap()), "{url}");
        }
        for url in [
            "file:///C:/secret.txt",
            "tauri://localhost/",
            "javascript:alert(1)",
            "data:text/html,test",
            "deepseekharness://session/test",
            "https://user:pass@example.com/",
        ] {
            assert!(!allowed_url(&url.parse().unwrap()), "{url}");
        }
    }
}
