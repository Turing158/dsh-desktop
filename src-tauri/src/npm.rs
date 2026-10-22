//! Install into a host-owned isolated prefix. The recovery command shares
//! the same arguments and never reconciles the system npm prefix.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;

use crate::dsh::CommandExt;

pub const INSTALL_SPEC: &str = "@deepseek-ai/dsh@latest";

pub fn install_argv(prefix: &Path) -> Vec<String> {
    vec!["install".into(), "--global".into(), "--prefix".into(), prefix.to_string_lossy().into_owned(),
        INSTALL_SPEC.into(), "--no-audit".into(), "--no-fund".into(), "--loglevel=info".into()]
}

/// Exact candidate versions never resolve a moving tag after the user's check.
pub fn candidate_argv(prefix: &Path, version: &str) -> Result<Vec<String>,String> {
    if version.len()>64 || version.starts_with('v') || semver::Version::parse(version).is_err() {return Err("runtime-candidate-version-invalid".into());}
    let mut args=install_argv(prefix);
    args[4]=format!("@deepseek-ai/dsh@{version}");
    args.extend(["--cache".into(),prefix.join("npm-cache").to_string_lossy().into_owned()]);
    args.push("--fetch-retries=0".into());
    Ok(args)
}

/// PowerShell command: single quotes prevent interpolation of unusual paths.
pub fn install_command(prefix: &Path) -> String {
    format!("npm install --global --prefix '{}' {INSTALL_SPEC}", prefix.to_string_lossy().replace("'", "''"))
}

/// A line of install progress streamed to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct InstallProgress {
    pub line: String,
    /// `true` for the final message, so the UI can stop its spinner.
    pub done: bool,
    pub ok: bool,
}

/// Locate npm's CLI script next to a `node` executable.
///
/// Running `npm-cli.js` through `node` avoids the `.cmd` shim entirely: no shell
/// is involved, so arguments need no quoting and no console window appears.
pub fn npm_cli_for(node_exe: &Path) -> Option<PathBuf> {
    let dir = node_exe.parent()?;
    let candidates = [
        dir.join("node_modules").join("npm").join("bin").join("npm-cli.js"),
        // A shim-managed layout keeps npm beside the shared global prefix.
        dir.join("..").join("npm").join("node_modules").join("npm").join("bin").join("npm-cli.js"),
    ];
    candidates.into_iter().find(|path| path.is_file())
}

/// A handle that can stop a running install from another thread.
///
/// The `Installer` itself owns the child and must stay on the thread that waits
/// for it — that wait is the startup sequence's single owner. Cancellation
/// arrives from the UI thread instead (the button, or the window closing), so it
/// carries only the pid and the shared flag: nothing here owns the process, and
/// killing a pid that has already exited is a harmless error.
#[derive(Clone)]
pub struct InstallHandle {
    pid: u32,
    cancelled: Arc<Mutex<bool>>,
}

impl InstallHandle {
    /// Ask the install to stop. Idempotent.
    pub fn cancel(&self) {
        if let Ok(mut flag) = self.cancelled.lock() {
            *flag = true;
        }
        let _ = crate::winjob::terminate(self.pid);
    }
}

/// A running install, so the UI can stream progress and cancel it.
pub struct Installer {
    child: Child,
    /// Kills npm — and anything npm spawns — if the installer is dropped.
    ///
    /// A global install rewrites the shared prefix, so leaving one running after
    /// the window closed would mutate the user's global packages with nothing on
    /// screen to explain it. The job makes that impossible: dropping the installer
    /// (on cancel, on a failed start, on app exit) tears the tree down.
    _job: crate::winjob::JobObject,
    /// Handed to its single consumer by [`Installer::take_events`].
    events: Option<Receiver<InstallProgress>>,
    cancelled: Arc<Mutex<bool>>,
}

impl Installer {
    /// Start the automatic install into an isolated managed prefix.
    ///
    /// The command is [`install_argv`], run through `node <npm-cli.js>` rather
    /// than the `npm.cmd` shim: no shell is involved, so arguments need no
    /// quoting and no console window appears.
    pub fn start(node_exe: &Path, prefix: &Path) -> Result<Self, String> {
        Self::start_with_args(node_exe, &install_argv(prefix))
    }

    /// Use the caller's fixed package arguments for an explicit channel update.
    pub(crate) fn start_with_args(node_exe: &Path, args: &[String]) -> Result<Self, String> {
        Self::start_with_context(node_exe,args,None)
    }

    pub(crate) fn start_candidate(node_exe:&Path,prefix:&Path,version:&str)->Result<Self,String> {
        Self::start_with_context(node_exe,&candidate_argv(prefix,version)?,Some(prefix))
    }

