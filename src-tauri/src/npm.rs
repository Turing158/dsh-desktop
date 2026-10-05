//! Querying published `dsh` versions and installing one.
//!
//! Two design points, both learned from probing the real npm on this machine:
//!
//! * **The install is global, and the command is fixed.**
//!   `npm install -g @deepseek-ai/dsh --legacy-peer-deps` is what the app runs
//!   when no `dsh` is found, so a machine with none ends up with one on `PATH`
//!   that the user can also run from a terminal. The package set is measured
//!   rather than the whole registry: [`install_argv`] is pinned by a test, so the
//!   command cannot drift from the one the failure screen tells the user to run.
//!
//!   This deliberately gives up what the previous private-prefix install bought.
//!   npm reconciles the *entire* global prefix on a global install — a dry run on
//!   the author's machine reported `removed 24 packages, and changed 494` — so
//!   packages other than dsh are re-resolved as a side effect. That was the reason
//!   the private prefix existed; it is now an accepted cost of the app installing
//!   to the same place the user would.
//!
//! * **There is no stable release.** Every published version carries an
//!   `-rc`/`-alpha` suffix, so "latest" is itself a pre-release. `latest` is the
//!   dist-tag to install, and the failure screen names the command rather than
//!   claiming a version.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;

use crate::dsh::CommandExt;

/// The package spec the app installs — global, and always the `latest` dist-tag.
pub const INSTALL_SPEC: &str = "@deepseek-ai/dsh@latest";

/// `--legacy-peer-deps`, because DSH's dependency graph does not satisfy npm's
/// peer-dependency resolution.
///
/// This is part of the command the failure screen tells the user to run, not an
/// implementation detail: the two must be the same string, which is why the
/// button's command and the displayed one both come from [`install_command`].
pub const LEGACY_PEER_DEPS: &str = "--legacy-peer-deps";

/// The npm arguments for the automatic global install, after the entry script.
///
/// Returned rather than inlined at the spawn site so a test can pin the exact
/// command: it is user-visible text on the failure screen, so a silent change to
/// it would make the instructions wrong.
pub fn install_argv() -> Vec<String> {
    [
        "install",
        "-g",
        INSTALL_SPEC,
        LEGACY_PEER_DEPS,
        "--no-audit",
        "--no-fund",
        "--loglevel=info",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

/// The command as the user would type it, for the failure screen and the clipboard.
pub fn install_command() -> String {
    format!("npm install -g {INSTALL_SPEC} {LEGACY_PEER_DEPS}")
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
    /// Start the automatic global install of `dsh`.
    ///
    /// The command is [`install_argv`], run through `node <npm-cli.js>` rather
    /// than the `npm.cmd` shim: no shell is involved, so arguments need no
    /// quoting and no console window appears.
    pub fn start(node_exe: &Path) -> Result<Self, String> {
        Self::start_with_args(node_exe, &install_argv())
    }

    /// Use the caller's fixed package arguments for an explicit channel update.
    pub(crate) fn start_with_args(node_exe: &Path, args: &[String]) -> Result<Self, String> {
        let npm_cli = npm_cli_for(node_exe).ok_or_else(|| "未找到 npm".to_string())?;

        // Created before the spawn so the child can be adopted the moment it
        // exists; a job that failed to be created must not become an install
        // nothing can cancel.
        let job = crate::winjob::JobObject::new()
            .map_err(|error| format!("无法创建进程作业对象：{error}"))?;

        let mut child = Command::new(node_exe)
            .arg(&npm_cli)
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

/// Verify a global install landed where expected and can actually be executed.
///
/// A directory check alone is not enough: npm can exit successfully while a
/// native dependency failed to build, and the resulting `dsh` would fail at
/// boot. Running `--version` is the cheapest end-to-end proof.
///
/// The location is resolved the same way the app resolves `dsh` at startup
/// ([`crate::dsh::global_dsh_bin`]) rather than by re-deriving npm's prefix
/// layout, so "the install worked" and "the app can find it" cannot disagree.
pub fn verify_install(node_exe: &Path) -> Result<String, String> {
    let bin = crate::dsh::global_dsh_bin()
        .ok_or_else(|| "无法确定全局 npm 安装目录".to_string())?;

    if !bin.is_file() {
        return Err(format!("安装后未找到 {}", bin.display()));
    }

    crate::dsh::probe_version(node_exe, &bin).ok_or_else(|| {
        format!(
            "安装后的 dsh 无法在 {} 秒内报告版本号，可能原生依赖未构建成功",
            crate::dsh::VERSION_PROBE_TIMEOUT.as_secs()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_globally_with_legacy_peer_deps() {
        // Pinned because this is the command the app runs AND the command the
        // failure screen tells the user to run; the two must not drift.
        assert_eq!(
            install_argv(),
            vec![
                "install",
                "-g",
                "@deepseek-ai/dsh@latest",
                "--legacy-peer-deps",
                "--no-audit",
                "--no-fund",
                "--loglevel=info",
            ]
        );
    }

    #[test]
    fn the_displayed_command_matches_the_one_that_runs() {
        let displayed = install_command();
        assert_eq!(displayed, "npm install -g @deepseek-ai/dsh@latest --legacy-peer-deps");

        // Everything the user is told to type must also be in the argv, minus the
        // two tokens that name npm itself.
        for token in displayed.split_whitespace().skip(1) {
            assert!(
                install_argv().iter().any(|arg| arg == token),
                "`{token}` is shown to the user but is not part of the argv that runs"
            );
        }
    }

    #[test]
    fn the_install_is_never_scoped_to_a_private_prefix() {
        // `--prefix` would install somewhere the app's own resolver never looks,
        // which is exactly the state this changed to get out of.
        assert!(!install_argv().iter().any(|arg| arg == "--prefix"));
    }

}
