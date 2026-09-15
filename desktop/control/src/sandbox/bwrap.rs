// Rust guideline compliant 2026-07-28

//! Linux sandbox: bubblewrap.
//!
//! The shell runs inside a fresh mount/PID namespace where `/` is bind-mounted
//! read-only, `/tmp` is a private tmpfs, the workspace (plus any extra
//! writable roots) is read-write, capabilities are dropped, and the PID
//! namespace dies with the parent. Network stays available so builds can
//! fetch. This is a containment boundary for *file writes*, not a network
//! sandbox.

use super::{ExecChild, SpawnReq, is_secret_env_var, shell_quote};
use std::io;
use std::process::Stdio;
use std::sync::LazyLock;
use tokio::process::Command;

/// Whether bubblewrap is *usable* on this machine. Checked once per process:
/// not only must `bwrap` be installed, it must be able to create its
/// namespaces — on kernels or hardened runtimes (e.g. default Docker
/// seccomp) that forbid unprivileged user namespaces, bwrap exits 1 with
/// "No permissions to create a new namespace" on every invocation. Probing
/// with the same namespace flags the wrapper uses means such hosts get the
/// same transparent fallback as hosts without bwrap, instead of every exec
/// failing with a cryptic exit 1; `sandbox_get` also stops claiming the
/// sandbox is available when it actually can't start.
pub fn available() -> bool {
    static AVAILABLE: LazyLock<bool> = LazyLock::new(|| {
        let installed = std::process::Command::new("which")
            .arg("bwrap")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !installed {
            return false;
        }
        // Same namespace/unpriv flags as the wrapper below, minimal binds,
        // trivial payload: if *this* can't start, neither can a real exec.
        let mut probe = std::process::Command::new("bwrap");
        probe
            .arg("--ro-bind")
            .arg("/")
            .arg("/")
            .arg("--tmpfs")
            .arg("/tmp")
            .arg("--proc")
            .arg("/proc")
            .arg("--dev")
            .arg("/dev")
            .arg("--unshare-pid")
            .arg("--cap-drop")
            .arg("ALL")
            .arg("--")
            .arg("/usr/bin/true");
        probe.stdout(Stdio::null()).stderr(Stdio::null());
        probe.output().map(|o| o.status.success()).unwrap_or(false)
    });
    *AVAILABLE
}

/// Build and spawn the shell for one run — wrapped in bubblewrap when
/// `req.sandboxed`, plain `bash -lc` otherwise. Secret-looking environment
/// variables are scrubbed on both paths.
pub fn spawn(req: &SpawnReq) -> io::Result<ExecChild> {
    // Inside the sandbox the child's cwd must already exist in the container.
    // The bind-mounted workspace root is a safe universal cwd; a workspace
    // relative cwd is re-applied with `cd` so the command sees the same
    // starting directory as it would unsandboxed.
    let (cwd_arg, run_cmd) = if req.sandboxed {
        let cd = if req.cwd == req.workspace {
            String::new()
        } else {
            format!(
                "cd {} 2>/dev/null || true\n",
                shell_quote(&req.cwd.to_string_lossy())
            )
        };
        (req.workspace.clone(), format!("{cd}{}", req.command))
    } else {
        (req.cwd.clone(), req.command.clone())
    };
    let mut cmd = if req.sandboxed {
        let mut c = Command::new("bwrap");
        c.arg("--ro-bind").arg("/").arg("/");
        // bwrap layers mounts in argument order — a later mount at a parent
        // path hides an earlier one at a child path. `--tmpfs /tmp` MUST come
        // before the workspace bind: a workspace under /tmp (the common case
        // for temp/scratch dirs) would otherwise be buried under an empty
        // tmpfs and become invisible inside the sandbox.
        c.arg("--tmpfs").arg("/tmp");
        c.arg("--bind").arg(&req.workspace).arg(&req.workspace);
        c.arg("--proc").arg("/proc");
        c.arg("--dev").arg("/dev");
        c.arg("--unshare-pid");
        c.arg("--die-with-parent");
        c.arg("--cap-drop").arg("ALL");
        for b in &req.writable_roots {
            if !b.is_empty() {
                c.arg("--bind").arg(b).arg(b);
            }
        }
        c.arg("bash");
        c
    } else {
        Command::new("bash")
    };
    cmd.arg("-lc")
        .arg(&run_cmd)
        .current_dir(&cwd_arg)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, _) in std::env::vars() {
        if is_secret_env_var(&k) {
            cmd.env_remove(k);
        }
    }
    let child = cmd.spawn()?;
    Ok(ExecChild::Unix(child))
}
