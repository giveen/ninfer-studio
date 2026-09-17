// Rust guideline compliant 2026-07-28

//! Linux sandbox: bubblewrap.
//!
//! The shell runs inside a fresh mount/PID/IPC/UTS namespace where `/` is bind-mounted
//! read-only, `/tmp` is a private tmpfs, the workspace (plus any extra
//! validated writable roots) is read-write, capabilities are dropped, and the PID
//! namespace dies with the parent. Network stays available so builds can
//! fetch. This is a containment boundary for *file writes*, not a network
//! sandbox.

use super::{ExecChild, SpawnReq, is_secret_env_var, shell_quote};
use std::io;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::LazyLock;
use tokio::process::Command;

pub(crate) use super::validate_writable_root;

/// Probe whether bubblewrap is *usable* on this machine (checked once per process).
/// Probes `bwrap` directly without depending on `which` or `/usr/bin/true`.
pub fn available() -> bool {
    static AVAILABLE: LazyLock<bool> = LazyLock::new(|| {
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
            .arg("--unshare-ipc")
            .arg("--unshare-uts")
            .arg("--cap-drop")
            .arg("ALL")
            .arg("--")
            .arg("/bin/sh")
            .arg("-c")
            .arg("true");
        probe.stdout(Stdio::null()).stderr(Stdio::null());
        match probe.output() {
            Ok(o) => o.status.success(),
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::debug!(error = %e, "bwrap probe execution failed");
                }
                false
            }
        }
    });
    *AVAILABLE
}

/// Build the full vector of argument strings passed to `bwrap` for a sandboxed invocation.
pub fn build_bwrap_argv(req: &SpawnReq) -> Vec<String> {
    let mut args = vec![
        "--ro-bind".to_string(),
        "/".to_string(),
        "/".to_string(),
        "--tmpfs".to_string(),
        "/tmp".to_string(),
        "--bind".to_string(),
        req.workspace.to_string_lossy().to_string(),
        req.workspace.to_string_lossy().to_string(),
        "--proc".to_string(),
        "/proc".to_string(),
        "--dev".to_string(),
        "/dev".to_string(),
        "--unshare-pid".to_string(),
        "--unshare-ipc".to_string(),
        "--unshare-uts".to_string(),
        "--die-with-parent".to_string(),
        "--cap-drop".to_string(),
        "ALL".to_string(),
    ];

    for b in &req.writable_roots {
        if let Some(canonical) = validate_writable_root(b) {
            let path_str = canonical.to_string_lossy().to_string();
            args.push("--bind".to_string());
            args.push(path_str.clone());
            args.push(path_str);
        }
    }

    args.push("bash".to_string());
    args
}

/// Build and spawn the shell for one run — wrapped in bubblewrap when
/// `req.sandboxed`, plain `bash -lc` otherwise. Secret-looking environment
/// variables are scrubbed on both paths.
pub fn spawn(req: &SpawnReq) -> io::Result<ExecChild> {
    let (cwd_arg, run_cmd) = if req.sandboxed {
        let cd = if req.cwd == req.workspace {
            String::new()
        } else {
            let cwd_quoted = shell_quote(&req.cwd.to_string_lossy());
            format!("cd {cwd_quoted} 2>/dev/null || echo \"cd to {cwd_quoted} failed\" >&2\n")
        };
        (req.workspace.clone(), format!("{cd}{}", req.command))
    } else {
        (req.cwd.clone(), req.command.clone())
    };

    let mut cmd = if req.sandboxed {
        let mut c = Command::new("bwrap");
        let bwrap_args = build_bwrap_argv(req);
        c.args(&bwrap_args);
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

#[cfg(test)]
mod bwrap_tests {
    use super::*;

    #[test]
    fn validate_writable_root_rejects_danger_roots() {
        assert!(validate_writable_root("/").is_none());
        assert!(validate_writable_root("/etc").is_none());
        assert!(validate_writable_root("/usr").is_none());
        assert!(validate_writable_root("/proc").is_none());
        assert!(validate_writable_root("/non_existent_path_12345").is_none());

        if let Ok(home) = std::env::var("HOME") {
            assert!(validate_writable_root(&home).is_none());
        }

        let temp_dir = std::env::temp_dir();
        let valid_sub = temp_dir.join("ninfier_bwrap_valid_sub_dir");
        let _ = std::fs::create_dir_all(&valid_sub);
        assert!(validate_writable_root(valid_sub.to_str().unwrap()).is_some());
        let _ = std::fs::remove_dir_all(&valid_sub);
    }

    #[test]
    fn bwrap_argv_structure_and_namespaces() {
        let req = SpawnReq {
            command: "echo test".to_string(),
            workspace: PathBuf::from("/tmp"),
            cwd: PathBuf::from("/tmp"),
            sandboxed: true,
            writable_roots: vec!["/".to_string(), "/etc".to_string()],
        };

        let argv = build_bwrap_argv(&req);
        assert_eq!(argv[0], "--ro-bind");
        assert_eq!(argv[1], "/");
        assert_eq!(argv[2], "/");
        assert!(argv.contains(&"--tmpfs".to_string()));
        assert!(argv.contains(&"--unshare-pid".to_string()));
        assert!(argv.contains(&"--unshare-ipc".to_string()));
        assert!(argv.contains(&"--unshare-uts".to_string()));
        assert!(argv.contains(&"--cap-drop".to_string()));

        // Rejected "/" and "/etc" must not appear in --bind arguments
        let bind_indices: Vec<usize> = argv
            .iter()
            .enumerate()
            .filter(|(_, arg)| *arg == "--bind")
            .map(|(idx, _)| idx)
            .collect();
        for idx in bind_indices {
            let target = &argv[idx + 1];
            assert_ne!(target, "/");
            assert_ne!(target, "/etc");
        }
    }

    #[test]
    fn secret_env_patterns_strip_desktop_vars() {
        assert!(is_secret_env_var("DISPLAY"));
        assert!(is_secret_env_var("XAUTHORITY"));
        assert!(is_secret_env_var("WAYLAND_DISPLAY"));
        assert!(is_secret_env_var("DBUS_SESSION_BUS_ADDRESS"));
        assert!(is_secret_env_var("SSH_AUTH_SOCK"));
        assert!(is_secret_env_var("GITHUB_TOKEN"));
        assert!(is_secret_env_var("AWS_SECRET_ACCESS_KEY"));
        assert!(!is_secret_env_var("PATH"));
        assert!(!is_secret_env_var("LANG"));
    }
}
