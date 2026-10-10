//! Read-only desktop release checks, independent of the dsh package installer.

use crate::state::{Phase, Shared};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};

const RELEASES_API: &str = "https://api.github.com/repos/Turing158/dsh-desktop/releases?per_page=1";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    name: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    version: String,
    name: String,
    notes: String,
    published_at: Option<String>,
    prerelease: bool,
    url: String,
    update_available: bool,
}

#[derive(Debug, Serialize)]
pub struct DesktopUpdate {
    current: String,
    release: Option<Release>,
}

fn release_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|_| "发布页地址无效")?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url
            .path()
            .starts_with("/Turing158/dsh-desktop/releases/tag/")
        || url.path().trim_end_matches('/').ends_with("/tag")
    {
        return Err("发布页地址无效".into());
    }
    Ok(url)
}

fn parse_release(bytes: &[u8], current: &str) -> Result<DesktopUpdate, String> {
    let releases: Vec<GithubRelease> =
        serde_json::from_slice(bytes).map_err(|_| "GitHub 返回的更新数据无效，请重新检测。")?;
    let current_version = Version::parse(current).map_err(|_| "无法识别当前软件版本。")?;
    let release = releases.into_iter().next().filter(|release| !release.draft);
    let release = release
        .map(|release| {
            let version = Version::parse(release.tag_name.trim().trim_start_matches('v'))
                .map_err(|_| "无法识别发布版本，请前往 GitHub 查看。")?;
            let url = release_url(&release.html_url)?;
            Ok::<_, String>(Release {
                update_available: version.cmp_precedence(&current_version).is_gt(),
                version: version.to_string(),
                name: release
                    .name
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or(release.tag_name),
                notes: release.body.unwrap_or_default(),
                published_at: release.published_at,
                prerelease: release.prerelease || !version.pre.is_empty(),
                url: url.to_string(),
            })
        })
        .transpose()?;
    Ok(DesktopUpdate {
        current: current.to_owned(),
        release,
    })
}

fn caller(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    let shared = window.state::<Shared>();
    let state = shared.lock().map_err(|_| "后台状态不可用")?;
    let allowed = match &state.phase {
        Phase::Running { url: expected, .. } => expected
            .parse::<tauri::Url>()
            .is_ok_and(|expected| url.scheme() == "http" && url.origin() == expected.origin()),
        _ => false,
    };
    if window.label() != "main"
        || !allowed
        || state.ui.phase == crate::ui_snapshot::UiPhase::Exiting
    {
        return Err("请在当前桌面应用中检测软件更新。".into());
    }
    Ok(())
}

pub fn authorize_backend(app: &AppHandle, instance: u64, url: &str) -> Result<(), String> {
    let url = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    app.add_capability(serde_json::json!({
        "identifier": format!("desktop-update-backend-{instance}"), "windows": ["main"], "local": false,
        "remote": { "urls": [format!("{}/*", url.origin().ascii_serialization())] },
        "permissions": ["allow-desktop-update"]
    }).to_string()).map_err(|e| e.to_string())
}

async fn check(current: &str) -> Result<DesktopUpdate, String> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("dsh-desktop/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法连接 GitHub，请检查网络后重试。")?;
    let network_error = |error: reqwest::Error| -> String {
        if error.is_timeout() {
            "检测软件更新超时，请重试。"
        } else {
            "无法连接 GitHub，请检查网络后重试。"
        }
        .into()
    };
    let mut response = client
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(network_error)?;
    if matches!(response.status().as_u16(), 403 | 429) {
        return Err("GitHub 暂时限制了请求，请稍后重试。".into());
    }
    if !response.status().is_success() {
        return Err(format!("GitHub HTTP {}", response.status().as_u16()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("GitHub 返回的更新数据过大。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    parse_release(&bytes, current)
}

#[tauri::command]
pub async fn check_desktop_update(window: WebviewWindow) -> Result<DesktopUpdate, String> {
    caller(&window)?;
    check(&window.app_handle().package_info().version.to_string()).await
}

#[tauri::command]
pub fn open_desktop_release(window: WebviewWindow, url: String) -> Result<(), String> {
    caller(&window)?;
    let url = release_url(&url)?;
    #[cfg(windows)]
    {
        use crate::dsh::CommandExt;
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url.as_str()])
            .creation_flags_no_window()
            .spawn()
            .map_err(|_| "无法打开发布页，请重试。")?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        Err("仅支持 Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(tag: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!([{
            "tag_name": tag, "html_url": format!("https://github.com/Turing158/dsh-desktop/releases/tag/{tag}"),
            "name": "Desktop release", "body": "## Changes\n- Fix", "published_at": "2026-10-05T14:59:05Z"
        }])).unwrap()
    }

    #[test]
    fn compares_semver_without_offering_downgrades_or_build_metadata_updates() {
        for (current, tag, available) in [
            ("0.1.0", "v0.1.0", false),
            ("0.1.9", "v0.1.10", true),
            ("0.2.0", "v0.1.10", false),
            ("1.0.0-rc.2", "v1.0.0-rc.10", true),
            ("1.0.0", "v1.0.0-rc.10", false),
            ("1.0.0-rc.1", "v1.0.0", true),
            ("1.0.0+local", "v1.0.0+release", false),
        ] {
            let info = parse_release(&payload(tag), current).unwrap();
            assert_eq!(info.current, current);
            assert_eq!(
                info.release.unwrap().update_available,
                available,
                "{current} -> {tag}"
            );
        }
    }

    #[test]
    fn handles_empty_releases_missing_optional_fields_and_invalid_data() {
        assert!(parse_release(b"[]", "0.1.0").unwrap().release.is_none());
        let mut data: serde_json::Value = serde_json::from_slice(&payload("v0.2.0-rc.1")).unwrap();
        data[0]["name"] = serde_json::Value::Null;
        data[0]["body"] = serde_json::Value::Null;
        data[0]["published_at"] = serde_json::Value::Null;
        let info = parse_release(&serde_json::to_vec(&data).unwrap(), "0.1.0")
            .unwrap()
            .release
            .unwrap();
        assert_eq!(info.name, "v0.2.0-rc.1");
        assert!(info.notes.is_empty() && info.prerelease);
        for bytes in [b"{}".as_slice(), b"not json", b"[{}]", &payload("invalid")] {
            assert!(parse_release(bytes, "0.1.0").is_err());
        }
    }

    #[test]
    fn only_opens_this_repository_release_pages() {
        assert!(
            release_url("https://github.com/Turing158/dsh-desktop/releases/tag/v0.1.0").is_ok()
        );
        for url in [
            "https://github.com/other/repo/releases/tag/v1",
            "https://github.com.evil.test/Turing158/dsh-desktop/releases/tag/v1",
            "http://github.com/Turing158/dsh-desktop/releases/tag/v1",
            "file:///C:/test.exe",
            "https://user@github.com/Turing158/dsh-desktop/releases/tag/v1",
            "https://github.com/Turing158/dsh-desktop/releases/tag/",
            "https://github.com/Turing158/dsh-desktop/releases/tag/v1?redirect=evil",
            "https://github.com/Turing158/dsh-desktop/releases/tag/../../../../other",
        ] {
            assert!(release_url(url).is_err(), "{url}");
        }
    }

    #[test]
    #[ignore = "read-only integration check against the public GitHub release API"]
    fn reads_live_github_release() {
        let info = tauri::async_runtime::block_on(check(env!("CARGO_PKG_VERSION"))).unwrap();
        println!("{}", serde_json::to_string(&info).unwrap());
    }
}
