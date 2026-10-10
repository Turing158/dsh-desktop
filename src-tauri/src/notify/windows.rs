//! Per-user notification identity and WinRT delivery. No installer, elevation,
//! JavaScript permission, or borrowed PowerShell identity is needed.

use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::time::{Duration, Instant};

use ::windows::core::{Interface, Result as WinResult, BSTR, GUID, HRESULT, HSTRING};
use ::windows::Data::Xml::Dom::XmlDocument;
use ::windows::Foundation::TypedEventHandler;
use ::windows::Win32::Foundation::{ERROR_NOT_FOUND, PROPERTYKEY, RPC_E_CHANGED_MODE};
use ::windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use ::windows::Win32::System::Com::{
    CoCreateInstance, CoIncrementMTAUsage, CoTaskMemFree, IPersistFile, CLSCTX_INPROC_SERVER,
    STGM_READ,
};
use ::windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
use ::windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use ::windows::Win32::UI::Shell::{
    FOLDERID_Programs, IShellLinkW, SHChangeNotify, SHGetKnownFolderPath,
    SetCurrentProcessExplicitAppUserModelID, ShellLink, KF_FLAG_DEFAULT, SHCNE_CREATE,
    SHCNE_UPDATEITEM, SHCNF_FLUSH, SHCNF_PATHW, SLGP_RAWPATH,
};
use ::windows::UI::Notifications::{
    NotificationSetting, ToastDismissedEventArgs, ToastFailedEventArgs, ToastNotification,
    ToastNotificationManager,
};

// PKEY_AppUserModel_ID. Declared here to avoid enabling the unrelated
// EnhancedStorage feature that happens to export this Shell property key.
const APP_ID_PROPERTY: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
    pid: 5,
};
// One stable app-owned filename, separate from the installer's shortcut.
const SHORTCUT_NAME: &str = "DeepseekHarness Desktop.lnk";

/// Balance our initialization on either the main STA or a worker thread.
/// An existing apartment of a different type already supplies COM/WinRT.
struct Apartment(bool);

impl Apartment {
    fn new() -> WinResult<Self> {
        // windows-rs caches agile WinRT activation factories for the process.
        // Keep the MTA alive for the same lifetime, including between workers;
        // otherwise an unloaded XML factory can leave a dangling cached vtable.
        // This is the same process-lifetime pin used by windows-core's loader.
        static MTA: OnceLock<Result<(), HRESULT>> = OnceLock::new();
        (*MTA.get_or_init(|| {
            unsafe { CoIncrementMTAUsage() }
                .map(|_| ())
                .map_err(|e| e.code())
        }))
        .map_err(::windows::core::Error::from_hresult)?;
        match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
            Ok(()) => Ok(Self(true)),
            Err(error) if error.code() == RPC_E_CHANGED_MODE => Ok(Self(false)),
            Err(error) => Err(error),
        }
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { RoUninitialize() };
        }
    }
}

pub struct Registration {
    pub shortcut: PathBuf,
    pub changed: bool,
}

pub fn register(app_id: &str) -> Result<Registration, String> {
    let _apartment = Apartment::new().map_err(|e| e.to_string())?;
    unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(app_id)) }
        .map_err(|e| format!("设置通知进程身份失败：{e}"))?;
    let shortcut = programs_dir()
        .map_err(|e| e.to_string())?
        .join(SHORTCUT_NAME);
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let changed = ensure_shortcut(&shortcut, &exe, app_id)?;
    Ok(Registration { shortcut, changed })
}

fn programs_dir() -> WinResult<PathBuf> {
    unsafe {
        let value = SHGetKnownFolderPath(&FOLDERID_Programs, KF_FLAG_DEFAULT, None)?;
        let path = PathBuf::from(OsString::from_wide(value.as_wide()));
        CoTaskMemFree(Some(value.0.cast()));
        Ok(path)
    }
}

