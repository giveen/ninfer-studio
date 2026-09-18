// Rust guideline compliant 2026-07-28

//! Windows sandbox: Job Object + Mandatory Integrity Control (MIC).
//!
//! Containment model (the "codex" one):
//!
//! * The child is created at **low integrity** (`S-1-16-4`) via
//!   `PROC_THREAD_ATTRIBUTE_MANDATORY_LABEL` with `SE_GROUP_INTEGRITY`. The integrity policy then
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
//!   Breakaway from job (`JOB_OBJECT_LIMIT_BREAKAWAY_OK`) is explicitly disabled.
//! * Stdin is bound to NUL to prevent child processes from reading interactive user input.
//! * Note on file integrity: files created during low-integrity execution retain
//!   low integrity (`S-1-16-4`) on host NTFS after execution ends.
//! * MIC applies to write operations; read access is governed by DACLs host-wide.

use super::{ExecChild, SpawnReq, is_secret_env_var};
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use windows_sys::Win32::Foundation::{
    BOOL, CloseHandle, ERROR_SUCCESS, GENERIC_READ, GetLastError, HANDLE_FLAG_INHERIT, HLOCAL,
    LocalFree, SetHandleInformation,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSidToSidW, EXPLICIT_ACCESS_W, GetNamedSecurityInfoW, SE_FILE_OBJECT,
    SE_OBJECT_TYPE, SetEntriesInAclW, SetNamedSecurityInfoW, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
};
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, FreeSid, SECURITY_ATTRIBUTES, SID_AND_ATTRIBUTES,
    TOKEN_MANDATORY_LABEL,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Console::{GetStdHandle, STD_INPUT_HANDLE};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, InitializeProcThreadAttributeList,
    PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    STARTUPINFOW, UpdateProcThreadAttribute,
};
use windows_sys::core::PCWSTR;
/// `PROC_THREAD_ATTRIBUTE_MANDATORY_LABEL` — winnt.h value `0x00020012`,
/// which windows-sys 0.59 does not export as a named constant.
const PROC_THREAD_ATTRIBUTE_MANDATORY_LABEL: usize = 0x0002_0012;
/// Mandatory Integrity Control attribute flag (`SE_GROUP_INTEGRITY` = 0x20, per
/// winnt.h / windows-sys's `SystemServices::SE_GROUP_INTEGRITY`).
const SE_GROUP_INTEGRITY: u32 = 0x20;
/// Low mandatory integrity level SID (`SEC_MANDATORY_LABEL` low level).
const LOW_INTEGRITY_SID: &str = "S-1-16-4";
/// `EXPLICIT_ACCESS_W.grfAccessMode` value that REMOVES a matching ACE
/// (Aclapi.h `DELETE_ACCESS` = 1; windows-sys 0.59 exports only the
/// grant-side `SET_ACCESS` = 2).
const DELETE_ACCESS: i32 = 1;
/// `STILL_ACTIVE` exit code — the process is still running (shouldn't happen
/// after `WaitForSingleObject` returns).
const STILL_ACTIVE: u32 = 0x103;

fn to_wide(s: &str) -> Vec<u16> {
    let mut v: Vec<u16> = s.encode_utf16().collect();
    v.push(0);
    v
}

fn path_to_wide(path: &Path) -> Vec<u16> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let mut v: Vec<u16> = path.as_os_str().encode_wide().collect();
        v.push(0);
        v
    }
    #[cfg(not(windows))]
    {
        to_wide(&path.to_string_lossy())
    }
}

fn last_os_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::Other,
        format!("Win32 error {}", unsafe { GetLastError() }),
    )
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
///
/// The probe rejects WSL app-execution aliases: a WSL install puts a
/// `bash.exe` on PATH (in `WindowsApps`) that also answers `--version`, but
/// it is a *Linux* process — Windows-form cwd paths, our pipe inheritance,
/// and the job/label semantics do not carry over. A native bash (git-bash,
/// MSYS2) reports `cygwin`/`msys` in its version string; WSL reports
/// `linux-gnu`.
fn pick_shell() -> &'static Shell {
    static SHELL: LazyLock<Shell> = LazyLock::new(|| {
        let native_bash = std::process::Command::new("bash")
            .arg("--version")
            .output()
            .map(|o| {
                o.status.success() && !String::from_utf8_lossy(&o.stdout).contains("linux-gnu")
            })
            .unwrap_or(false);
        if native_bash { Shell::Bash } else { Shell::Cmd }
    });
    &SHELL
}

