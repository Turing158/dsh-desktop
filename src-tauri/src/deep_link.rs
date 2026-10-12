//! Deep links: parse, queue, and activate `deepseekharness://session/<id>`.
//!
//! The link is the app's own equivalent of Codex's "copy deep link": a scheme
//! URL that names one local session. The DSH server URL cannot play this role —
//! it binds an OS-assigned port and carries a one-time token (`dsh.rs`) — so the
//! link carries only the session id and the app translates it, after boot, into
//! a session selection through the page's own services.
//! Links omit the internal `session-` prefix; older links with it still open.
//!
//! ## The three stages
//!
//! **Parse** ([`parse`]) is a pure, strict function. A link can arrive from
//! anywhere — a browser, a chat message, a hand-built argv — and the docs for
//! both the deep-link and single-instance plugins warn that arguments can be
//! forged. Only `deepseekharness://session/<id>` (or the host-less
//! `deepseekharness:session/<id>` spelling) with a whitelist id is accepted;
//! everything else is logged and dropped, never surfaced as a dialog.
//!
//! **Queue** ([`offer`] / [`capture_startup_args`]) stores the parsed id in
//! [`crate::state::AppState::pending_deep_link`]. The slot is deliberate: a
//! user clicking a second link means the second one, not both. The queue
//! absorbs every arrival-time race — the app may still be booting, hidden in
//! the tray, in minimal mode with no window, or showing the failure page.
//!
//! **Activate** ([`try_activate`]) pushes the id into the page once — and only
//! once — every guard holds: backend `Running`, the DSH document loaded, and
//! the document's origin equal to the running backend's (the same origin match
//! `ui_snapshot::validate_caller` enforces for commands). The push is an eval
//! calling the bridge's `openDeepLink`; per the UI-snapshot plan's finding,
//! eval succeeding only means the script was submitted, so the queue is
//! cleared by the page's [`report_deep_link`] receipt, not by the push.
//! A link older than [`PENDING_TTL`] expires instead of firing late.
//!
//! ## Registry registration
//!
//! [`register`] asks the deep-link plugin to write the `HKCU\Software\Classes`
//! entries pointing at the current executable. It runs on every launch: it is
//! idempotent, needs no elevation (matching the `currentUser` NSIS install
//! mode), and re-pointing at the running exe self-heals the three shipping
//! forms this app has — a dev build, an installed build, and the portable exe,
//! whose path can change between runs. Registration failure is logged, not
//! fatal: a deep link is an additive affordance and must never block boot.

use std::ffi::OsString;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Url};

use crate::state::{Phase, Shared};
use crate::ui_snapshot::UiPhase;

/// The URL scheme this app registers and accepts.
pub const SCHEME: &str = "deepseekharness";

/// The one resource type the scheme currently carries. The link grammar is
/// `://<resource>/<id>`; anything else is a future extension this build must
/// reject rather than guess at.
const RESOURCE: &str = "session";

/// How long a queued link stays activatable.
///
/// Long enough to outlive a slow boot (the readiness wait allows 60 s), short
/// enough that clicking a link and finding the app closed an hour later does
/// not suddenly open a session on the next launch.
const PENDING_TTL: Duration = Duration::from_secs(5 * 60);

/// A link waiting for the page to be able to receive it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingLink {
    /// The validated session id — never the raw link text.
    pub session_id: String,
    /// When the link arrived, for the expiry check in [`try_activate`].
    pub created_at: Instant,
}

/// Why a link was rejected. Displayed only in the debug log: a deep link can
/// come from an untrusted source, so a bad one is dropped, not explained.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    /// `deepseekharness:` pointing at no session at all.
    MissingId,
    /// A different scheme, or not a URL at all.
    NotOurScheme,
    /// Our scheme, but the resource is not `session`.
    WrongResource,
    /// Our resource, but the link carries more than `<resource>/<id>` — a
    /// query, fragment, port, userinfo, extra path segments, or a disallowed
    /// character after decoding.
    ExtraParts,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            ParseError::MissingId => "缺少会话 id",
            ParseError::NotOurScheme => "不是本应用的协议链接",
            ParseError::WrongResource => "链接指向的资源不是会话",
            ParseError::ExtraParts => "链接携带了多余的部分或非法字符",
        };
        f.write_str(text)
    }
}

