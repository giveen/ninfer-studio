//! Small string/path/time helpers shared across the control plane.

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
    match p.rsplit_once('/') {
        Some((_, rest)) => rest,
        None => p,
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