    fn start_with_context(node_exe:&Path,args:&[String],candidate:Option<&Path>)->Result<Self,String> {
        let npm_cli = npm_cli_for(node_exe).ok_or_else(|| "未找到 npm".to_string())?;

        // Created before the spawn so the child can be adopted the moment it
        // exists; a job that failed to be created must not become an install
        // nothing can cancel.
        let job = crate::winjob::JobObject::new()
            .map_err(|error| format!("无法创建进程作业对象：{error}"))?;

        let mut command=Command::new(node_exe);
        if let Some(prefix)=candidate {
            command.current_dir(prefix).env("DSH_HOME",prefix.join("probe-home"))
                .env("NARB_NATIVE_CACHE_DIR",prefix.join("native-cache"))
                .env_remove("DSH_DESKTOP_DSH_BIN");
        }
        let mut child = command.arg(&npm_cli)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags_no_window()
            .spawn()
            .map_err(|error| format!("无法启动 npm：{error}"))?;

        // Adopt npm immediately: anything it spawns afterwards inherits job
        // membership, so the whole tree dies with this app.
        let assigned = crate::winjob::open_for_job(child.id()).and_then(|handle| {
            let result = job.assign(handle);
            unsafe { windows::Win32::Foundation::CloseHandle(handle) }.ok();
            result
        });
        if let Err(error) = assigned {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("无法接管 npm 进程：{error}"));
        }

        let (sender, events) = mpsc::channel();
        if let Some(stdout) = child.stdout.take() {
            spawn_progress_reader(stdout, sender.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_progress_reader(stderr, sender);
        }

        Ok(Self {
            child,
            _job: job,
            events: Some(events),
            cancelled: Arc::new(Mutex::new(false)),
        })
    }

    /// Take ownership of the progress stream.
    pub fn take_events(&mut self) -> Option<Receiver<InstallProgress>> {
        self.events.take()
    }

    /// A handle the UI thread can use to stop this install.
    pub fn handle(&self) -> InstallHandle {
        InstallHandle {
            pid: self.child.id(),
            cancelled: Arc::clone(&self.cancelled),
        }
    }

    /// Wait for the install to finish, returning whether it succeeded.
    ///
    /// Takes `&mut self` rather than consuming it so the caller keeps ownership
    /// of the job object until it has read the outcome: dropping it first would
    /// kill npm before this wait could observe a normal exit.
    pub fn wait(&mut self) -> Result<bool, String> {
        let status = self
            .child
            .wait()
            .map_err(|error| format!("等待 npm 结束失败：{error}"))?;
        let cancelled = self.cancelled.lock().map(|flag| *flag).unwrap_or(false);
        if cancelled {
            return Err("安装已取消".to_string());
        }
        Ok(status.success())
    }

    /// Keep cancellation and a stalled registry bounded during preparation.
    pub fn wait_timeout(&mut self, timeout: std::time::Duration) -> Result<bool,String> {
        let deadline=std::time::Instant::now()+timeout;
        loop {
            if self.cancelled.lock().map(|flag|*flag).unwrap_or(true) {
                self._job.terminate();let _=self.child.kill();let _=self.child.wait();
                return Err("runtime-candidate-cancelled".into());
            }
            if let Some(status)=self.child.try_wait().map_err(|_|"runtime-candidate-install-failed")? {return Ok(status.success());}
            if std::time::Instant::now()>=deadline {
                self._job.terminate();let _=self.child.kill();let _=self.child.wait();
                return Err("runtime-candidate-install-timeout".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
}

impl Drop for Installer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Forward npm output lines as progress events.
fn spawn_progress_reader(reader: impl std::io::Read + Send + 'static, sender: Sender<InstallProgress>) {
    thread::spawn(move || {
        let buffered = BufReader::new(reader);
        for line in buffered.lines() {
            let Ok(line) = line else { break };
            let line = line.trim_end().to_string();
            if line.is_empty() {
                continue;
            }
            // npm's progress output uses carriage returns to redraw a bar;
            // keeping only the final segment per line avoids a garbled log.
            let text = line.rsplit('\r').next().unwrap_or(&line).trim().to_string();
            if text.is_empty() {
                continue;
            }
            if sender
                .send(InstallProgress {
                    line: text,
                    done: false,
                    ok: true,
                })
                .is_err()
            {
                break;
            }
        }
    });
}

/// Verify the exact install destination, without rediscovering a PATH copy.
pub fn verify_install(node_exe: &Path, prefix: &Path) -> Result<String, String> {
    let bin = prefix.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
    if !bin.is_file() { return Err(format!("安装后未找到 {}", bin.display())); }
    crate::dsh::probe_version(node_exe, &bin).ok_or_else(|| "安装后的 dsh 无法报告版本号".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn install_only_targets_the_owned_prefix_and_keeps_peers_enabled() {
        let prefix=Path::new("C:/isolated runtime");
        assert_eq!(install_argv(prefix), vec!["install","--global","--prefix","C:/isolated runtime",INSTALL_SPEC,"--no-audit","--no-fund","--loglevel=info"]);
    }
    #[test]
    fn displayed_command_uses_the_same_prefix_without_shell_interpolation() {
        let prefix=Path::new("C:/DSH user's $runtime");
        assert_eq!(install_command(prefix), "npm install --global --prefix 'C:/DSH user''s $runtime' @deepseek-ai/dsh@latest");
        assert_eq!(install_argv(prefix)[3],prefix.to_string_lossy());
    }
    #[test]
    fn candidate_installs_pin_an_exact_version_in_the_owned_prefix() {
        let prefix=Path::new("C:/isolated candidate");
        let args=candidate_argv(prefix,"0.2.1-rc.2").unwrap();
        assert_eq!(args[3],prefix.to_string_lossy());assert_eq!(args[4],"@deepseek-ai/dsh@0.2.1-rc.2");
        for version in ["latest","next","^1.0.0","v1.0.0","1.0.0 --force","https://example.org/package.tgz",""] {
            assert!(candidate_argv(prefix,version).is_err());
        }
    }
}
