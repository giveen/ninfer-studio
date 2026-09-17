//! HITL approval + risky/commit gate machinery — pausing and resuming runs.
//!
//! The HTTP handlers that *resolve* these gates live in `run.rs`; this module
//! owns the waiter side (the `await_*` futures that the dispatch loop calls).
//! Keeping them separate from the tool dispatch table means the gate logic can
//! be read and audited independently of the tool routing.

use crate::agent::run::{
    AgentEvent, ApprovalDecision, GateDecision, GateKind, GateSlot, PendingApproval, PendingGate,
    PendingQuestion, RunShared, RunStatus, now_ms,
};
use crate::engine::S;
use regex::Regex;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::oneshot;

pub(crate) const GATE_TIMEOUT: Duration = Duration::from_secs(300);
static GATE_COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_gate_id(prefix: &str) -> String {
    format!("{prefix}_{}_{}", now_ms(), GATE_COUNTER.fetch_add(1, Ordering::Relaxed))
}

// ---------------------------------------------------------------------------
// Approval gate
// ---------------------------------------------------------------------------

/// Pause the run on an `ask`-tier tool and wait for a client's decision.
/// Returns the one-shot approval token on approval, `None` on denial or stop.
pub(crate) async fn await_approval(
    run: &Arc<RunShared>,
    name: &str,
    args: &Value,
) -> Option<String> {
    let aid = next_gate_id("appr");
    let rel = rel_detail(name, args);
    let preview: String = serde_json::to_string(args)
        .unwrap_or_default()
        .chars()
        .take(400)
        .collect();

    let (tx, rx) = oneshot::channel();
    run.approvals
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(aid.clone(), tx);
    {
        let mut live = run.live.lock().unwrap_or_else(|p| p.into_inner());
        live.pending_approvals.push(PendingApproval {
            id: aid.clone(),
            tool: name.into(),
            rel: rel.clone(),
            args: preview.clone(),
            asked_at: now_ms(),
        });
    }
    run.set_status(RunStatus::AwaitingApproval);
    let _ = run.tx.send(AgentEvent::ApprovalRequested {
        id: aid.clone(),
        tool: name.into(),
        rel: rel.clone(),
        args: preview,
    });

    let decision = tokio::select! {
        d = rx => d.unwrap_or(ApprovalDecision::Denied),
        _ = tokio::time::sleep(GATE_TIMEOUT) => {
            run.approvals.lock().unwrap_or_else(|p| p.into_inner()).remove(&aid);
            let mut live = run.live.lock().unwrap_or_else(|p| p.into_inner());
            live.pending_approvals.retain(|p| p.id != aid);
            return None;
        }
        _ = run.wait_stop() => {
            run.approvals.lock().unwrap_or_else(|p| p.into_inner()).remove(&aid);
            let mut live = run.live.lock().unwrap_or_else(|p| p.into_inner());
            live.pending_approvals.retain(|p| p.id != aid);
            return None;
        }
    };
    {
        let mut live = run.live.lock().unwrap_or_else(|p| p.into_inner());
        live.pending_approvals.retain(|p| p.id != aid);
    }
    match decision {
        ApprovalDecision::Approved { token } => token,
        ApprovalDecision::Denied => None,
    }
}

/// The dialog-worthy detail for a tool: a path, url, query, or command.
pub(crate) fn rel_detail(name: &str, args: &Value) -> Option<String> {
    let get = |k: &str| args.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
    match name {
        "read" | "write" | "edit" | "apply_patch" | "udiff_edit" | "memory" => get("path"),
        "grep" | "glob" => get("pattern"),
        "web_fetch" | "browser" => get("url"),
        "web_search" | "repo_search" => get("query"),
        "bash" | "ast_grep" | "git_commit" => get("command")
            .or_else(|| get("pattern"))
            .or_else(|| get("message")),
        "delegate" | "subagent" => get("prompt")
            .or_else(|| get("role"))
            .or_else(|| get("agent")),
        "git_branch" | "git_worktree" => get("name")
            .or_else(|| get("branch"))
            .or_else(|| get("path")),
        "todo_write" => get("task").or_else(|| get("title")),
        "memory_update" => get("content").or_else(|| get("key")),
        _ => get("path")
            .or_else(|| get("url"))
            .or_else(|| get("query"))
            .or_else(|| get("command")),
    }
}

