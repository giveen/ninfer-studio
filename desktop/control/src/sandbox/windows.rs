// Rust guideline compliant 2026-07-28

//! Windows sandbox: Job Object + Mandatory Integrity Control (MIC).
//!
//! Containment model (the "codex" one):
//!
//! * The child is created at **low integrity** (`S-1-16-4`) via
//!   `PROC_THREAD_ATTRIBUTE_MANDATORY_LABEL`. The integrity policy then
//!   refuses that child's writes to **medium**-integrity objects host-wide —
//!   files, directories, the registry, other processes — *even when the
//!   object's DACL would allow them*. The DACL is a second, weaker gate;
//!   MIC is the real boundary.
//! * The workspace (and any extra writable roots) is made writable by
//!   granting a write ACE for the low-integrity SID on the directory (inheriting).
//!   The grant is revoked when the child struct is dropped ([`AclGuard`]).
//! * A **Job Object** (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) holds the whole
//!   tree: a timeout, `start_kill`, or dropping the child kills the shell
//!   *and everything it spawned* atomically — no orphaned grandchildren.
//!   The job is assigned at creation via `PROC_THREAD_ATTRIBUTE_JOB_LIST`, so
//!   the process can never briefly run uncontained.
//!
//! Inherent MIC caveat: pre-existing *files* created by a medium-integrity
//! process (e.g. a freshly checked-out source tree) stay medium-labeled, so
//! the low child can read but not modify them until a run touches them —
//! new files the sandbox creates are low-labeled and stay writable. This
//! matches the model codex runs on Windows.

use super::{is_secret_env_var, shell_quote, ExecChild, SpawnReq};
use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use windows_sys::core::PCWSTR;
use windows_sys::Win32::Foundation::{
    BOOL, CloseHandle, ERROR_SUCCESS, GetLastError, HLOCAL, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSidToSidW, EXPLICIT_ACCESS_W, GetNamedSecurityInfoW, SE_FILE_OBJECT,
    SetEntriesInAclW, SetNamedSecurityInfoW, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
};
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, FreeSid, SECURITY_ATTRIBUTES, SE_OBJECT_TYPE, SID_AND_ATTRIBUTES,
    TOKEN_MANDATORY_LABEL,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, GENERIC_READ, OPEN_EXISTING,
};
use windows_sys::Win32::System::Console::{GetStdHandle, STD_INPUT_HANDLE};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    InitializeProcThreadAttributeList, PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_INFORMATION,
    STARTUPINFOEXW, STARTUPINFOW, STARTF_USESTDHANDLES, UpdateProcThreadAttribute,
    CREATE_NO_WINDOW,
};

/// `PROC_THREAD_ATTRIBUTE_MANDATORY_LABEL` — winnt.h value `0x00020012`,
/// which windows-sys 0.59 does not export as a named constant.
const PROC_THREAD_ATTRIBUTE_MANDATORY_LABEL: usize = 0x0002_0012;
/// Low mandatory integrity level SID (`SEC_MANDATORY_LABEL` low level).
const LOW_INTEGRITY_SID: &str = "S-1-16-4";
/// `STILL_ACTIVE` exit code — the process is still running (shouldn't happen
/// after `WaitForSingleObject` returns).
const STILL_ACTIVE: u32 = 0x103;

fn to_wide(s: &str) -> Vec<u16> {
    let mut v: Vec<u16> = s.encode_utf16().collect();
    v.push(0);
    v
}

fn last_os_error() -> io::Error {
    io::Error::new(io::ErrorKind::Other, format!("Win32 error {}", unsafe { GetLastError() }))
}

// ---------------------------------------------------------------------------
// Shell selection + command line
// ---------------------------------------------------------------------------

enum Shell {
    Bash,
    Cmd,
}

/// Pick the shell once per process. git-bash (Git for Windows) gives full
/// POSIX parity — including the stateful-session cwd marker — and is present
/// on essentially every dev box; `cmd` is the bare fallback (stateless only).
fn pick_shell() -> &'static Shell {
    static SHELL: LazyLock<Shell> = LazyLock::new(|| {
        std::process::Command::new("bash")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
            .then(Shell::Bash)
            .unwrap_or(Shell::Cmd)
    });
    &SHELL
}

