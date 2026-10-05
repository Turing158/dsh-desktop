//! ConPTY with suspended creation: no shell instruction runs before job adoption.
use std::{fs::File, io, mem::size_of, os::windows::io::{FromRawHandle, OwnedHandle}, path::Path, sync::Mutex};
use windows::{core::{PCWSTR, PWSTR}, Win32::{Foundation::{HANDLE, WAIT_OBJECT_0}, System::{Console::*, Pipes::CreatePipe, Threading::*}}};
use crate::winjob::JobObject;

fn error(e: windows::core::Error) -> io::Error { io::Error::other(e.to_string()) }
fn wide(s: &std::ffi::OsStr) -> Vec<u16> { use std::os::windows::ffi::OsStrExt; s.encode_wide().chain(Some(0)).collect() }
fn pipe() -> io::Result<(File, File)> {
    unsafe {
        let (mut read, mut write) = (HANDLE::default(), HANDLE::default());
        CreatePipe(&mut read, &mut write, None, 65536).map_err(error)?;
        Ok((File::from_raw_handle(read.0), File::from_raw_handle(write.0)))
    }
}
struct Console(HPCON);
unsafe impl Send for Console {}
impl Drop for Console { fn drop(&mut self) { unsafe { ClosePseudoConsole(self.0); } } }
struct Attributes { pointer: LPPROC_THREAD_ATTRIBUTE_LIST, _buffer: Vec<usize> }
impl Drop for Attributes { fn drop(&mut self) { unsafe { DeleteProcThreadAttributeList(self.pointer); } } }

pub struct Pty {
    console: Mutex<Option<Console>>,
    job: JobObject,
    process: OwnedHandle,
}
impl Pty {
    pub fn spawn(program: &Path, args: &str, cwd: &Path, cols: u16, rows: u16) -> io::Result<(Self, File, File)> {
        use std::os::windows::io::AsRawHandle;
        let job = JobObject::new()?;
        let (input_read, input_write) = pipe()?;
        let (output_read, output_write) = pipe()?;
        unsafe {
            let console = Console(CreatePseudoConsole(COORD { X: cols as i16, Y: rows as i16 }, HANDLE(input_read.as_raw_handle()), HANDLE(output_write.as_raw_handle()), 0).map_err(error)?);
            let mut bytes = 0;
            let _ = InitializeProcThreadAttributeList(None, 1, None, &mut bytes);
            let mut buffer = vec![0usize; bytes.div_ceil(size_of::<usize>())];
            let pointer = LPPROC_THREAD_ATTRIBUTE_LIST(buffer.as_mut_ptr().cast());
            InitializeProcThreadAttributeList(Some(pointer), 1, None, &mut bytes).map_err(error)?;
            let attributes = Attributes { pointer, _buffer: buffer };
            UpdateProcThreadAttribute(attributes.pointer, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize, Some(console.0.0 as *const _), size_of::<HPCON>(), None, None).map_err(error)?;
            let mut startup = STARTUPINFOEXW::default();
            startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.lpAttributeList = attributes.pointer;
            let program_text = program.to_string_lossy().replace('/', "\\");
            let application = wide(std::ffi::OsStr::new(&program_text));
            // The program is a discovered absolute .exe; arguments are fixed profile data.
            let mut command = wide(std::ffi::OsStr::new(&format!("\"{}\" {}", program_text, args)));
            let cwd = wide(cwd.as_os_str());
            let mut info = PROCESS_INFORMATION::default();
            CreateProcessW(PCWSTR(application.as_ptr()), Some(PWSTR(command.as_mut_ptr())), None, None, false, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, None, PCWSTR(cwd.as_ptr()), &startup.StartupInfo, &mut info).map_err(error)?;
            let process = OwnedHandle::from_raw_handle(info.hProcess.0);
            let _thread = OwnedHandle::from_raw_handle(info.hThread.0);
            if let Err(e) = job.assign(info.hProcess) {
                let _ = TerminateProcess(info.hProcess, 1);
                return Err(e);
            }
            if ResumeThread(info.hThread) == u32::MAX {
                job.terminate();
                return Err(io::Error::last_os_error());
            }
            // Parent copies must not hold the pipe open after ConPTY exits.
            drop(input_read); drop(output_write);
            Ok((Self { console: Mutex::new(Some(console)), job, process }, output_read, input_write))
        }
    }
    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let guard = self.console.lock().unwrap();
        let console = guard.as_ref().ok_or_else(|| io::Error::other("closed"))?;
        unsafe { ResizePseudoConsole(console.0, COORD { X: cols as i16, Y: rows as i16 }).map_err(error) }
    }
    pub fn exit_code(&self) -> Option<u32> {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            let handle = HANDLE(self.process.as_raw_handle());
            if WaitForSingleObject(handle, 0) != WAIT_OBJECT_0 { return None; }
            let mut code = 0;
            GetExitCodeProcess(handle, &mut code).ok()?;
            Some(code)
        }
    }
    pub fn terminate(&self) { self.job.terminate(); }
    /// Run off the UI thread, while the output reader continues draining.
    pub fn finish(&self) { self.job.terminate(); self.console.lock().unwrap().take(); }
}
impl Drop for Pty { fn drop(&mut self) { self.job.terminate(); } }
