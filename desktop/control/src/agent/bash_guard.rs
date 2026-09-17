//! Plan-mode bash guard — the server port of the client's `is_read_only_command`.
//!
//! Keeps the risky-command allow-list and shell-operator detection out of the
//! main dispatch file so the table can be audited in isolation.

use regex::Regex;
use std::sync::LazyLock;

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
/// Note: branch, tag, and remote are omitted because they write/mutate state
/// when passed flags or arguments.
const READONLY_GIT: &[&str] = &[
    "status",
    "log",
    "diff",
    "show",
    "blame",
    "shortlog",
    "describe",
    "ls-files",
    "rev-parse",
];

static RE_SHELL_CONTROL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[>|;&`\(\n\r]"#).expect("static regex"));

/// Would this shell command only inspect state? (The client's
/// `is_read_only_command`, ported: no shell operators or newlines, path prefixes
/// stripped, and the first word is an inspection tool with dangerous write/exec
/// flags rejected — or `git` + a read-only subcommand.)
/// Note: Command splitting uses `split_whitespace()` which is not shell-quote aware;
/// this is intentionally conservative so tricky quoting is rejected or safe.
pub(crate) fn is_read_only_command(cmd: &str) -> bool {
    let cmd = cmd.trim();
    if cmd.is_empty() || cmd.contains(['\n', '\r']) || RE_SHELL_CONTROL.is_match(cmd) {
        return false;
    }
    let toks: Vec<&str> = cmd.split_whitespace().collect();
    if toks.is_empty() {
        return false;
    }

    // Strip directory path prefix from command (e.g. /bin/ls -> ls)
    let raw_first = toks[0];
    let first = raw_first
        .rsplit('/')
        .next()
        .unwrap_or(raw_first)
        .rsplit('\\')
        .next()
        .unwrap_or(raw_first);

    if first == "git" {
        let sub = match toks.get(1) {
            Some(&s) => s,
            None => return false,
        };
        if !READONLY_GIT.contains(&sub) {
            return false;
        }
        if sub == "diff" && toks.iter().any(|t| t.starts_with("--output")) {
            return false;
        }
        return true;
    }

    if !READONLY_BASH.contains(&first) {
        return false;
    }

    match first {
        "find" => {
            if toks
                .iter()
                .any(|t| matches!(*t, "-delete" | "-exec" | "-execdir" | "-ok" | "-okdir"))
            {
                return false;
            }
        }
        "fd" => {
            if toks
                .iter()
                .any(|t| matches!(*t, "-x" | "-X" | "--exec" | "--exec-batch"))
            {
                return false;
            }
        }
        "rg" => {
            if toks.iter().any(|t| t.starts_with("--pre")) {
                return false;
            }
        }
        "sort" => {
            if toks.iter().any(|t| *t == "-o" || t.starts_with("--output")) {
                return false;
            }
        }
        "uniq" => {
            let non_flags = toks[1..].iter().filter(|t| !t.starts_with('-')).count();
            if non_flags >= 2 {
                return false;
            }
        }
        _ => {}
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_only_commands_allowed() {
        assert!(is_read_only_command("ls -la"));
        assert!(is_read_only_command("cat package.json"));
        assert!(is_read_only_command("head -n 20 src/index.ts"));
        assert!(is_read_only_command("git status"));
        assert!(is_read_only_command("git log -n 5"));
        assert!(is_read_only_command("git diff"));
        assert!(is_read_only_command("/bin/ls -la"));
        assert!(is_read_only_command("/usr/bin/cat file"));
    }

    #[test]
    fn test_mutating_or_dangerous_commands_rejected() {
        assert!(!is_read_only_command("rm -rf /tmp/foo"));
        assert!(!is_read_only_command("git commit -m \"feat\""));
        assert!(!is_read_only_command("pnpm build"));
        assert!(!is_read_only_command("git branch -D feature"));
        assert!(!is_read_only_command("git tag -a v1.0"));
        assert!(!is_read_only_command("git remote add origin url"));
    }

    #[test]
    fn test_shell_control_and_newlines_rejected() {
        assert!(!is_read_only_command("cat foo > bar"));
        assert!(!is_read_only_command("ls | grep ts"));
        assert!(!is_read_only_command("ls; rm -rf /"));
        assert!(!is_read_only_command("echo $(whoami)"));
        assert!(!is_read_only_command("echo `whoami`"));
        assert!(!is_read_only_command("ls && rm -rf /"));
        assert!(!is_read_only_command("ls\nrm -rf ."));
        assert!(!is_read_only_command("cat file\r\nrm -rf ."));
    }

    #[test]
    fn test_allow_listed_flags_that_write_or_exec_rejected() {
        assert!(!is_read_only_command("find . -delete"));
        assert!(!is_read_only_command("find . -exec rm {} +"));
        assert!(!is_read_only_command("find . -execdir rm {} \\;"));
        assert!(!is_read_only_command("find . -ok rm {} \\;"));
        assert!(!is_read_only_command("fd foo -x rm"));
        assert!(!is_read_only_command("fd foo --exec-batch rm"));
        assert!(!is_read_only_command("rg foo --pre ./script"));
        assert!(!is_read_only_command("sort input.txt -o output.txt"));
        assert!(!is_read_only_command("sort input.txt --output=output.txt"));
        assert!(is_read_only_command("uniq input.txt"));
        assert!(!is_read_only_command("uniq input.txt output.txt"));
        assert!(!is_read_only_command("git diff --output=patch.diff"));
    }
}

