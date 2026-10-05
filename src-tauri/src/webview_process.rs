//! Observe only this WebView2 environment. Never suspend or terminate processes.
//! COM references stay inside `with_webview`; the worker retains kernel handles.

#[cfg(windows)]
mod platform {
    use std::collections::{HashMap, HashSet};
    use std::time::{Duration, Instant};
    use tauri::WebviewWindow;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment8;
    use windows::core::Interface;
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    };

    struct Process {
        handle: HANDLE,
        pid: u32,
        created: u64,
    }
    // Owned process handles are process-wide, immutable, and closed exactly once.
    unsafe impl Send for Process {}
    impl Drop for Process {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
    impl Process {
        fn open(pid: u32) -> Result<Self, String> {
            unsafe {
                let handle = OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    false,
                    pid,
                )
                .map_err(|e| format!("process-open:{pid}:{e}"))?;
                let mut process = Self {
                    handle,
                    pid,
                    created: 0,
                };
                let (mut created, mut exited, mut kernel, mut user) = (
                    FILETIME::default(),
                    FILETIME::default(),
                    FILETIME::default(),
                    FILETIME::default(),
                );
                GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user)
                    .map_err(|e| format!("process-time:{pid}:{e}"))?;
                process.created =
                    ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
                Ok(process)
            }
        }
        fn exited(&self) -> bool {
            unsafe { WaitForSingleObject(self.handle, 0) == WAIT_OBJECT_0 }
        }
    }

    fn parents() -> Result<HashMap<u32, u32>, String> {
        unsafe {
            let snapshot =
                CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(|e| e.to_string())?;
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut entries = HashMap::new();
            let mut next = Process32FirstW(snapshot, &mut entry);
            while next.is_ok() {
                entries.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                next = Process32NextW(snapshot, &mut entry);
            }
            let _ = CloseHandle(snapshot);
            Ok(entries)
        }
    }

    pub struct ProcessSet {
        browser: u32,
        processes: Vec<Process>,
    }

    impl ProcessSet {
        /// Must run on a worker: the short COM query is dispatched to the UI thread.
        pub fn capture(window: &WebviewWindow) -> Result<Self, String> {
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            window
                .with_webview(move |webview| {
                    let result = (|| -> Result<(u32, Vec<u32>), String> {
                        unsafe {
                            let core = webview
                                .controller()
                                .CoreWebView2()
                                .map_err(|e| e.to_string())?;
                            let mut browser = 0;
                            core.BrowserProcessId(&mut browser)
                                .map_err(|e| e.to_string())?;
                            let environment = webview
                                .environment()
                                .cast::<ICoreWebView2Environment8>()
                                .map_err(|e| e.to_string())?;
                            let infos = environment.GetProcessInfos().map_err(|e| e.to_string())?;
                            let mut count = 0;
                            infos.Count(&mut count).map_err(|e| e.to_string())?;
                            let mut pids = vec![browser];
                            for i in 0..count {
                                let mut pid = 0;
                                infos
                                    .GetValueAtIndex(i)
                                    .and_then(|info| info.ProcessId(&mut pid))
                                    .map_err(|e| e.to_string())?;
                                if pid > 0 {
                                    pids.push(pid as u32);
                                }
                            }
                            pids.sort_unstable();
                            pids.dedup();
                            Ok((browser, pids))
                        }
                    })();
                    let _ = tx.send(result);
                })
                .map_err(|e| e.to_string())?;
            let (browser, pids) = rx
                .recv_timeout(Duration::from_secs(2))
                .map_err(|_| "process-query-timeout".to_string())??;
            let tree = parents()?;
            if tree.get(&browser) != Some(&std::process::id()) {
                return Err("process-browser-not-owned".into());
            }
            let mut result = Self {
                browser,
                processes: vec![Process::open(browser)?],
            };
            for pid in pids {
                if pid == browser {
                    continue;
                }
                if !descends_from(pid, browser, &tree) {
                    return Err("process-environment-shared".into());
                }
                match Process::open(pid) {
                    Ok(process) => result.processes.push(process),
                    Err(error) if parents()?.contains_key(&pid) => return Err(error),
                    Err(_) => {} // It exited between enumeration and opening the handle.
                }
            }
            result.discover_children()?;
            for process in &result.processes {
                crate::debug_log(&format!(
                    "[webview-process] browser={} pid={} created={}",
                    result.browser, process.pid, process.created
                ));
            }
            Ok(result)
        }

        fn discover_children(&mut self) -> Result<(), String> {
            let tree = parents()?;
            let browser = &self.processes[0];
            if browser.exited() && tree.contains_key(&self.browser) {
                if let Ok(current) = Process::open(self.browser) {
                    if current.created != browser.created {
                        return Err("process-browser-pid-reused".into());
                    }
                }
            }
            let created = browser.created;
            let known: HashSet<_> = self.processes.iter().map(|p| p.pid).collect();
            for pid in tree.keys().copied() {
                if known.contains(&pid) || !descends_from(pid, self.browser, &tree) {
                    continue;
                }
                match Process::open(pid) {
                    Ok(process) if process.created >= created => self.processes.push(process),
                    Ok(_) => return Err("process-child-predates-browser".into()),
                    Err(error) if parents()?.contains_key(&pid) => return Err(error),
                    Err(_) => {}
                }
            }
            Ok(())
        }

        pub fn wait_for_exit(mut self, timeout: Duration) -> Result<(), String> {
            let started = Instant::now();
            loop {
                self.discover_children()?;
                if self.processes.iter().all(Process::exited) {
                    crate::debug_log(&format!(
                        "[webview-process] browser={} exited={} elapsed_ms={}",
                        self.browser,
                        self.processes.len(),
                        started.elapsed().as_millis()
                    ));
                    return Ok(());
                }
                if started.elapsed() >= timeout {
                    return Err("process-exit-timeout".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }

    fn descends_from(mut pid: u32, root: u32, tree: &HashMap<u32, u32>) -> bool {
        let mut visited = HashSet::new();
        while visited.insert(pid) {
            if pid == root {
                return true;
            }
            let Some(parent) = tree.get(&pid) else {
                return false;
            };
            pid = *parent;
        }
        false
    }
}

#[cfg(windows)]
pub use platform::ProcessSet;

#[cfg(not(windows))]
pub struct ProcessSet;
#[cfg(not(windows))]
impl ProcessSet {
    pub fn capture(_: &tauri::WebviewWindow) -> Result<Self, String> {
        Err("process-observer-windows-only".into())
    }
    pub fn wait_for_exit(self, _: std::time::Duration) -> Result<(), String> {
        Err("process-observer-windows-only".into())
    }
}