/// Is a POSIX shell available? (Stateful sessions need one — see `Shell`.)
pub fn shell_is_bash() -> bool {
    matches!(pick_shell(), Shell::Bash)
}

/// Quote one argument for a `CreateProcessW` command line (MSVCRT rules):
/// unquoted when safe, otherwise quoted with internal `"` escaped by
/// doubling the preceding backslashes.
fn arg_quote(s: &str) -> String {
    if s.is_empty() {
        return "\"\"".to_string();
    }
    if s
        .bytes()
        .all(|b| b != b' ' && b != b'\t' && b != b'"' && b != b'\\')
    {
        return s.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for b in s.bytes() {
        match b {
            b'\\' => backslashes += 1,
            b'"' => {
                out.push_str(&"\\".repeat(2 * backslashes + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(backslashes));
                out.push(b as char);
                backslashes = 0;
            }
        }
    }
    // A trailing backslash run is followed by the closing quote, and MSVCRT
    // halves such runs — so double it to encode the run literally.
    out.push_str(&"\\".repeat(2 * backslashes));
    out.push('"');
    out
}

/// The full `CreateProcessW` command line for one script run.
fn command_line(shell: &Shell, script: &str) -> String {
    match shell {
        // The script is POSIX single-quoted (`shell_quote`), then MSVCRT-quoted
        // so CreateProcessW's argv parsing hands bash ONE argument (a
        // single-quoted script containing spaces would otherwise be split —
        // `'` is not a quote character for the CRT parser).
        Shell::Bash => format!(
            "{} -lc {}",
            arg_quote("bash"),
            arg_quote(&shell_quote(script))
        ),
        // `cmd /d /s /c` runs everything between the outer quotes verbatim.
        Shell::Cmd => format!("{} /d /s /c \"{}\"", arg_quote("cmd"), script),
    }
}

/// The child's environment block: the parent's, minus credential variables
/// (same scrub as the Linux runner's `env_remove`). A trailing NUL terminates
/// the block; an empty NUL string means "inherit" and is never used.
fn env_block() -> Vec<u16> {
    let mut block = Vec::new();
    for (k, v) in std::env::vars() {
        if is_secret_env_var(&k) {
            continue;
        }
        block.extend(format!("{k}={v}").encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

// ---------------------------------------------------------------------------
// Workspace write grants (DACL)
// ---------------------------------------------------------------------------

/// Revokes a low-integrity write ACE on `path` when dropped.
struct AclGuard {
    path: PathBuf,
}

/// Add (`add = true`) or remove (`add = false`) the read/write/execute ACE
/// for the low-integrity SID on `path`, inheriting to children. The ACE is
/// matched for deletion by permission mask + trustee, so removal is
/// idempotent.
fn set_low_integrity_ace(path: &Path, add: bool) -> io::Result<()> {
    use windows_sys::Win32::Security::Authorization::{
        DELETE_ACCESS, NO_MULTIPLE_TRUSTEE, SET_ACCESS, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{ACL, CONTAINER_INHERIT_ACE, OBJECT_INHERIT_ACE, PSID};

    let wide = to_wide(&path.to_string_lossy());
    let name = wide.as_ptr() as PCWSTR;

    let mut sid: PSID = std::ptr::null_mut();
    let sid_wide = to_wide(LOW_INTEGRITY_SID);
    if unsafe { ConvertStringSidToSidW(sid_wide.as_ptr() as PCWSTR, &mut sid) } == 0
        || sid.is_null()
    {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "ConvertStringSidToSid failed (low-integrity SID)",
        ));
    }

    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: (FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE) as u32,
        grfAccessMode: (if add { SET_ACCESS } else { DELETE_ACCESS }) as u32,
        grfInheritance: (CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE) as u32,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE as u32,
            TrusteeForm: TRUSTEE_IS_SID as u32,
            TrusteeType: TRUSTEE_IS_UNKNOWN as u32,
            ptstrName: sid as *mut u16,
        },
    };

    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sd: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let r = unsafe {
        GetNamedSecurityInfoW(
            name,
            SE_FILE_OBJECT as SE_OBJECT_TYPE,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut sd,
        )
    };
    if r != ERROR_SUCCESS || dacl.is_null() {
        unsafe {
            FreeSid(sid);
            if !sd.is_null() {
                LocalFree(sd as HLOCAL);
            }
        }
        return Err(io::Error::new(
            io::ErrorKind::Other,
            format!("GetNamedSecurityInfoW({}) failed: {r}", path.display()),
        ));
    }

    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    let r = unsafe { SetEntriesInAclW(1, &entry, dacl, &mut new_dacl) };
    if r != ERROR_SUCCESS || new_dacl.is_null() {
        unsafe {
            FreeSid(sid);
            LocalFree(dacl as HLOCAL);
            LocalFree(sd as HLOCAL);
        }
        return Err(io::Error::new(
            io::ErrorKind::Other,
            format!("SetEntriesInAclW({}) failed: {r}", path.display()),
        ));
    }

    let r = unsafe {
        SetNamedSecurityInfoW(
            name,
            SE_FILE_OBJECT as SE_OBJECT_TYPE,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            new_dacl,
            std::ptr::null_mut(),
        )
    };
    // `SetNamedSecurityInfoW` copies the DACL — everything is ours now.
    unsafe {
        FreeSid(sid);
        LocalFree(new_dacl as HLOCAL);
        LocalFree(dacl as HLOCAL);
        LocalFree(sd as HLOCAL);
    }
    if r != ERROR_SUCCESS {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            format!("SetNamedSecurityInfoW({}) failed: {r}", path.display()),
        ));
    }
    Ok(())
}

