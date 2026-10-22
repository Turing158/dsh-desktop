//! Hold the upstream profile writer lock across a native restore transaction.
//! Reuse its implementation, including exited-holder takeover, rather than
//! implementing a second incompatible filesystem lock protocol in Rust.
use std::{io::{BufRead,BufReader,Write},path::{Path,PathBuf},process::{Child,ChildStdin,Command,Stdio},sync::mpsc,time::Duration};
use crate::dsh::Runtime;

pub(super) struct ProfileLease {
    child:Child, input:Option<ChildStdin>, job:crate::winjob::JobObject,
    _request:tempfile::TempDir,
}
impl ProfileLease {
    pub fn acquire(runtime:&Runtime,helper:&Path,profile:&Path)->Result<Self,String> {
        use std::os::windows::process::CommandExt;
        let request=tempfile::tempdir().map_err(|_|"backup-profile-unavailable")?;
        let file=request.path().join("lock.json");
        crate::maintenance::atomic_json(&file,&serde_json::json!({"mode":"profile-lock","profileDirectory":profile})).map_err(|_|"backup-profile-unavailable")?;
        let job=crate::winjob::JobObject::new().map_err(|_|"backup-profile-unavailable")?;
        let mut child=Command::new(&runtime.node_exe).arg(crate::dsh::node_script_path(helper)).arg(crate::dsh::node_script_path(&file))
            .env("DSH_DESKTOP_DSH_BIN",&runtime.dsh_bin).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .creation_flags(0x08000000).spawn().map_err(|_|"backup-profile-unavailable")?;
        let assigned=crate::winjob::open_for_job(child.id()).and_then(|handle| {
            let result=job.assign(handle);unsafe {windows::Win32::Foundation::CloseHandle(handle)}.ok();result
        });
        if assigned.is_err() {let _=child.kill();let _=child.wait();return Err("backup-profile-unavailable".into())}
        let input=child.stdin.take();let output=child.stdout.take().ok_or("backup-profile-unavailable")?;
        let mut lease=Self {child,input,job,_request:request};
        let (send,receive)=mpsc::channel();
        std::thread::spawn(move || {
            let mut line=String::new();let result=BufReader::new(output).read_line(&mut line);
            let _=send.send(result.is_ok()&&line=="profile-locked\n");
        });
        if receive.recv_timeout(Duration::from_secs(15))!=Ok(true) {return Err("backup-profile-locked".into())}
        lease.ensure()?;Ok(lease)
    }
    pub fn ensure(&mut self)->Result<(),String> {
        if self.child.try_wait().map_err(|_|"backup-profile-lock-lost")?.is_some() {return Err("backup-profile-lock-lost".into())}
        Ok(())
    }
}
impl Drop for ProfileLease {
    fn drop(&mut self) {
        if let Some(mut input)=self.input.take() {let _=input.write_all(b"release\n");}
        let deadline=std::time::Instant::now()+Duration::from_secs(2);
        while std::time::Instant::now()<deadline {
            if matches!(self.child.try_wait(),Ok(Some(_))) {return}
            std::thread::sleep(Duration::from_millis(20));
        }
        self.job.terminate();let _=self.child.kill();let _=self.child.wait();
    }
}

pub(super) fn manifest(profile:&Path)->PathBuf {profile.join("package.json")}
