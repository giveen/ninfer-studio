// Rust guideline compliant 2026-07-28

//! Per-OS sandbox for the coder shell runner.
//!
//! One policy knob (`coderSandbox`, default on) with a per-OS mechanism:
//!
//! * **Linux** — bubblewrap (`bwrap`): the root filesystem is bind-mounted
//!   read-only, the workspace (plus any extra roots) read-write, capabilities
//!   dropped. See [`bwrap`].
//! * **Windows** — Job Object + Mandatory Integrity Control: the child tree
//!   lives in a job that kills it atomically, and the child runs at *low*
//!   integrity so the OS refuses its writes to medium-integrity host objects
//!   even where a DACL would allow them. The workspace gets a temporary
//!   write-ACE for the low-integrity SID. See [`windows`].
//!
//! [`spawn`] returns an [`ExecChild`] with a uniform pipe/kill/wait
//! interface so the runner in `coder/exec.rs` stays OS-agnostic.

#[cfg(unix)]
mod bwrap;
#[cfg(windows)]
mod windows;

use std::io;
use std::path::PathBuf;

/// Case-insensitive substrings marking an environment variable as a
/// credential. A `bash` command's text comes from the model, which can be
/// steered by untrusted input (a file or web page it read) — this process's
/// own environment must not be handed to it wholesale, or a var like
/// `GITHUB_TOKEN` already exported in the user's own shell before launch
/// becomes readable/leakable by an agent-run command.
pub(crate) const SECRET_ENV_PATTERNS: [&str; 4] = ["KEY", "SECRET", "TOKEN", "PASSWORD"];

pub(crate) fn is_secret_env_var(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    SECRET_ENV_PATTERNS.iter().any(|p| upper.contains(p))
}

/// Single-quote a script for a POSIX shell (`bash -lc`); embedded single
/// quotes escaped.
pub(crate) fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Everything the runner needs to launch one contained-or-plain shell.
pub struct SpawnReq {
    /// The shell script to run (POSIX syntax; on Windows it is fed to
    /// git-bash, or to `cmd /d /s /c` when no POSIX shell is installed).
    pub command: String,
    /// The workspace root the sandbox exposes read-write.
    pub workspace: PathBuf,
    /// The directory the shell should start in (within the workspace).
    pub cwd: PathBuf,
    /// Contain this run (bwrap on Linux, job + low integrity on Windows).
    pub sandboxed: bool,
    /// Extra read-write roots beyond the workspace (settings `sandboxBinds`):
    /// bwrap `--bind`s them; Windows grants the low-integrity write ACE there.
    pub writable_roots: Vec<String>,
}

/// A running shell child, regardless of which mechanism spawned it.
pub enum ExecChild {
    Unix(tokio::process::Child),
    #[cfg(windows)]
    Windows(windows::WinChild),
}

/// tokio 1.53's `ChildStdout/Stderr` have no `into_std()` — the pipe's
/// underlying handle is exposed as `OwnedFd` (Unix) / `OwnedHandle`
/// (Windows), both of which convert into a `File`.
fn take_unix_stdio(stdio: &mut Option<tokio::process::ChildStdout>) -> Option<std::fs::File> {
    let pipe = stdio.take()?;
    #[cfg(unix)]
    let owned = pipe.into_owned_fd().ok()?;
    #[cfg(not(unix))]
    let owned = pipe.into_owned_handle().ok()?;
    Some(std::fs::File::from(owned))
}

fn take_unix_stderr(stdio: &mut Option<tokio::process::ChildStderr>) -> Option<std::fs::File> {
    let pipe = stdio.take()?;
    #[cfg(unix)]
    let owned = pipe.into_owned_fd().ok()?;
    #[cfg(not(unix))]
    let owned = pipe.into_owned_handle().ok()?;
    Some(std::fs::File::from(owned))
}

impl ExecChild {
    /// Take the stdout pipe (as a raw `File`, async-capable on both OSes).
    pub fn take_stdout(&mut self) -> Option<std::fs::File> {
        match self {
            Self::Unix(c) => take_unix_stdio(&mut c.stdout),
            #[cfg(windows)]
            Self::Windows(w) => w.take_stdout(),
        }
    }

    /// Take the stderr pipe.
    pub fn take_stderr(&mut self) -> Option<std::fs::File> {
        match self {
            Self::Unix(c) => take_unix_stderr(&mut c.stderr),
            #[cfg(windows)]
            Self::Windows(w) => w.take_stderr(),
        }
    }

    /// Kill the whole process tree (`SIGKILL` / `TerminateJobObject`).
    pub fn start_kill(&mut self) {
        match self {
            Self::Unix(c) => {
                let _ = c.start_kill();
            }
            #[cfg(windows)]
            Self::Windows(w) => w.start_kill(),
        }
    }

    /// Wait for exit. Resolves to the exit code, or -1 when the child died
    /// without one (e.g. signal-killed on Linux).
    pub async fn wait(&mut self) -> Result<i32, io::Error> {
        match self {
            Self::Unix(c) => {
                let st = c.wait().await?;
                Ok(st.code().unwrap_or(-1))
            }
            #[cfg(windows)]
            Self::Windows(w) => w.wait().await,
        }
    }
}

/// Spawn the shell for one run, contained or not (see module docs).
pub fn spawn(req: &SpawnReq) -> io::Result<ExecChild> {
    #[cfg(unix)]
    {
        bwrap::spawn(req)
    }
    #[cfg(windows)]
    {
        windows::spawn(req)
    }
}

/// Whether the sandbox mechanism is *usable* on this machine. On Windows the
/// mechanism is OS-native (always true); on Linux bwrap must be installed
/// *and* able to create its namespaces (see [`bwrap::available`]).
pub fn available() -> bool {
    #[cfg(unix)]
    {
        bwrap::available()
    }
    #[cfg(windows)]
    {
        true
    }
}

/// Human-facing name of the active mechanism (`"bwrap"` / `"windows-job-mic"`).
pub fn policy() -> &'static str {
    #[cfg(unix)]
    {
        "bwrap"
    }
    #[cfg(windows)]
    {
        "windows-job-mic"
    }
}

/// Windows-only: is a POSIX shell (git-bash) on PATH? Stateful sessions (cwd
/// tracking via a marker) require one; the `cmd` fallback is stateless.
#[cfg(windows)]
pub fn shell_is_bash() -> bool {
    windows::shell_is_bash()
}

/// `ExecChild` moves to another runtime thread (the background-job drain
/// task in `coder/exec.rs` calls `tokio::spawn` on it) — keep it `Send`.
/// Compile-time guard so a future non-`Send` field fails the build instead
/// of the (Windows-only) drain path at runtime.
struct SendCheck<T>(T);
impl<T: Send> SendCheck<T> {
    const IS_SEND: () = ();
}
const _EXEC_CHILD_MUST_BE_SEND: () = SendCheck::<ExecChild>::IS_SEND;