fn wide_text(buffer: &[u16]) -> String {
    String::from_utf16_lossy(&buffer[..buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len())])
}

fn same_path(actual: &str, expected: &Path) -> bool {
    if actual.eq_ignore_ascii_case(&expected.to_string_lossy()) {
        return true;
    }
    // Shell links expand 8.3 paths (TURING~1 -> Turing_ICE). Comparing their
    // spelling would rewrite a correct shortcut on every launch.
    match (
        std::fs::canonicalize(actual),
        std::fs::canonicalize(expected),
    ) {
        (Ok(actual), Ok(expected)) => actual
            .to_string_lossy()
            .eq_ignore_ascii_case(&expected.to_string_lossy()),
        _ => false,
    }
}

fn shortcut_matches(shortcut: &Path, exe: &Path, app_id: &str) -> WinResult<bool> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        let file: IPersistFile = link.cast()?;
        file.Load(&HSTRING::from(shortcut.as_os_str()), STGM_READ)?;
        let properties: IPropertyStore = link.cast()?;
        let id = BSTR::try_from(&properties.GetValue(&APP_ID_PROPERTY)?)?.to_string();
        if id != app_id {
            return Ok(false);
        }
        // GetPath with RAWPATH does not resolve a moved target or write back
        // Windows' link tracking data during an otherwise read-only check.
        let mut buffer = vec![0u16; 32768];
        link.GetPath(&mut buffer, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)?;
        if !same_path(&wide_text(&buffer), exe) {
            return Ok(false);
        }
        buffer.fill(0);
        link.GetArguments(&mut buffer)?;
        if buffer[0] != 0 {
            return Ok(false);
        }
        buffer.fill(0);
        let mut index = 0;
        link.GetIconLocation(&mut buffer, &mut index)?;
        Ok(index == 0 && same_path(&wide_text(&buffer), exe))
    }
}

/// Read first; only publish a shortcut when missing, damaged, or out of date.
/// Kept separate from the actual Start Menu location for non-invasive tests.
fn ensure_shortcut(shortcut: &Path, exe: &Path, app_id: &str) -> Result<bool, String> {
    if shortcut_matches(shortcut, exe, app_id).unwrap_or(false) {
        return Ok(false);
    }
    let existed = shortcut.try_exists().map_err(|e| e.to_string())?;
    let parent = shortcut.parent().ok_or("通知快捷方式路径无效")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    // Do not expose a partial .lnk to the Shell if writing is interrupted.
    let staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    unsafe {
        let link: IShellLinkW =
            CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
        let target = HSTRING::from(exe.as_os_str());
        link.SetPath(&target).map_err(|e| e.to_string())?;
        link.SetIconLocation(&target, 0)
            .map_err(|e| e.to_string())?;
        if let Some(directory) = exe.parent() {
            link.SetWorkingDirectory(&HSTRING::from(directory.as_os_str()))
                .map_err(|e| e.to_string())?;
        }
        let properties: IPropertyStore = link.cast().map_err(|e| e.to_string())?;
        properties
            .SetValue(&APP_ID_PROPERTY, &PROPVARIANT::from(app_id))
            .map_err(|e| e.to_string())?;
        properties.Commit().map_err(|e| e.to_string())?;
        let file: IPersistFile = link.cast().map_err(|e| e.to_string())?;
        file.Save(&HSTRING::from(staged.path().as_os_str()), true)
            .map_err(|e| e.to_string())?;
    }
    staged.persist(shortcut).map_err(|e| e.to_string())?;
    let path = HSTRING::from(shortcut.as_os_str());
    unsafe {
        SHChangeNotify(
            if existed {
                SHCNE_UPDATEITEM
            } else {
                SHCNE_CREATE
            },
            SHCNF_PATHW | SHCNF_FLUSH,
            Some(path.as_ptr().cast()),
            None,
        );
    }
    Ok(true)
}

pub enum DeliveryEvent {
    Failed(String),
    Dismissed,
    Activated,
}

