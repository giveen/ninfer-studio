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

use std::fmt;
use std::io;
use std::path::PathBuf;

/// Case-insensitive substrings marking an environment variable as a
/// credential. A `bash` command's text comes from the model, which can be
/// steered by untrusted input (a file or web page it read) — this process's
/// own environment must not be handed to it wholesale, or a var like
/// `GITHUB_TOKEN` already exported in the user's own shell before launch
/// becomes readable/leakable by an agent-run command.
pub(crate) const SECRET_ENV_PATTERNS: &[&str] = &[
    "KEY",
    "SECRET",
    "TOKEN",
    "PASSWORD",
    "DISPLAY",
    "XAUTHORITY",
    "WAYLAND_DISPLAY",
    "DBUS_SESSION_BUS_ADDRESS",
    "SSH_AUTH_SOCK",
    "CREDENTIALS",
    "COOKIE",
    "SESSION",
    "GIT_ASKPASS",
];

pub(crate) fn is_secret_env_var(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    SECRET_ENV_PATTERNS.iter().any(|p| upper.contains(p))
}

/// Single-quote a script for a POSIX shell (`bash -lc`); embedded single
/// quotes escaped.
pub(crate) fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Quote one argument for a `CreateProcessW` command line (MSVCRT rules):
/// unquoted when safe, otherwise quoted with internal `"` encoded so the
/// UCRT argv parser (`2N` backslashes + `"` → N + toggle; `2N+1` → N +
/// literal `"`) reproduces the argument byte-for-byte. Pure string logic —
/// kept out of the `cfg(windows)` module so its round-trip is testable (and
/// tested) on every platform's CI.
#[cfg(any(windows, test))]
pub(crate) fn arg_quote(s: &str) -> String {
    if s.is_empty() {
        return "\"\"".to_string();
    }
    if s.bytes()
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

/// Everything the runner needs to launch one contained-or-plain shell.
#[derive(Debug)]
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

/// Opaque by design — the child's OS process handles must not leak into
/// logs or status payloads.
impl fmt::Debug for ExecChild {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match self {
            Self::Unix(_) => "unix",
            #[cfg(windows)]
            Self::Windows(_) => "windows",
        };
        f.debug_struct("ExecChild").field("kind", &kind).finish()
    }
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

#[cfg(test)]
mod send_check {
    use super::ExecChild;

    /// `ExecChild` moves to another runtime thread (the background-job drain
    /// task in `coder/exec.rs` calls `tokio::spawn` on it) — it must stay
    /// `Send`, or the drain path (Windows-only in practice, but the enum
    /// compiles everywhere) fails at the `tokio::spawn` site. Compile-time
    /// assertion, executed by `cargo test` on every platform.
    fn assert_send<T: Send>() {}

    #[test]
    fn exec_child_is_send() {
        assert_send::<ExecChild>();
    }
}

#[cfg(test)]
mod quoting_tests {
    use super::arg_quote;

    /// One-argument scan of the UCRT argv parser, line-for-line from
    /// `parse_command_line` in UCRT `src/ucrt/startup/argv_parsing.cpp`
    /// (wide-char variant; DBCS trail-byte handling is a no-op there). This
    /// is the model the round-trip test checks `arg_quote` against — a
    /// faithful copy of what `bash.exe` does to the `CreateProcessW` command
    /// line.
    fn msvcrt_parse_arg(encoded: &str) -> String {
        let b: Vec<u8> = encoded.as_bytes().to_vec();
        let mut out = String::new();
        let mut in_quotes = false;
        let mut i = 0usize;
        // The parser skips leading whitespace before each argument.
        while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
            i += 1;
        }
        if i >= b.len() {
            return out;
        }
        loop {
            let mut copy_character = true;
            let mut numslash = 0usize;
            while i < b.len() && b[i] == b'\\' {
                i += 1;
                numslash += 1;
            }
            if i < b.len() && b[i] == b'"' {
                if numslash.is_multiple_of(2) {
                    // `""` inside a quoted string is a literal `"` (the UCRT
                    // special case); `arg_quote` never relies on it — it
                    // always emits an odd backslash run before a literal
                    // `"` — but the model must still match reality.
                    if in_quotes && i + 1 < b.len() && b[i + 1] == b'"' {
                        i += 1; // skip the partner quote
                    } else {
                        copy_character = false;
                        in_quotes = !in_quotes;
                    }
                }
                numslash /= 2;
            }
            for _ in 0..numslash {
                out.push('\\');
            }
            if i >= b.len() || (!in_quotes && (b[i] == b' ' || b[i] == b'\t')) {
                break;
            }
            if copy_character {
                out.push(b[i] as char);
            }
            i += 1;
        }
        out
    }

    #[test]
    fn arg_quoting_encodes_the_msvcrt_rules() {
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
    fn arg_quoting_round_trips_through_the_ucrt_parser() {
        // `windows::command_line(Bash, s)` == `bash -lc ` + `arg_quote(s)`,
        // and the sole argument after `-lc` is exactly `arg_quote(s)` — so
        // proving `arg_quote` inverts the UCRT argv parser proves bash
        // receives the script byte-for-byte. (This test runs on every
        // platform; the quoting is pure logic, only its use is Windows-only.)
        for script in [
            "ls",
            "",
            "echo hi",
            "cd 'dir with space' && echo done",
            r#"echo \"literal quotes\""#,
            r"echo a\ b",
            r"echo trail\",
            r#"echo \"x\" && echo y"#,
            "grep -r \"'single' and \\\"double\\\"\" .",
            "echo $HOME && echo `id`",
            "printf '%s\\n' line1 line2",
        ] {
            let encoded = arg_quote(script);
            let parsed = msvcrt_parse_arg(&encoded);
            assert_eq!(
                parsed, script,
                "bash would receive {parsed:?} instead of {script:?} (encoded: {encoded:?})"
            );
        }
    }
}
