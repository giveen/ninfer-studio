//! Plan-mode bash guard — the server port of the client's `isReadOnlyCommand`.
//!
//! Keeps the risky-command allow-list and shell-operator detection out of the
//! main dispatch file so the table can be audited in isolation.

use regex::Regex;

const READONLY_BASH: &[&str] = &[
    "find",
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "grep",
    "rg",
    "fd",
    "file",
    "stat",
    "du",
    "df",
    "tree",
    "pwd",
    "which",
    "uname",
    "date",
    "sort",
    "uniq",
    "diff",
    "nl",
    "basename",
    "dirname",
    "realpath",
    "readlink",
    "md5sum",
    "sha256sum",
];
/// Read-only git subcommands allowed in plan mode.
const READONLY_GIT: &[&str] = &[
    "status",
    "log",
    "diff",
    "show",
    "branch",
    "tag",
    "remote",
    "blame",
    "shortlog",
    "describe",
    "ls-files",
    "rev-parse",
];

static RE_SHELL_CONTROL: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

/// Redirection, pipes, chaining, command substitution, or a paren group make
/// a command non-inspection.
fn re_shell_control() -> &'static Regex {
    RE_SHELL_CONTROL.get_or_init(|| Regex::new(r#"[>|;&`\(]"#).expect("static regex"))
}

/// Would this shell command only inspect state? (The client's
/// `isReadOnlyCommand`, ported: no shell operators, and the first word is an
/// inspection tool — or `git` + a read-only subcommand.)
pub(crate) fn is_read_only_command(cmd: &str) -> bool {
    let cmd = cmd.trim();
    if cmd.is_empty() || re_shell_control().is_match(cmd) {
        return false;
    }
    let toks: Vec<&str> = cmd.split_whitespace().collect();
    let first = toks[0];
    if first == "git" {
        return toks.get(1).is_some_and(|s| READONLY_GIT.contains(s));
    }
    READONLY_BASH.contains(&first)
}