struct Request {
    title: String,
    body: String,
    reply: mpsc::Sender<Result<(), String>>,
}

/// A long-lived MTA owns the notifications and their callbacks. Initializing
/// and tearing down an apartment around each Show can lose later Failed events.
pub struct NotificationService {
    requests: Option<mpsc::Sender<Request>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl NotificationService {
    pub fn start(
        app_id: String,
        report: impl Fn(DeliveryEvent) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        let (requests, receive) = mpsc::channel::<Request>();
        let report = Arc::new(report);
        let worker = std::thread::Builder::new()
            .name("desktop-notifications".into())
            .spawn(move || {
                let apartment = Apartment::new().map_err(|e| e.to_string());
                let mut pending = Vec::<PendingToast>::new();
                loop {
                    match receive.recv_timeout(Duration::from_secs(1)) {
                        Ok(request) => {
                            let result = match &apartment {
                                Ok(_) => {
                                    let report = report.clone();
                                    show(&app_id, &request.title, &request.body, move |event| {
                                        report(event)
                                    })
                                    .map(|toast| {
                                        if pending.len() >= 64 {
                                            pending.remove(0);
                                        }
                                        pending.push(toast);
                                    })
                                }
                                Err(error) => Err(error.clone()),
                            };
                            let _ = request.reply.send(result);
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                    pending.retain(PendingToast::is_pending);
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            requests: Some(requests),
            worker: Some(worker),
        })
    }

    pub fn submit(&self, title: &str, body: &str) -> Result<(), String> {
        let (reply, result) = mpsc::channel();
        self.requests
            .as_ref()
            .ok_or("通知线程已停止")?
            .send(Request {
                title: title.into(),
                body: body.into(),
                reply,
            })
            .map_err(|e| format!("通知线程不可用：{e}"))?;
        // Wait for the real WinRT submission result, not just queue acceptance.
        result
            .recv()
            .map_err(|e| format!("通知线程未返回结果：{e}"))?
    }
}

impl Drop for NotificationService {
    fn drop(&mut self) {
        self.requests.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub struct PendingToast {
    toast: ToastNotification,
    failed: i64,
    dismissed: i64,
    activated: i64,
    finished: Arc<AtomicBool>,
    created: Instant,
}

impl PendingToast {
    pub fn is_pending(&self) -> bool {
        !self.finished.load(Ordering::Relaxed) && self.created.elapsed() < Duration::from_secs(300)
    }
}

impl Drop for PendingToast {
    fn drop(&mut self) {
        let _ = self.toast.RemoveFailed(self.failed);
        let _ = self.toast.RemoveDismissed(self.dismissed);
        let _ = self.toast.RemoveActivated(self.activated);
    }
}

fn xml_text(value: &str) -> String {
    let mut result = String::new();
    for ch in value.chars() {
        match ch {
            '&' => result.push_str("&amp;"),
            '<' => result.push_str("&lt;"),
            '>' => result.push_str("&gt;"),
            '\t' | '\n' | '\r' => result.push(ch),
            '\u{0}'..='\u{1f}' | '\u{fffe}' | '\u{ffff}' => result.push('\u{fffd}'),
            _ => result.push(ch),
        }
    }
    result
}

fn notification_xml(title: &str, body: &str) -> WinResult<XmlDocument> {
    let document = XmlDocument::new()?;
    document.LoadXml(&HSTRING::from(format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        xml_text(title), xml_text(body),
    )))?;
    Ok(document)
}

pub fn show(
    app_id: &str,
    title: &str,
    body: &str,
    report: impl Fn(DeliveryEvent) + Send + Sync + 'static,
) -> Result<PendingToast, String> {
    let _apartment = Apartment::new().map_err(|e| e.to_string())?;
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))
        .map_err(|e| format!("创建 Windows 通知失败：{e}"))?;
    let setting = match notifier.Setting() {
        Ok(setting) => setting,
        // Windows has no settings row for a newly registered unpackaged app
        // before its first Show. This was reproduced with a fresh AUMID in the
        // live test. Show and its Failed event still report delivery errors.
        Err(error) if error.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0) => {
            NotificationSetting::Enabled
        }
        Err(error) => return Err(format!("读取 Windows 通知设置失败：{error}")),
    };
    if setting != NotificationSetting::Enabled {
        let reason = match setting {
            NotificationSetting::DisabledForApplication => "此应用的通知已关闭",
            NotificationSetting::DisabledForUser => "系统通知已关闭",
            NotificationSetting::DisabledByGroupPolicy => "通知已被系统策略禁用",
            NotificationSetting::DisabledByManifest => "应用通知身份不可用",
            _ => "系统不允许发送通知",
        };
        return Err(format!(
            "{reason}（Windows notification setting {}）",
            setting.0
        ));
    }
    let document = notification_xml(title, body).map_err(|e| e.to_string())?;
    let toast = ToastNotification::CreateToastNotification(&document).map_err(|e| e.to_string())?;
    let finished = Arc::new(AtomicBool::new(false));
    let report = Arc::new(report);
    let done = finished.clone();
    let handler = report.clone();
    let failed = toast
        .Failed(
            &TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(move |_, args| {
                done.store(true, Ordering::Relaxed);
                let detail = args
                    .as_ref()
                    .and_then(|args| args.ErrorCode().ok())
                    .map(|code| format!("Windows 拒绝通知：0x{:08X}", code.0 as u32))
                    .unwrap_or_else(|| "Windows 拒绝通知，未提供错误代码".into());
                handler(DeliveryEvent::Failed(detail));
                Ok(())
            }),
        )
        .map_err(|e| e.to_string())?;
    let done = finished.clone();
    let handler = report.clone();
    let dismissed = toast
        .Dismissed(&TypedEventHandler::<
            ToastNotification,
            ToastDismissedEventArgs,
        >::new(move |_, _| {
            done.store(true, Ordering::Relaxed);
            handler(DeliveryEvent::Dismissed);
            Ok(())
        }))
        .map_err(|e| e.to_string())?;
    let done = finished.clone();
    let activated = toast
        .Activated(&TypedEventHandler::new(move |_, _| {
            done.store(true, Ordering::Relaxed);
            report(DeliveryEvent::Activated);
            Ok(())
        }))
        .map_err(|e| e.to_string())?;
    let pending = PendingToast {
        toast,
        failed,
        dismissed,
        activated,
        finished,
        created: Instant::now(),
    };
    // Unlike tauri-plugin-notification 2.4, do not spawn and discard this result.
    notifier
        .Show(&pending.toast)
        .map_err(|e| format!("提交 Windows 通知失败：{e}"))?;
    Ok(pending)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_registration_repairs_without_rewriting_valid_files() {
        let _apartment = Apartment::new().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("首次启动 空格.exe");
        let moved = directory.path().join("移动后.exe");
        std::fs::write(&first, b"test executable").unwrap();
        std::fs::write(&moved, b"test executable").unwrap();
        let shortcut = directory.path().join("通知.lnk");
        let id = "com.deepseek.harness.notification-unit-test";

        assert!(ensure_shortcut(&shortcut, &first, id).unwrap());
        assert!(shortcut_matches(&shortcut, &first, id).unwrap());
        let earlier = std::time::SystemTime::now() - Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(&shortcut)
            .unwrap()
            .set_modified(earlier)
            .unwrap();
        let timestamp = std::fs::metadata(&shortcut).unwrap().modified().unwrap();
        let contents = std::fs::read(&shortcut).unwrap();
        assert!(!ensure_shortcut(&shortcut, &first, id).unwrap());
        assert_eq!(
            std::fs::metadata(&shortcut).unwrap().modified().unwrap(),
            timestamp
        );
        assert_eq!(std::fs::read(&shortcut).unwrap(), contents);

        assert!(ensure_shortcut(&shortcut, &moved, id).unwrap());
        assert!(shortcut_matches(&shortcut, &moved, id).unwrap());
        assert!(!ensure_shortcut(&shortcut, &moved, id).unwrap());
        assert!(ensure_shortcut(&shortcut, &moved, "different.id").unwrap());
        assert!(ensure_shortcut(&shortcut, &moved, id).unwrap());
        std::fs::write(&shortcut, b"damaged shortcut").unwrap();
        assert!(ensure_shortcut(&shortcut, &moved, id).unwrap());
        std::fs::remove_file(&shortcut).unwrap();
        assert!(ensure_shortcut(&shortcut, &moved, id).unwrap());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 3);
    }

    #[test]
    fn notification_text_is_valid_xml_and_never_injects_markup() {
        let _apartment = Apartment::new().unwrap();
        let document =
            notification_xml("<task> & \"完成\"", "x\0y\n</text><audio silent='true'/>").unwrap();
        let texts = document
            .GetElementsByTagName(&HSTRING::from("text"))
            .unwrap();
        assert_eq!(texts.Length().unwrap(), 2);
        assert_eq!(
            texts.Item(0).unwrap().InnerText().unwrap(),
            "<task> & \"完成\""
        );
        assert_eq!(
            texts.Item(1).unwrap().InnerText().unwrap(),
            "x\u{fffd}y\n</text><audio silent='true'/>"
        );
        assert_eq!(
            document
                .GetElementsByTagName(&HSTRING::from("audio"))
                .unwrap()
                .Length()
                .unwrap(),
            0
        );
    }

    #[test]
    #[ignore = "Sends a real Windows toast using an isolated temporary Start Menu registration"]
    fn live_windows_notification_reaches_history() {
        let _apartment = Apartment::new().unwrap();
        let directory = tempfile::Builder::new()
            .prefix("DeepseekHarness notification test-")
            .tempdir_in(programs_dir().unwrap())
            .unwrap();
        let id = format!("com.deepseek.harness.test.{}", uuid::Uuid::new_v4());
        let history = ToastNotificationManager::History().unwrap();
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                if let Ok(history) = ToastNotificationManager::History() {
                    let _ = history.ClearWithId(&HSTRING::from(&self.0));
                }
            }
        }
        let _cleanup = Cleanup(id.clone());
        let shortcut = directory.path().join("DeepseekHarness 通知测试.lnk");
        assert!(ensure_shortcut(&shortcut, &std::env::current_exe().unwrap(), &id).unwrap());
        let (events, receive) = mpsc::channel();
        let service = NotificationService::start(id.clone(), move |event| {
            let _ = events.send(event);
        })
        .unwrap();
        service
            .submit("DeepseekHarness 通知测试", "单文件版的通知注册与发送验证。")
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(DeliveryEvent::Failed(error)) = receive.try_recv() {
                panic!("{error}");
            }
            if history
                .GetHistoryWithId(&HSTRING::from(&id))
                .unwrap()
                .Size()
                .unwrap()
                > 0
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Windows accepted Show but no notification reached history"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        println!("Windows notification reached Action Center using a newly registered identity");
    }

    #[test]
    #[ignore = "Checks real Windows rejection of an invalid notification identity"]
    fn live_windows_notification_reports_rejection() {
        let id = String::new();
        let (events, receive) = mpsc::channel();
        let service = NotificationService::start(id, move |event| {
            let _ = events.send(event);
        })
        .unwrap();
        match service.submit(
            "DeepseekHarness notification failure test",
            "Unregistered identity",
        ) {
            Err(error) => assert!(!error.is_empty()),
            Ok(()) => match receive.recv_timeout(Duration::from_secs(5)) {
                Ok(DeliveryEvent::Failed(error)) => assert!(!error.is_empty()),
                _ => panic!("An invalid identity must report its Windows delivery error"),
            },
        }
    }
}