/// The `ask_user` tool: pause the run for a human answer. The answer becomes
/// the tool result.
pub(crate) async fn ask_user(run: &Arc<RunShared>, args: &Value) -> Value {
    let question = args
        .get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if question.is_empty() {
        return json!({ "error": "question is required" });
    }
    {
        let live = run.live.lock().unwrap_or_else(|p| p.into_inner());
        if live.user_question.is_some() {
            return json!({ "error": "another user question is already pending" });
        }
    }
    let qid = next_gate_id("q");
    let (tx, rx) = oneshot::channel();
    *run.question_tx.lock().unwrap_or_else(|p| p.into_inner()) = Some(tx);
    {
        let mut live = run.live.lock().unwrap_or_else(|p| p.into_inner());
        live.user_question = Some(PendingQuestion {
            id: qid.clone(),
            question: question.clone(),
            asked_at: now_ms(),
        });
    }
    run.set_status(RunStatus::AwaitingUser);
    let _ = run.tx.send(AgentEvent::UserQuestionRequested {
        id: qid.clone(),
        question: question.clone(),
    });

    let answer = tokio::select! {
        a = rx => a.unwrap_or_default(),
        _ = tokio::time::sleep(GATE_TIMEOUT) => {
            let mut live = run.live.lock().unwrap_or_else(|p| p.into_inner());
            live.user_question = None;
            *run.question_tx.lock().unwrap_or_else(|p| p.into_inner()) = None;
            return json!({ "error": "timed out waiting for user response (5 minutes)" });
        }
        _ = run.wait_stop() => {
            let mut live = run.live.lock().unwrap_or_else(|p| p.into_inner());
            live.user_question = None;
            *run.question_tx.lock().unwrap_or_else(|p| p.into_inner()) = None;
            return json!({ "error": "run stopped while waiting for the user" });
        }
    };
    let mut live = run.live.lock().unwrap_or_else(|p| p.into_inner());
    live.user_question = None;
    *run.question_tx.lock().unwrap_or_else(|p| p.into_inner()) = None;
    drop(live);
    Value::String(answer)
}

// ---------------------------------------------------------------------------
// Risky-command + commit-approval gates
// ---------------------------------------------------------------------------

static RISKY_PATTERNS_SRC: &[(&str, &str)] = &[
    (
        r"(?i)\bgit\s+push\b(?s:.*?)(--force|-f\b|--delete)\b",
        "force-pushes or deletes remote refs",
    ),
    (r"(?i)\bgit\s+push\b", "pushes commits to a remote"),
    (
        r"(?i)\b(npm|pnpm|yarn)\s+publish\b",
        "publishes a package to a registry",
    ),
    (r"(?i)\bcargo\s+publish\b", "publishes a crate"),
    (r"(?i)\btwine\s+upload\b", "uploads a release to PyPI"),
    (
        r"(?i)\bgh\s+(pr|release|api)\b",
        "creates a GitHub release/PR via gh",
    ),
    (
        r"(?i)\b(sudo|su|doas)\b",
        "runs a command as another user (root)",
    ),
    (
        r"(?i)\bssh(?:[^-\w]|$)",
        "opens an SSH connection to a remote host",
    ),
    (
        r"(?i)\b(scp|rsync|sftp)\b",
        "transfers files to/from a remote host",
    ),
    (r"(?i)\b(docker|podman)\b", "runs containers"),
    (
        r"(?i)\b(kubectl|helm|terraform\s+apply|ansible)\b",
        "applies infrastructure changes",
    ),
    (
        r"(?i)\b(aws|gcloud|az)\b(?s:.*?)\b(ec2|s3|deploy|apply|create|delete|update|push)\b",
        "mutates cloud resources",
    ),
    (
        r"(?i)\b(apt|apt-get|yum|dnf|apk)\b\s+(install|remove|upgrade|update)\b",
        "changes system packages",
    ),
    (
        r"(?i)\b(npm\s+install\s+-g|pnpm\s+add\s+-g|yarn\s+global\s+add)\b",
        "installs a global package",
    ),
    (
        r"(?i)\brm\s+-[rRf]*[rf][rRf]*\b",
        "recursively deletes directories or files",
    ),
    (
        r"(?i)\b(mkfs|fdisk|parted|dd\s+if=)\b",
        "formats or overwrites disk partitions",
    ),
];

static RISKY_PATTERNS: std::sync::LazyLock<Vec<(Regex, &'static str)>> =
    std::sync::LazyLock::new(|| {
        RISKY_PATTERNS_SRC
            .iter()
            .map(|(re, why)| (Regex::new(re).expect("static risky pattern"), *why))
            .collect()
    });

/// First matching risky reason, or `None` (the client's `detectRisky`).
pub(crate) fn detect_risky(cmd: &str) -> Option<&'static str> {
    RISKY_PATTERNS
        .iter()
        .find(|(re, _)| re.is_match(cmd))
        .map(|(_, why)| *why)
}