/// Validate one deep link and return the session id.
///
/// Accepts both spellings the OS can deliver — `deepseekharness://session/<id>`
/// (the registry's shell-open passes the URL through verbatim; the url crate
/// parses the part after `//` as host + path) and the host-less
/// `deepseekharness:session/<id>`. Both must name exactly one id; the id is
/// percent-decoded before validation, so an over-eager encoder cannot smuggle
/// a character the whitelist would reject in raw form. The returned internal id
/// includes `session-`, whether the link uses the short or legacy format.
pub fn parse(input: &str) -> Result<String, ParseError> {
    let url = Url::parse(input.trim()).map_err(|_| ParseError::NotOurScheme)?;
    if !url.scheme().eq_ignore_ascii_case(SCHEME) {
        return Err(ParseError::NotOurScheme);
    }
    // No form of this link has a port, credentials, a query, or a fragment;
    // their presence means the link was not minted by this app.
    if url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ParseError::ExtraParts);
    }
    // A trailing slash is normalization some callers apply, not a second
    // segment; strip one before validating so such a link still opens.
    fn strip_slash(segment: &str) -> &str {
        segment.strip_suffix('/').unwrap_or(segment)
    }
    match url.host_str() {
        Some(host) => {
            if !host.eq_ignore_ascii_case(RESOURCE) {
                return Err(ParseError::WrongResource);
            }
            let id = url.path().strip_prefix('/').ok_or(ParseError::WrongResource)?;
            validate_id(strip_slash(id))
        }
        None => {
            let (resource, id) = url.path().split_once('/').ok_or(ParseError::WrongResource)?;
            if !resource.eq_ignore_ascii_case(RESOURCE) {
                return Err(ParseError::WrongResource);
            }
            validate_id(strip_slash(id))
        }
    }
}

/// Validate the link's id and restore the internal `session-` prefix. Accept
/// older links that already include it, applying the size limit to the full id.
fn validate_id(raw: &str) -> Result<String, ParseError> {
    let decoded = percent_decode_utf8(raw);
    let suffix = decoded.strip_prefix("session-").unwrap_or(&decoded);
    if suffix.is_empty() {
        return Err(ParseError::MissingId);
    }
    if suffix.len() + "session-".len() > 128 {
        return Err(ParseError::ExtraParts);
    }
    if !suffix
        .bytes()
        .all(|byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'~' | b'-'))
    {
        return Err(ParseError::ExtraParts);
    }
    Ok(format!("session-{suffix}"))
}

/// Percent-decode one path segment, keeping undecodable input verbatim.
///
/// The id whitelist excludes `%`, so a link that arrives already decoded
/// (the common case) is untouched and an encoded one still validates on its
/// decoded form. Hand-rolled because the only consumer is this strict
/// whitelist — pulling in a decoder crate for 12 bytes of grammar is not
/// worth the dependency surface.
fn percent_decode_utf8(raw: &str) -> String {
    if !raw.contains('%') {
        return raw.to_string();
    }
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && bytes[index + 1..index + 3].iter().all(u8::is_ascii_hexdigit)
        {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).expect("ascii hex");
            out.push(u8::from_str_radix(hex, 16).expect("validated hex"));
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Find the first argv element that parses as one of our links.
///
/// Only elements that fully parse count — a path argument can never satisfy
/// the scheme check — so this is safe to run over the whole argv.
pub fn parse_argv<'a>(args: impl IntoIterator<Item = &'a str>) -> Option<String> {
    args.into_iter()
        .find(|arg| parse(arg).is_ok())
        .map(str::to_string)
}

