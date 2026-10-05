//! Windows Job Object ownership for the DSH child process tree.
//!
//! `dsh web` is not a single process: it spawns `pwsh` for shell tools, MCP
//! servers, and worker threads. Killing only the direct child would leave all of
//! them running. Assigning the child to a Job Object configured with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` makes Windows tear down the entire tree
//! when the job handle closes — which happens on normal exit, on a panic, and
//! when the app is force-killed.

#![cfg(windows)]

use std::io;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// Owns a job object for the lifetime of the app; dropping it kills the tree.
pub struct JobObject {
    handle: HANDLE,
}

// The handle is an owned kernel handle with process-wide validity; transferring
// it between threads is safe, and we only ever close it in `Drop`.
unsafe impl Send for JobObject {}
unsafe impl Sync for JobObject {}

impl JobObject {
    /// TerminateJobObject is asynchronous; fixed-port restarts wait for every
    /// member to exit, including the process that owns the listening socket.
    pub fn wait_empty(&self, timeout: std::time::Duration) -> io::Result<()> {
        use windows::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, QueryInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        };
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            unsafe {
                QueryInformationJobObject(
                    Some(self.handle),
                    JobObjectBasicAccountingInformation,
                    std::ptr::addr_of_mut!(info).cast(),
                    std::mem::size_of_val(&info) as u32,
                    None,
                )
            }
            .map_err(io::Error::other)?;
            if info.ActiveProcesses == 0 {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "DSH 进程树未完全退出",
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
    /// Stop this tree without waiting for owners of pipe handles to finish.
    pub fn terminate(&self) {
        unsafe {
            let _ = windows::Win32::System::JobObjects::TerminateJobObject(self.handle, 1);
        }
    }
    /// Create a job object that kills every member when its last handle closes.
    pub fn new() -> io::Result<Self> {
        unsafe {
            let handle = CreateJobObjectW(None, None).map_err(|error| {
                io::Error::new(
                    io::ErrorKind::Other,
                    format!("CreateJobObjectW failed: {error}"),
                )
            })?;

            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            let result = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );

            if let Err(error) = result {
                let _ = CloseHandle(handle);
                return Err(io::Error::new(
                    io::ErrorKind::Other,
                    format!("SetInformationJobObject failed: {error}"),
                ));
            }

            Ok(Self { handle })
        }
    }

    /// Adopt a process and all of its future descendants into this job.
    ///
    /// The process must already be created (but may still be starting); a
    /// process that has already spawned children of its own before this call
    /// would leave those outside the job, so the host assigns immediately after
    /// spawn.
    pub fn assign(&self, process: HANDLE) -> io::Result<()> {
        unsafe {
            AssignProcessToJobObject(self.handle, process).map_err(|error| {
                io::Error::new(
                    io::ErrorKind::Other,
                    format!("AssignProcessToJobObject failed: {error}"),
                )
            })
        }
    }
}

impl Drop for JobObject {
    fn drop(&mut self) {
        // Closing the handle is what triggers KILL_ON_JOB_CLOSE, which is why
        // the app keeps this object alive for its whole lifetime.
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

/// Open a process with the access right required by `AssignProcessToJobObject`.
///
/// `std::process::Child` does not expose its raw handle on stable Rust, so the
/// host re-opens the child by PID. `PROCESS_SET_QUOTA` and `PROCESS_TERMINATE`
/// are the rights the assignment requires.
pub fn open_for_job(pid: u32) -> io::Result<HANDLE> {
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    unsafe {
        OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid).map_err(|error| {
            io::Error::new(
                io::ErrorKind::Other,
                format!("OpenProcess({pid}) failed: {error}"),
            )
        })
    }
}

/// Terminate a process by id, for a stop request that arrives on another thread.
///
/// The same PID-based route as [`open_for_job`], and for the same reason: the
/// process is owned by a `std::process::Child` on a thread that is not the one
/// asking. Killing the job's root is enough — the job object takes the
/// descendants with it when the handle closes.
pub fn terminate(pid: u32) -> io::Result<()> {
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, false, pid).map_err(|error| {
            io::Error::new(
                io::ErrorKind::Other,
                format!("OpenProcess({pid}) failed: {error}"),
            )
        })?;
        let result = TerminateProcess(handle, 1);
        let _ = CloseHandle(handle);
        result.map_err(|error| {
            io::Error::new(
                io::ErrorKind::Other,
                format!("TerminateProcess({pid}) failed: {error}"),
            )
        })
    }
}