static GIT_COMMIT_RE: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"\bcommit\b").expect("static git commit regex"));

/// Cheap guard for the commit-approval gate (the client's
/// `isGitCommitCommand`, ported).
pub(crate) fn is_git_commit_command(cmd: &str) -> bool {
    let c = cmd.trim_start();
    let c = ["sudo ", "env ", "time ", "setsid ", "nice "]
        .iter()
        .find_map(|p| c.strip_prefix(p))
        .unwrap_or(c)
        .trim_start();
    let Some(rest) = c.strip_prefix("git") else {
        return false;
    };
    if !rest
        .chars()
        .next()
        .is_none_or(|ch| !(ch.is_alphanumeric() || ch == '_' || ch == '-'))
    {
        return false;
    }
    GIT_COMMIT_RE.is_match(c)
}

/// Approved-command matching (the client's `isApprovedCommand`, ported).
pub(crate) fn is_approved_command(cmd: &str, approved: &[String]) -> bool {
    let c = crate::agent::run::normalize_command(cmd);
    approved.iter().any(|a| {
        let na = crate::agent::run::normalize_command(a);
        c == na || c.starts_with(&format!("{na} "))
    })
}

/// Pause the run on a risky/commit gate and wait for a client's decision.
/// Returns how to proceed; `Deny` on denial, stop, or a second concurrent
/// pause on the same run.
pub(crate) async fn await_gate(
    run: &Arc<RunShared>,
    kind: GateKind,
    command: String,
    reason: Option<String>,
) -> GateDecision {
    let gid = next_gate_id("gate");
    let (tx, rx) = oneshot::channel();
    {
        let mut gs = run.gate_state.lock().unwrap_or_else(|p| p.into_inner());
        if gs.slot.is_some() {
            return GateDecision::Deny;
        }
        gs.slot = Some(GateSlot {
            pending: PendingGate {
                id: gid.clone(),
                kind,
                command: command.clone(),
                reason: reason.clone(),
            },
            tx,
        });
    }
    run.set_status(RunStatus::AwaitingGate);
    let _ = run.tx.send(AgentEvent::GateRequested {
        id: gid.clone(),
        kind,
        command,
        reason,
    });
    let decision = tokio::select! {
        d = rx => d.unwrap_or(GateDecision::Deny),
        _ = tokio::time::sleep(GATE_TIMEOUT) => {
            run.gate_state.lock().unwrap_or_else(|p| p.into_inner()).slot = None;
            return GateDecision::Deny;
        }
        _ = run.wait_stop() => {
            run.gate_state.lock().unwrap_or_else(|p| p.into_inner()).slot = None;
            return GateDecision::Deny;
        }
    };
    decision
}

/// Ancestor-chain length of a run. Mirrors the client's `depth > 5`
/// subagent guard so a model can't nest delegate/subagent runs without bound.
pub(crate) fn run_depth(state: &S, run: &Arc<RunShared>) -> usize {
    let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
    let mut depth = 0;
    let mut cur = run.meta.parent.clone();
    while let Some(pid) = cur {
        depth += 1;
        if depth > 8 {
            break;
        }
        cur = runs.get(&pid).and_then(|r| r.meta.parent.clone());
    }
    depth
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_risky() {
        assert!(detect_risky("git push origin main --force").is_some());
        assert!(detect_risky("sudo rm -rf /").is_some());
        assert!(detect_risky("mkfs.ext4 /dev/sdb1").is_some());
        assert!(detect_risky("cargo build").is_none());
    }

    #[test]
    fn test_is_git_commit_command() {
        assert!(is_git_commit_command("git commit -m 'feat: init'"));
        assert!(is_git_commit_command("sudo git commit -m 'fix'"));
        assert!(!is_git_commit_command("git status"));
        assert!(!is_git_commit_command("giti commit"));
    }

    #[test]
    fn test_rel_detail() {
        let val = json!({"path": "/foo/bar.txt"});
        assert_eq!(rel_detail("read", &val), Some("/foo/bar.txt".into()));

        let delegate_val = json!({"prompt": "Do task"});
        assert_eq!(rel_detail("delegate", &delegate_val), Some("Do task".into()));
    }

    #[test]
    fn test_next_gate_id_uniqueness() {
        let id1 = next_gate_id("test");
        let id2 = next_gate_id("test");
        assert_ne!(id1, id2);
    }
}