/// Queue a validated link without touching the window.
fn queue(app: &AppHandle, input: &str) -> bool {
    let session_id = match parse(input) {
        Ok(session_id) => session_id,
        Err(error) => {
            crate::debug_log(&format!("[deep-link/rejected] {input} — {error}"));
            return false;
        }
    };
    if let Ok(mut guard) = app.state::<Shared>().lock() {
        guard.pending_deep_link = Some(PendingLink {
            session_id: session_id.clone(),
            created_at: Instant::now(),
        });
    }
    crate::debug_log(&format!("[deep-link/queued] {session_id}"));
    true
}

/// Queue a link and bring the window up for it.
///
/// The warm-start entry: the single-instance callback runs in the *first*
/// process when a second launch arrives carrying the link.
pub fn offer(app: &AppHandle, input: &str) {
    if !queue(app, input) {
        return;
    }
    // `show_main_window` unhides before focusing, which is what a link clicked
    // while the window sits in the tray needs; for a visible window it is a
    // cheap focus. Either way the link's own activation follows.
    crate::tray::show_main_window(app);
    try_activate(app);
}

/// The single-instance callback's router: `true` when argv carried a link.
///
/// Returning whether a link was found lets the callback keep its original
/// plain-launch behavior — showing the window — for launches without one.
pub fn offer_argv(app: &AppHandle, argv: &[String]) -> bool {
    let Some(link) = parse_argv(argv.iter().map(String::as_str)) else {
        return false;
    };
    offer(app, &link);
    true
}

/// Queue a link from this process's own launch arguments.
///
/// The cold-start entry. Runs in setup, where the window already exists but
/// the boot has not started: [`try_activate`] will refuse every guard until
/// the DSH document is live, and the page-load hook fires the push then.
pub fn capture_startup_args(app: &AppHandle) {
    let args = std::env::args_os().skip(1).collect::<Vec<OsString>>();
    let Some(link) = parse_argv(args.iter().filter_map(|arg| arg.to_str())) else {
        return;
    };
    queue(app, &link);
}

/// Push the queued link into the page if every guard holds, else wait.
///
/// Called on every arrival path — [`offer`], and the page-load hook in
/// `main.rs` for cold start, reload, and the minimal-mode window rebuild. The
/// guards mirror `navigate_current` plus `refresh_bridge`: no push into a
/// window that is being destroyed, and no push into a document that cannot
/// receive it. Refusing silently is correct here — the caller will try again
/// on the next page load, and the expiry bounds how long that can continue.
pub fn try_activate(app: &AppHandle) {
    let shared = app.state::<Shared>().inner().clone();

    let pending = {
        let Ok(guard) = shared.lock() else {
            return;
        };
        guard.pending_deep_link.clone()
    };
    let Some(pending) = pending else {
        return;
    };
    if pending.created_at.elapsed() > PENDING_TTL {
        // Only drop the link that expired; a newer offer may have replaced it.
        if let Ok(mut guard) = shared.lock() {
            if guard.pending_deep_link.as_ref() == Some(&pending) {
                guard.pending_deep_link = None;
            }
        }
        crate::debug_log("[deep-link/expired]");
        return;
    }

    // One lock pass over everything the guards need, then eval outside it.
    let running = {
        let Ok(guard) = shared.lock() else {
            return;
        };
        let Phase::Running { url, .. } = &guard.phase else {
            return;
        };
        // The window teardown phases own the webview's lifetime; pushing into
        // one races destruction (same refusal `navigate_current` applies).
        if matches!(
            guard.ui.phase,
            UiPhase::Destroying | UiPhase::Minimal | UiPhase::Exiting
        ) {
            return;
        }
        // Same readiness the page needs for the push to land on a live
        // document. Note this is deliberately NOT `ui.enabled`: that flag
        // gates the snapshot machinery (opt-in via the `DSH_DESKTOP_
        // WEBVIEW_RESTORE` environment variable), while the bridge that
        // receives deep links is injected into every document
        // unconditionally — gating on it would make links work only when
        // an unrelated opt-in is set.
        if !guard.ui.loaded {
            return;
        }
        match url.parse::<Url>() {
            Ok(running) => running,
            Err(_) => return,
        }
    };

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(document) = window.url() else {
        return;
    };
    // The DSH origin specifically — not merely "local", which would also match
    // the boot page and push a link into a document that cannot consume it.
    if document.origin() != running.origin() {
        return;
    }

    let argument = serde_json::json!({ "sessionId": pending.session_id }).to_string();
    match window.eval(&format!(
        "window.__DSH_UI_STATE__?.openDeepLink({argument});"
    )) {
        Ok(()) => crate::debug_log(&format!("[deep-link/pushed] {}", pending.session_id)),
        Err(error) => crate::debug_log(&format!("[deep-link/push-failed] {error}")),
    }
}

