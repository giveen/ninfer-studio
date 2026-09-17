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
pub fn strip_extended_prefix(p: &str) -> String {
    for pre in ["\\\\?\\", "\\\\?/", "//?/"] {
        if let Some(rest) = p.strip_prefix(pre) {
            for unc in ["UNC\\", "UNC/"] {
                if let Some(tail) = rest.strip_prefix(unc) {
                    return format!("\\\\{}", tail.replace('/', "\\"));
                }
            }
            return rest.to_string();
        }
    }
    p.to_string()
}

/// Basename of a filesystem-ish path (`/a/b/c` -> `c`); whole string when there
/// is no separator. Mirrors the UI's `baseName` for artifact comparison.
pub fn base_name(p: &str) -> &str {
    let trimmed = p.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return p;
    }
    match trimmed.rsplit_once(|c| c == '/' || c == '\\') {
        Some((_, rest)) => rest,
        None => trimmed,
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