/// Is a POSIX shell available? (Stateful sessions need one — see `Shell`.)
pub fn shell_is_bash() -> bool {
    matches!(pick_shell(), Shell::Bash)
}

/// The full `CreateProcessW` command line for one script run.
///
/// `bash -lc <script>`: the script IS bash's command string — bash parses it
/// as shell code, exactly like the Linux runner's `bash -lc <argv>` shape.
/// `arg_quote` (MSVCRT double-quoting) is what makes CreateProcessW's argv
/// parsing hand it to bash as ONE argument, and the round-trip is lossless
/// for any script bytes (quotes, backslashes, spaces) under the UCRT parser
/// rules — so no POSIX quoting is applied here (single-quoting the script
/// would make bash treat it as one program name, not a command line).
fn command_line(shell: &Shell, script: &str) -> String {
    match shell {
        Shell::Bash => format!(
            "{} -lc {}",
            super::arg_quote("bash"),
            super::arg_quote(script)
        ),
        // `cmd /d /s /c` runs everything between outer quotes verbatim.
        // Internal quotes are escaped to avoid terminating the wrapper early.
        Shell::Cmd => {
            let escaped = script.replace('"', "\"\"");
            format!("{} /d /s /c \"{}\"", super::arg_quote("cmd"), escaped)
        }
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

/// Normalize a path for map keying in `ACL_GRANTS` so different path spellings
/// (casing, trailing slashes, forward vs back slashes) resolve to the exact same key.
fn normalize_path(path: &Path) -> PathBuf {
    if let Ok(canon) = std::fs::canonicalize(path) {
        let s = canon.to_string_lossy();
        let cleaned = s.strip_prefix(r"\\?\").unwrap_or(&s);
        PathBuf::from(cleaned.to_lowercase())
    } else {
        let clean = path.to_string_lossy().replace('/', "\\");
        let trimmed = clean.trim_end_matches('\\');
        PathBuf::from(trimmed.to_lowercase())
    }
}

/// Process-global refcounts of active low-integrity grants, by path.
///
/// Multiple sandboxed shells can run concurrently on the same workspace (a
/// background build + a foreground command, or two background jobs). A
/// naive "grant on spawn, revoke on child drop" makes the first child's drop
/// delete the ACE the second child still needs — its writes would start
/// failing with ACCESS_DENIED mid-run. The grant is therefore taken when a
/// path's count goes 0→1 and revoked only when the LAST holder leaves.
static ACL_GRANTS: LazyLock<std::sync::Mutex<std::collections::HashMap<PathBuf, u32>>> =
    LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Take a refcount on the low-integrity grant for `path`, adding the ACE on
/// first use. Fails only if the FIRST grant fails (a path already granted
/// here cannot newly fail).
fn acquire_acl(path: &Path) -> io::Result<()> {
    let key = normalize_path(path);
    let first = {
        let mut grants = ACL_GRANTS.lock().unwrap_or_else(|e| e.into_inner());
        let count = grants.entry(key.clone()).or_insert(0);
        let first = *count == 0;
        *count += 1;
        first
    };
    if first {
        if let Err(e) = set_low_integrity_ace(path, true) {
            // Roll the count back so the next run isn't left believing a
            // grant exists when it doesn't.
            let mut grants = ACL_GRANTS.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(c) = grants.get_mut(&key) {
                *c -= 1;
                if *c == 0 {
                    grants.remove(&key);
                }
            }
            return Err(e);
        }
    }
    Ok(())
}

/// Release one refcount; revoke the ACE when the last holder leaves.
fn release_acl(path: &Path) {
    let key = normalize_path(path);
    let last = {
        let mut grants = ACL_GRANTS.lock().unwrap_or_else(|e| e.into_inner());
        match grants.get_mut(&key) {
            Some(c) => {
                *c -= 1;
                let last = *c == 0;
                if last {
                    grants.remove(&key);
                }
                last
            }
            None => false,
        }
    };
    if last {
        // The grant must not outlive the last child. Deleting an ACE that is
        // already gone is a no-op we can ignore; log any unexpected failure.
        if let Err(e) = set_low_integrity_ace(path, false) {
            tracing::warn!(path = %path.display(), error = %e, "Failed to revoke low-integrity ACE");
        }
    }
}

/// Revokes the low-integrity write grant on `path` when dropped.
#[derive(Debug)]
struct AclGuard {
    path: PathBuf,
}

impl Drop for AclGuard {
    fn drop(&mut self) {
        release_acl(&self.path);
    }
}

/// Add (`add = true`) or remove (`add = false`) the read/write/execute ACE
/// for the low-integrity SID on `path`, inheriting to children. The ACE is
/// matched for deletion by permission mask + trustee, so removal is
/// idempotent.
fn set_low_integrity_ace(path: &Path, add: bool) -> io::Result<()> {
    use windows_sys::Win32::Security::Authorization::{NO_MULTIPLE_TRUSTEE, SET_ACCESS, TRUSTEE_W};
    use windows_sys::Win32::Security::{ACL, CONTAINER_INHERIT_ACE, OBJECT_INHERIT_ACE, PSID};

    let wide = path_to_wide(path);
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
        grfAccessPermissions: FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE,
        grfAccessMode: if add { SET_ACCESS } else { DELETE_ACCESS },
        grfInheritance: CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: sid as *mut u16,
        },
    };

    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sd: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let r = unsafe {
        GetNamedSecurityInfoW(
            name,
            SE_FILE_OBJECT,
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
            SE_FILE_OBJECT,
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

// ---------------------------------------------------------------------------
// Child handle
// ---------------------------------------------------------------------------

/// A child spawned via `CreateProcessW` into a job object, optionally at low
/// integrity. Dropping it revokes the ACL grants and — via
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` — kills anything still running.
///
/// The handles live in `std::os::windows::io::OwnedHandle` (`Send + Sync`,
/// closes on drop) so the child can cross threads; the exit reaper works on
/// the raw handle *value* and never closes one.
#[derive(Debug)]
pub struct WinChild {
    process: Option<std::os::windows::io::OwnedHandle>,
    job: std::os::windows::io::OwnedHandle,
    stdout: Option<std::fs::File>,
    stderr: Option<std::fs::File>,
    /// One-shot exit channel fed by a blocking reaper (see [`Self::wait`]).
    exit_rx: Option<tokio::sync::mpsc::UnboundedReceiver<i32>>,
    exit_code: Option<i32>,
    /// Low-integrity write grants, revoked on drop. Drop is the only
    /// "read" of this field — the lint doesn't see through `Drop`.
    #[allow(dead_code)]
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
            let _ = TerminateJobObject(self.job.as_raw_handle(), 1);
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
            // The reaper gets the handle VALUE (an `isize` — `Send`); the
            // `OwnedHandle` field keeps the handle valid (and closes it) for
            // as long as this struct lives. If this struct is dropped first,
            // the reaper's wait simply unblocks and its exit-code query is a
            // harmless no-op.
            let raw = self
                .process
                .as_ref()
                .map(|h| h.as_raw_handle())
                .unwrap_or(std::ptr::null_mut()) as isize;
            tokio::task::spawn_blocking(move || {
                let handle = raw as *mut std::ffi::c_void;
                let code = unsafe {
                    let wait_res = windows_sys::Win32::System::Threading::WaitForSingleObject(
                        handle,
                        windows_sys::Win32::System::Threading::INFINITE,
                    );
                    if wait_res == windows_sys::Win32::Foundation::WAIT_FAILED {
                        return; // Handle closed or invalid; drop tx to signal exit watcher dropped
                    }
                    let mut code: u32 = 0;
                    let get_res = windows_sys::Win32::System::Threading::GetExitCodeProcess(
                        handle, &mut code,
                    );
                    if get_res == 0 {
                        return; // Exit code query failed
                    }
                    if code == STILL_ACTIVE {
                        -1
                    } else {
                        code as i32
                    }
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
        // Kill any survivors (no-op if already exited). The `OwnedHandle`
        // fields then close their handles right after this body — closing
        // the job object is the last line of containment (`KILL_ON_JOB_CLOSE`)
        // if the exec future is abandoned without a wait/kill.
        unsafe {
            let _ = TerminateJobObject(self.job.as_raw_handle(), 1);
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
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
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
        let mut roots: Vec<PathBuf> = Vec::new();
        if !req.workspace.is_dir() {
            unsafe { CloseHandle(job) };
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("sandbox workspace root does not exist: {}", req.workspace.display()),
            ));
        }
        roots.push(req.workspace.clone());

        for raw_root in &req.writable_roots {
            if raw_root.trim().is_empty() {
                continue;
            }
            if let Some(validated) = super::validate_writable_root(raw_root) {
                roots.push(validated);
            } else {
                unsafe { CloseHandle(job) };
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!("rejected dangerous or invalid writable_root: {raw_root}"),
                ));
            }
        }

        for r in &roots {
            acquire_acl(r).map_err(|e| {
                // The local `acls` guard revokes the earlier grants as
                // spawn() unwinds; report the failing root.
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
                Attributes: SE_GROUP_INTEGRITY,
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
            // The parent keeps the read ends: strip their inheritability so
            // only the write ends reach the child. Otherwise every
            // grandchild inherits a write end too and the parent's EOF —
            // hence the exec timeout path — waits on processes it never
            // spawned.
            if SetHandleInformation(out_read, HANDLE_FLAG_INHERIT, 0) == 0 {
                return false;
            }
            if SetHandleInformation(err_read, HANDLE_FLAG_INHERIT, 0) == 0 {
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

    // stdin: bound to NUL unconditionally so a sandboxed command cannot read
    // interactive user input typed at the host console.
    let nul_wide = to_wide("NUL");
    let stdin_nul = unsafe {
        CreateFileW(
            wide_ptr(&nul_wide),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &sa as *const _ as *mut _,
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if stdin_nul.is_null() || stdin_nul == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
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
    let stdin = stdin_nul;

    // 5. Create the process (in the job, at the label).
    let mut si = unsafe { std::mem::zeroed::<STARTUPINFOW>() };
    // `cb` is the size of the whole EX struct: with
    // EXTENDED_STARTUPINFO_PRESENT set, CreateProcessW validates the
    // attribute list against it, so the inner INFO size is wrong here.
    si.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
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
            // CREATE_UNICODE_ENVIRONMENT: `env` is a UTF-16 block
            // (see `env_block`) — without it CreateProcessW parses the
            // block as ANSI and the child inherits a garbage environment.
            EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
            env.as_ptr() as *const _,
            wide_ptr(&cwd_wide),
            &si_ex.StartupInfo as *const STARTUPINFOW,
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
    let stdout_file = unsafe { std::fs::File::from_raw_handle(out_read) };
    let stderr_file = unsafe { std::fs::File::from_raw_handle(err_read) };

    // `OwnedHandle` takes ownership of the raw handles (closes on drop).
    // Stable has no `OwnedHandle::new` — `FromRawHandle` is the constructor,
    // and its `RawHandle` is `*mut c_void`, exactly what windows-sys returns.
    Ok(ExecChild::Windows(WinChild {
        process: Some(unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(pi.hProcess) }),
        job: unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(job) },
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
    use super::super::arg_quote;
    use super::*;

    #[test]
    fn command_lines_use_the_right_shell_form() {
        // Bash: the script goes to bash -lc RAW (bash parses it as the
        // command string) — arg_quote only guarantees it is ONE argv element
        // for CreateProcessW's parser. (The arg_quote round-trip proof runs
        // on every platform in `crate::sandbox::quoting_tests`.)
        let script = "echo 'it's'";
        assert_eq!(
            command_line(&Shell::Bash, script),
            format!("bash -lc {}", arg_quote(script))
        );
        assert_eq!(command_line(&Shell::Bash, "ls"), "bash -lc ls");
        // A script with spaces must come out double-quoted (one argument):
        assert_eq!(command_line(&Shell::Bash, "a b"), "bash -lc \"a b\"");
        // Quotes round-trip through the MSVCRT parser (2N+1 backslash rule):
        // the script `echo \"hi\"` is encoded so bash receives those exact
        // bytes.
        assert_eq!(
            command_line(&Shell::Bash, r#"echo \"hi\""#),
            "bash -lc \"echo \\\"hi\\\"\""
        );
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
            entries.iter().any(|e| *e == "NINFIER_TEST_KEEP_XYZ=fine"),
            "expected the kept var in: {entries:?}"
        );
        assert!(
            !entries
                .iter()
                .any(|e| e.starts_with("NINFIER_TEST_SECRET_XYZ=")),
            "credential var leaked into the child env: {entries:?}"
        );
        unsafe {
            std::env::remove_var("NINFIER_TEST_SECRET_XYZ");
            std::env::remove_var("NINFIER_TEST_KEEP_XYZ");
        }
    }

    #[test]
    fn acl_path_normalization_handles_case_and_separators() {
        let p1 = Path::new("C:/Users/Test/Project");
        let p2 = Path::new("c:\\users\\test\\project\\");
        assert_eq!(normalize_path(p1), normalize_path(p2));
    }
}