/// The page-load hook: a finished navigation is the moment a fresh document
/// can receive the queued link.
pub fn page_loaded(window: &tauri::WebviewWindow) {
    try_activate(window.app_handle());
}

/// Grant the deep-link commands to the current backend origin.
///
/// Same shape as the ui-snapshot and terminal grants: a runtime capability
/// scoped to one origin, one instance, instead of a static loopback-wide entry.
pub fn authorize_backend(app: &AppHandle, instance: u64, url: &str) -> Result<(), String> {
    let url = url.parse::<Url>().map_err(|_| "deep-link-origin")?;
    let capability = serde_json::json!({
        "identifier": format!("deep-link-backend-{instance}"),
        "windows": ["main"],
        "local": false,
        "remote": { "urls": [format!("{}/*", url.origin().ascii_serialization())] },
        "permissions": ["allow-deep-link"]
    });
    app.add_capability(capability.to_string())
        .map_err(|_| "deep-link-permission".into())
}

/// Register the scheme in the per-user registry. See the module docs.
pub fn register(app: &AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;
    if let Err(error) = app.deep_link().register(SCHEME) {
        crate::debug_log(&format!("[deep-link/register] {error}"));
    }
}

/// The page's receipt for an activation attempt.
///
/// Until this runs, the queue holds — so a document reloaded between push and
/// consumption gets the link again on its own Finished event. Validating the
/// session id against the queued one keeps a page (which is a remote origin,
/// however narrowed its grants) from clearing or acknowledging arbitrary
/// links it was never given.
#[tauri::command]
pub fn report_deep_link(
    window: tauri::WebviewWindow,
    session_id: String,
    outcome: String,
) -> Result<(), String> {
    let app = window.app_handle();
    let shared = app.state::<Shared>();
    let mut guard = shared.lock().map_err(|_| "deep-link-state")?;
    if window.label() != "main" {
        return Err("deep-link-window".into());
    }
    let document = window.url().map_err(|_| "deep-link-origin")?;
    let Phase::Running { url, .. } = &guard.phase else {
        return Err("deep-link-origin".into());
    };
    let running = url.parse::<Url>().map_err(|_| "deep-link-origin")?;
    if document.origin() != running.origin() {
        return Err("deep-link-origin".into());
    }
    let Some(pending) = guard.pending_deep_link.as_ref() else {
        return Err("deep-link-unknown".into());
    };
    if pending.session_id != session_id {
        return Err("deep-link-unknown".into());
    }
    match outcome.as_str() {
        "opened" => guard.push_log(format!("深度链接已打开：{session_id}")),
        "missing" => guard.push_log(format!("深度链接指向的会话不存在：{session_id}")),
        other => return Err(format!("deep-link-outcome:{other}")),
    }
    guard.pending_deep_link = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This file's own source is not under test here; `main.rs` is, because
    /// the wiring this module depends on lives there and has no runtime
    /// presence a unit test could observe.
    const MAIN_RS: &str = include_str!("main.rs");
    const PERMISSION_TOML: &str = include_str!("../permissions/deep-link.toml");

    #[test]
    fn a_canonical_link_parses_to_its_session_id() {
        assert_eq!(
            parse("deepseekharness://session/b4899765-8e01-4e03-9221-0f4520dccc78"),
            Ok("session-b4899765-8e01-4e03-9221-0f4520dccc78".to_string())
        );
    }

    #[test]
    fn legacy_links_still_name_the_same_internal_session() {
        for link in [
            "deepseekharness://session/session-b4899765-8e01-4e03-9221-0f4520dccc78",
            "deepseekharness:session/session-b4899765-8e01-4e03-9221-0f4520dccc78/",
        ] {
            assert_eq!(
                parse(link),
                Ok("session-b4899765-8e01-4e03-9221-0f4520dccc78".to_string())
            );
        }
    }

    #[test]
    fn both_spellings_and_cases_name_the_same_session() {
        let id = "session-abc-123";
        for link in [
            "deepseekharness://session/abc-123",
            "deepseekharness:session/abc-123",
            "DEEPSEEKHARNESS://session/abc-123",
            "deepseekharness://SESSION/abc-123",
            // One trailing slash is caller normalization, not a second segment.
            "deepseekharness://session/abc-123/",
        ] {
            assert_eq!(parse(link), Ok(id.to_string()), "link: {link}");
        }
    }

    #[test]
    fn an_encoded_id_validates_on_its_decoded_form() {
        assert_eq!(
            parse("deepseekharness://session/%61bc"),
            Ok("session-abc".to_string())
        );
        // '-' is never encoded; 's' can be by an over-eager caller.
        assert_eq!(
            parse("deepseekharness://session/%73ession-abc"),
            Ok("session-abc".to_string())
        );
    }

    #[test]
    fn foreign_schemes_and_non_urls_are_rejected() {
        for link in [
            "",
            "not a url",
            "https://session/abc",
            "dsh://session/abc",
            "deepseekharness2://session/abc",
            "file:///C:/Windows/System32/calc.exe",
        ] {
            assert_eq!(parse(link), Err(ParseError::NotOurScheme), "link: {link}");
        }
    }

    #[test]
    fn other_resources_are_rejected() {
        for link in [
            "deepseekharness://workspace/w-1",
            "deepseekharness:///session/abc",
            "deepseekharness:workspace/abc",
        ] {
            assert_eq!(parse(link), Err(ParseError::WrongResource), "link: {link}");
        }
        // An id-less link with an empty path is a wrong resource (the parser
        // leaves the path empty), while the normalized "/" spelling reaches
        // the id validation and fails as a missing id. Both are rejections —
        // these pins exist so a parser change cannot silently widen grammar.
        assert_eq!(
            parse("deepseekharness://session"),
            Err(ParseError::WrongResource)
        );
        assert_eq!(
            parse("deepseekharness://session/"),
            Err(ParseError::MissingId)
        );
        assert_eq!(
            parse("deepseekharness://session/session-"),
            Err(ParseError::MissingId)
        );
    }

    #[test]
    fn links_carrying_more_than_an_id_are_rejected() {
        for link in [
            "deepseekharness://session/abc?next=/x",
            "deepseekharness://session/abc#top",
            "deepseekharness://session/abc/def",
            "deepseekharness://user:pw@session/abc",
            "deepseekharness://session:80/abc",
            // Encoded separators decode into a second segment.
            "deepseekharness://session/abc%2F..%2Fx",
            // Non-whitelist characters, raw or via encoding.
            "deepseekharness://session/会话",
            "deepseekharness://session/abc def",
        ] {
            assert_eq!(parse(link), Err(ParseError::ExtraParts), "link: {link}");
        }
        // Dot segments are folded by the URL parser itself, so a traversal
        // arrives as a plain (whitelist-clean) id and can never carry "../"
        // into the page — assert that collapse rather than a rejection.
        assert_eq!(
            parse("deepseekharness://session/abc/../system32"),
            Ok("session-system32".to_string())
        );
    }

    #[test]
    fn ids_are_bounded() {
        for prefix in ["", "session-"] {
            let long = "a".repeat(121);
            assert_eq!(
                parse(&format!("deepseekharness://session/{prefix}{long}")),
                Err(ParseError::ExtraParts)
            );
            let fits = "a".repeat(120);
            assert_eq!(
                parse(&format!("deepseekharness://session/{prefix}{fits}")),
                Ok(format!("session-{fits}"))
            );
        }
    }

    #[test]
    fn argv_yields_the_first_link_and_ignores_everything_else() {
        let argv = [
            "--some-flag",
            "C:\\Program Files\\DeepseekHarness\\DeepseekHarness.exe",
            "deepseekharness://session/abc",
            "deepseekharness://session/session-def",
        ];
        assert_eq!(
            parse_argv(argv),
            Some("deepseekharness://session/abc".to_string())
        );
        assert_eq!(parse_argv(["--flag", "/path/to/file"]), None);
    }

    /// The warm-start router must sit inside the single-instance callback and
    /// keep the plain-launch show for launches without a link.
    #[test]
    fn the_single_instance_callback_routes_links_before_showing() {
        let start = MAIN_RS
            .find("tauri_plugin_single_instance::init")
            .expect("single instance must be registered");
        let end = MAIN_RS[start..]
            .find("}))")
            .map(|index| start + index)
            .expect("the callback must close");
        let callback = &MAIN_RS[start..end];
        assert!(
            callback.contains("deep_link::offer_argv(app, &argv)"),
            "the callback must route argv through deep_link::offer_argv"
        );
        assert!(
            callback.contains("tray::show_main_window(app)"),
            "the callback must keep showing the window for plain launches"
        );
    }

    #[test]
    fn the_deep_link_plugin_registers_after_single_instance() {
        // The deep-link README requires the single-instance plugin first; a
        // swap would change where second-launch links are delivered.
        let single = MAIN_RS
            .find("tauri_plugin_single_instance::init")
            .expect("single instance registered");
        let deep = MAIN_RS
            .find("tauri_plugin_deep_link::init()")
            .expect("deep link plugin registered");
        assert!(single < deep, "single-instance must come before deep-link");
    }

    #[test]
    fn the_report_command_is_registered_and_granted() {
        // Once an ACL manifest exists, a command missing from a permission is
        // refused — and `acl-coverage.test.mjs` enforces the same pairing from
        // the JS side. These assertions keep the Rust-side wiring honest too.
        let handler = MAIN_RS
            .find("generate_handler![")
            .map(|start| {
                let rest = &MAIN_RS[start..];
                let end = rest.find("])").expect("the handler list must close");
                &rest[..end]
            })
            .expect("generate_handler must exist");
        assert!(
            handler.contains("deep_link::report_deep_link"),
            "report_deep_link must be registered with the IPC handler"
        );
        assert!(
            PERMISSION_TOML.contains("\"report_deep_link\""),
            "the permission file must grant report_deep_link"
        );
    }

    #[test]
    fn finished_page_loads_hand_off_to_deep_link() {
        // Cold start, reload, and the minimal-mode rebuild all reach the page
        // through a navigation; the Finished hook is what fires the push once
        // the DSH document can actually receive it.
        let start = MAIN_RS
            .find(".on_page_load(")
            .expect("the window must arm a page-load handler");
        let rest = &MAIN_RS[start..];
        let end = rest.find("disable_drag_drop_handler").expect("the next builder call");
        assert!(
            rest[..end].contains("deep_link::page_loaded(&window)"),
            "on_page_load must hand finished loads to deep_link"
        );
    }

    #[test]
    fn startup_args_are_captured_and_the_scheme_registered_in_setup() {
        let setup = MAIN_RS
            .find(".setup(|app| {")
            .map(|start| {
                let rest = &MAIN_RS[start..];
                let end = rest.find("Ok(())").expect("setup must end");
                &rest[..end]
            })
            .expect("setup must exist");
        assert!(
            setup.contains("deep_link::register(app.handle());"),
            "setup must register the scheme in the per-user registry"
        );
        assert!(
            setup.contains("deep_link::capture_startup_args(app.handle());"),
            "setup must queue a link passed to this process's own launch"
        );
    }

    #[test]
    fn the_backend_grant_runs_next_to_the_other_two() {
        // The runtime capability is what makes report_deep_link callable from
        // the DSH origin; missing it would fail the page's receipt silently.
        assert!(
            MAIN_RS.contains("deep_link::authorize_backend(&app, instance, &url)?;"),
            "boot readiness must grant the deep-link permission to the backend origin"
        );
    }
}
