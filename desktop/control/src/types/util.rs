use std::borrow::Cow;

/// Strip the Windows extended-length prefix (`\\?\` or `//?/`) that
/// `std::fs::canonicalize` adds to most absolute paths on Windows, so the
/// stored workspace string matches the plain form the UI's directory picker
/// produces (`C:\tmp`, not `\\?\C:\tmp`) — otherwise the web store (keyed
/// by the plain path) can't find the persisted workspace on the next start
/// and spawns a duplicate entry with a fresh conversation.
///
/// UNC paths need care: canonicalize yields `\\?\UNC\server\share`, and a
/// bare `UNC\server\share` would be a *relative* path — so the leading UNC
/// separators are restored and the tail is normalized to backslashes.
pub fn strip_extended_prefix(p: &str) -> Cow<'_, str> {
    for pre in ["\\\\?\\", "\\\\?/", "//?/"] {
        if let Some(rest) = p.strip_prefix(pre) {
            if rest.len() >= 4
                && rest[..3].eq_ignore_ascii_case("UNC")
                && (rest.as_bytes()[3] == b'\\' || rest.as_bytes()[3] == b'/')
            {
                return Cow::Owned(format!("\\\\{}", rest[4..].replace('/', "\\")));
            }
            return Cow::Borrowed(rest);
        }
    }
    if let Some(rest) = p.strip_prefix("\\\\.\\") {
        return Cow::Borrowed(rest);
    }
    Cow::Borrowed(p)
}

/// Basename of a filesystem-ish path (`/a/b/c` -> `c`); whole string when there
/// is no separator. Mirrors the UI's `baseName` for artifact comparison.
pub fn base_name(p: &str) -> &str {
    let trimmed = p.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        if p.is_empty() {
            return "(root)";
        }
        return p;
    }
    match trimmed.rsplit_once(|c| c == '/' || c == '\\') {
        Some((_, rest)) if !rest.is_empty() => rest,
        _ => trimmed,
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_base_name() {
        let cases = [
            ("/a/b/model.ninfer", "model.ninfer"),
            ("C:\\models\\x.ninfer", "x.ninfer"),
            ("C:\\models\\folder\\", "folder"),
            ("/a/b/c/", "c"),
            ("model.ninfer", "model.ninfer"),
            ("", "(root)"),
            ("/", "/"),
            ("\\", "\\"),
        ];
        for (input, expected) in cases {
            assert_eq!(base_name(input), expected, "base_name({input:?})");
        }
    }

    #[test]
    fn test_strip_extended_prefix() {
        let cases = [
            ("\\\\?\\C:\\tmp", "C:\\tmp"),
            ("\\\\?/C:/tmp", "C:/tmp"),
            ("//?/C:/tmp", "C:/tmp"),
            ("\\\\?\\UNC\\server\\share", "\\\\server\\share"),
            ("\\\\?/UNC/server/share", "\\\\server\\share"),
            ("\\\\?\\unc\\server\\share", "\\\\server\\share"),
            ("\\\\?\\unc/server/share", "\\\\server\\share"),
            ("\\\\?\\Volume{1234-5678}\\path", "Volume{1234-5678}\\path"),
            ("\\\\.\\pipe\\foo", "pipe\\foo"),
            ("C:\\tmp", "C:\\tmp"),
            ("/home/dev/x", "/home/dev/x"),
            ("", ""),
        ];
        for (input, expected) in cases {
            assert_eq!(
                strip_extended_prefix(input),
                expected,
                "strip_extended_prefix({input:?})"
            );
        }
    }
}