impl Drop for AclGuard {
    fn drop(&mut self) {
        // The grant must not outlive the child. Deleting an ACE that is
        // already gone is a no-op we can ignore.
        let _ = set_low_integrity_ace(&self.path, false);
    }
}

// ---------------------------------------------------------------------------
// Child handle
// ---------------------------------------------------------------------------

/// A child spawned via `CreateProcessW` into a job object, optionally at low
/// integrity. Dropping it revokes the ACL grants and — via
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` — kills anything still running.
pub struct WinChild {
    process: windows_sys::Win32::Foundation::HANDLE,
    job: windows_sys::Win32::Foundation::HANDLE,
    stdout: Option<std::fs::File>,
    stderr: Option<std::fs::File>,
    /// One-shot exit channel fed by a blocking reaper (see [`Self::wait`]).
    exit_rx: Option<tokio::sync::mpsc::UnboundedReceiver<i32>>,
    exit_code: Option<i32>,
    /// Low-integrity write grants, revoked on drop.
    acls: Vec<AclGuard>,
}

impl WinChild {
    pub fn take_stdout(&mut self) -> Option<std::fs::File> {
        self.stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<std::fs::File> {
        self.stderr.take()
    }

    /// Kill the whole tree (shell + grandchildren) via the job object.
    pub fn start_kill(&mut self) {
        unsafe {
            let _ = TerminateJobObject(self.job, 1);
        }
    }

    /// Wait for exit, resolving to the exit code (-1 if the process was
    /// killed without a code). Repeated awaited waits are safe: a cancelled
    /// wait (timeout poll) does not consume the one-shot channel, and the
    /// reaper thread only ever blocks on the real process handle.
    pub async fn wait(&mut self) -> Result<i32, io::Error> {
        if let Some(code) = self.exit_code {
            return Ok(code);
        }
        if self.exit_rx.is_none() {
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            let process = self.process;
            self.process = std::ptr::null_mut();
            tokio::task::spawn_blocking(move || {
                let code = unsafe {
                    windows_sys::Win32::System::Threading::WaitForSingleObject(
                        process,
                        windows_sys::Win32::Foundation::INFINITE,
                    );
                    let mut code: u32 = 0;
                    let _ =
                        windows_sys::Win32::System::Threading::GetExitCodeProcess(
                            process, &mut code,
                        );
                    let _ = CloseHandle(process);
                    if code == STILL_ACTIVE { -1 } else { code as i32 }
                };
                let _ = tx.send(code);
            });
            self.exit_rx = Some(rx);
        }
        let code = self
            .exit_rx
            .as_mut()
            .unwrap()
            .recv()
            .await
            .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "exit watcher dropped"))?;
        self.exit_code = Some(code);
        Ok(code)
    }
}

impl Drop for WinChild {
    fn drop(&mut self) {
        unsafe {
            // Kill any survivors (no-op if already exited), then release the
            // job — `KILL_ON_JOB_CLOSE` is the last line of containment if
            // the exec future is abandoned without a wait/kill.
            let _ = TerminateJobObject(self.job, 1);
            let _ = CloseHandle(self.job);
            if !self.process.is_null() {
                let _ = CloseHandle(self.process);
            }
        }
        // `acls` drop here → revoke the low-integrity write grants.
    }
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

fn wide_ptr(v: &Vec<u16>) -> PCWSTR {
    v.as_ptr() as PCWSTR
}

/// Build and spawn the shell for one run: job object always, low-integrity
/// label + workspace write grants when `req.sandboxed`.
pub fn spawn(req: &SpawnReq) -> io::Result<ExecChild> {
    let shell = pick_shell();
    let cmd_line = command_line(shell, &req.command);
    // `CreateProcessW` may modify the command-line buffer in place.
    let mut cmdline = to_wide(&cmd_line);
    let cwd_wide = to_wide(&req.cwd.to_string_lossy());
    let env = env_block();

    // 1. Job object: the whole tree dies on timeout / kill / drop.
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(last_os_error());
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags =
        (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK) as _;
    if unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of_val(&limits) as u32,
        )
    } == 0
    {
        unsafe { CloseHandle(job) };
        return Err(last_os_error());
    }

    // 2. Optional containment: workspace write grants + low-integrity SID.
    let mut acls: Vec<AclGuard> = Vec::new();
    let mut label_sid: windows_sys::Win32::Security::PSID = std::ptr::null_mut();
    let mut label: Option<TOKEN_MANDATORY_LABEL> = None;
    if req.sandboxed {
        let roots: Vec<PathBuf> = std::iter::once(req.workspace.clone())
            .chain(
                req.writable_roots
                    .iter()
                    .filter(|r| !r.is_empty())
                    .map(PathBuf::from),
            )
            .collect();
        for r in &roots {
            if !r.is_dir() {
                unsafe { CloseHandle(job) };
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("sandbox root does not exist: {}", r.display()),
                ));
            }
            set_low_integrity_ace(r, true).map_err(|e| {
                // Revoke whatever we already granted, then report.
                unsafe { CloseHandle(job) };
                e
            })?;
            acls.push(AclGuard { path: r.clone() });
        }
        let sid_wide = to_wide(LOW_INTEGRITY_SID);
        if unsafe { ConvertStringSidToSidW(sid_wide.as_ptr() as PCWSTR, &mut label_sid) } == 0
            || label_sid.is_null()
        {
            unsafe { CloseHandle(job) };
            return Err(io::Error::new(
                io::ErrorKind::Other,
                "ConvertStringSidToSid failed (low-integrity SID)",
            ));
        }
        label = Some(TOKEN_MANDATORY_LABEL {
            Label: SID_AND_ATTRIBUTES {
                Sid: label_sid,
                Attributes: 0,
            },
        });
    }

    // 3. Process/thread attribute list: job membership is assigned
    //    atomically at creation (the tree can never run uncontained), plus
    //    the low-integrity label when sandboxed.
    let attr_count = 1usize + label.is_some() as usize;
    let mut attr_buf: Vec<u8> = Vec::new();
    let list;
    unsafe {
        let mut size: usize = 0;
        if InitializeProcThreadAttributeList(std::ptr::null_mut(), attr_count as u32, 0, &mut size)
            != 0
        {
            // First call must fail with a required-size out-param.
            CloseHandle(job);
            return Err(io::Error::new(
                io::ErrorKind::Other,
                "InitializeProcThreadAttributeList(size probe) unexpectedly succeeded",
            ));
        }
        attr_buf.resize(size, 0);
        list = attr_buf.as_mut_ptr() as _;
        if InitializeProcThreadAttributeList(list, attr_count as u32, 0, &mut size) == 0 {
            CloseHandle(job);
            return Err(last_os_error());
        }
        if UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
            &job as *const _ as *const _,
            std::mem::size_of::<windows_sys::Win32::Foundation::HANDLE>(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ) == 0
        {
            DeleteProcThreadAttributeList(list);
            CloseHandle(job);
            return Err(last_os_error());
        }
        if let Some(l) = &label {
            if UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_MANDATORY_LABEL,
                l as *const _ as *const _,
                std::mem::size_of_val(l),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            ) == 0
            {
                DeleteProcThreadAttributeList(list);
                CloseHandle(job);
                return Err(last_os_error());
            }
        }
    }

    // 4. Stdio pipes (child inherits the write ends).
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    let mut out_read: windows_sys::Win32::Foundation::HANDLE = std::ptr::null_mut();
    let mut out_write: windows_sys::Win32::Foundation::HANDLE = std::ptr::null_mut();
    let mut err_read: windows_sys::Win32::Foundation::HANDLE = std::ptr::null_mut();
    let mut err_write: windows_sys::Win32::Foundation::HANDLE = std::ptr::null_mut();
    let spawn_ok = (|| -> bool {
        unsafe {
            if CreatePipe(&mut out_read, &mut out_write, &sa, 0) == 0 {
                return false;
            }
            if CreatePipe(&mut err_read, &mut err_write, &sa, 0) == 0 {
                return false;
            }
            true
        }
    })();
    if !spawn_ok {
        unsafe {
            if !out_read.is_null() {
                CloseHandle(out_read);
            }
            if !out_write.is_null() {
                CloseHandle(out_write);
            }
            if !err_read.is_null() {
                CloseHandle(err_read);
            }
            if !err_write.is_null() {
                CloseHandle(err_write);
            }
            DeleteProcThreadAttributeList(list);
            CloseHandle(job);
            if !label_sid.is_null() {
                FreeSid(label_sid);
            }
        }
        return Err(last_os_error());
    }

    // stdin: the console handle if one exists, else NUL — the control plane
    // is a GUI app with no console, where `GetStdHandle` would return
    // INVALID_HANDLE_VALUE.
    let mut stdin = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    let mut stdin_nul: windows_sys::Win32::Foundation::HANDLE = std::ptr::null_mut();
    if stdin.is_null() || stdin == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        let nul_wide = to_wide("NUL");
        let h = unsafe {
            CreateFileW(
                wide_ptr(&nul_wide),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null(),
            )
        };
        if h.is_null() || h == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(out_read);
                CloseHandle(out_write);
                CloseHandle(err_read);
                CloseHandle(err_write);
                DeleteProcThreadAttributeList(list);
                CloseHandle(job);
                if !label_sid.is_null() {
                    FreeSid(label_sid);
                }
            }
            return Err(last_os_error());
        }
        stdin_nul = h;
        stdin = h;
    }

    // 5. Create the process (in the job, at the label).
    let mut si = unsafe { std::mem::zeroed::<STARTUPINFOW>() };
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = stdin;
    si.hStdOutput = out_write;
    si.hStdError = err_write;
    let si_ex = STARTUPINFOEXW {
        StartupInfo: si,
        lpAttributeList: list,
    };
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

    let ok: BOOL = unsafe {
        CreateProcessW(
            std::ptr::null(),
            cmdline.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1, // bInheritHandles
            (EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW) as _,
            env.as_ptr() as *const _,
            wide_ptr(&cwd_wide),
            &si_ex,
            &mut pi,
        )
    };
    if ok == 0 {
        unsafe {
            DeleteProcThreadAttributeList(list);
            CloseHandle(job);
            CloseHandle(out_read);
            CloseHandle(out_write);
            CloseHandle(err_read);
            CloseHandle(err_write);
            if !stdin_nul.is_null() {
                CloseHandle(stdin_nul);
            }
            if !label_sid.is_null() {
                FreeSid(label_sid);
            }
        }
        return Err(last_os_error());
    }

    unsafe {
        DeleteProcThreadAttributeList(list);
        // Parent side keeps only the read ends; the thread handle is unused.
        CloseHandle(out_write);
        CloseHandle(err_write);
        CloseHandle(pi.hThread);
        if !stdin_nul.is_null() {
            CloseHandle(stdin_nul);
        }
        if !label_sid.is_null() {
            FreeSid(label_sid);
        }
    }

    // Convert the pipe read ends to `File` (takes ownership of the handles).
    let stdout_file =
        unsafe { std::fs::File::from_raw_handle(out_read as *mut _ as usize as i32) };
    let stderr_file =
        unsafe { std::fs::File::from_raw_handle(err_read as *mut _ as usize as i32) };

    Ok(ExecChild::Windows(WinChild {
        process: pi.hProcess,
        job,
        stdout: Some(stdout_file),
        stderr: Some(stderr_file),
        exit_rx: None,
        exit_code: None,
        acls,
    }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arg_quoting_round_trips_the_msvcrt_rules() {
        assert_eq!(arg_quote("bash"), "bash");
        assert_eq!(arg_quote(""), "\"\"");
        assert_eq!(arg_quote("C:\\Git\\bin\\bash"), "\"C:\\Git\\bin\\bash\"");
        assert_eq!(arg_quote("a b"), "\"a b\"");
        assert_eq!(arg_quote("say \"hi\""), "\"say \\\"hi\\\"\"");
        // Trailing run: doubled so the closing quote survives the parser.
        assert_eq!(arg_quote("trail\\"), "\"trail\\\\\"");
        // Run NOT followed by a quote: copied verbatim (MSVCRT only treats
        // `\` specially before a `"`).
        assert_eq!(arg_quote("back\\slash"), "\"back\\slash\"");
    }

    #[test]
    fn command_lines_use_the_right_shell_form() {
        // Bash: the whole script is POSIX single-quoted, exactly as the
        // Linux runner quotes it (`shell_quote`) — bash parses the command
        // line itself, so there is no MSVCRT layer between us and the script.
        let script = "echo 'it's'";
        assert_eq!(
            command_line(&Shell::Bash, script),
            format!("bash -lc {}", shell_quote(script))
        );
        assert!(command_line(&Shell::Bash, "ls").starts_with("bash -lc "));
        // Cmd: `/d /s /c` with the script wrapped in one pair of quotes.
        assert_eq!(
            command_line(&Shell::Cmd, "echo hi"),
            "cmd /d /s /c \"echo hi\""
        );
    }

    #[test]
    fn env_block_scrubs_credentials_and_is_terminated() {
        unsafe {
            std::env::set_var("NINFIER_TEST_SECRET_XYZ", "hunter2");
            std::env::set_var("NINFIER_TEST_KEEP_XYZ", "fine");
        }
        let block = env_block();
        let text = String::from_utf16_lossy(&block);
        // NUL-terminated entries plus one trailing NUL.
        assert!(text.ends_with('\0'));
        let entries: Vec<&str> = text.split('\0').filter(|e| !e.is_empty()).collect();
        assert!(
            entries.iter().any(|e| e == "NINFIER_TEST_KEEP_XYZ=fine"),
            "expected the kept var in: {entries:?}"
        );
        assert!(
            !entries.iter().any(|e| e.starts_with("NINFIER_TEST_SECRET_XYZ=")),
            "credential var leaked into the child env: {entries:?}"
        );
        unsafe {
            std::env::remove_var("NINFIER_TEST_SECRET_XYZ");
            std::env::remove_var("NINFIER_TEST_KEEP_XYZ");
        }
    }
}
