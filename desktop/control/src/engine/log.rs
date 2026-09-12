//! Per-port engine log files + size-cap rotation.

pub fn log_path_for(data_dir: &std::path::Path, port: u16) -> String {
    data_dir
        .join(format!("engine-{port}.log"))
        .to_string_lossy()
        .to_string()
}

/// Cap on-disk engine log growth. The file is opened in append mode and
/// piped the engine's stdout+stderr for its whole run, and that same file
/// persists across restarts (never truncated), so a long-lived install would
/// otherwise grow it forever — the engine logs a throughput line every
/// `--log-stats-interval-ms` (default 5s) even at idle.
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;
const LOG_KEEP_TAIL_BYTES: u64 = 2 * 1024 * 1024;

/// If the engine log at `path` is already over the size cap, rewrite it down
/// to just its last `LOG_KEEP_TAIL_BYTES` (trimmed to a clean line boundary)
/// instead of leaving it to grow unbounded. Called right before each start,
/// so the cap is enforced once per engine launch rather than continuously.
pub async fn rotate_log_if_large(path: &str) {
    let Ok(md) = tokio::fs::metadata(path).await else {
        return;
    };
    if md.len() <= MAX_LOG_BYTES {
        return;
    }
    let path = path.to_string();
    let _ = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        use std::io::{Read, Seek, SeekFrom, Write};
        let mut f = std::fs::File::open(&path)?;
        let len = f.metadata()?.len();
        let start = len.saturating_sub(LOG_KEEP_TAIL_BYTES);
        f.seek(SeekFrom::Start(start))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        // Drop a leading partial line so the kept tail starts cleanly.
        if let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            buf.drain(..=nl);
        }
        let mut out = std::fs::File::create(&path)?; // truncates in place
        out.write_all(b"--- log truncated: earlier entries removed to cap file size ---\n")?;
        out.write_all(&buf)?;
        Ok(())
    })
    .await;
}

#[cfg(test)]
mod log_rotation_tests {
    use super::{rotate_log_if_large, LOG_KEEP_TAIL_BYTES, MAX_LOG_BYTES};

    fn tmp_log(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ninfier-logrotate-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir.join(name)
    }

    #[tokio::test]
    async fn leaves_a_small_log_untouched() {
        let path = tmp_log("small.log");
        std::fs::write(&path, "line one\nline two\n").unwrap();
        rotate_log_if_large(path.to_str().unwrap()).await;
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "line one\nline two\n");
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn caps_a_large_log_to_its_tail() {
        let path = tmp_log("large.log");
        // Build a log well past MAX_LOG_BYTES out of numbered, easily
        // recognizable lines so we can verify the kept content is really the
        // tail and nothing from the dropped head survives.
        let line = "x".repeat(100);
        let target = MAX_LOG_BYTES + LOG_KEEP_TAIL_BYTES; // guarantee rotation fires
        let mut body = String::new();
        let mut i: u64 = 0;
        while (body.len() as u64) < target {
            body.push_str(&format!("{i} {line}\n"));
            i += 1;
        }
        let last_line_no = i - 1;
        std::fs::write(&path, &body).unwrap();
        let original_len = std::fs::metadata(&path).unwrap().len();
        assert!(original_len > MAX_LOG_BYTES, "test setup should exceed the cap");

        rotate_log_if_large(path.to_str().unwrap()).await;

        let new_len = std::fs::metadata(&path).unwrap().len();
        assert!(new_len < original_len, "rotation should shrink the file");
        assert!(new_len <= LOG_KEEP_TAIL_BYTES + 200, "kept tail should be close to LOG_KEEP_TAIL_BYTES, got {new_len}");

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.starts_with("--- log truncated"), "should carry the truncation marker");
        // The very last line written must survive (nothing lost off the end).
        assert!(content.trim_end().ends_with(&format!("{last_line_no} {line}")));
        // An early line must NOT survive (the head was actually dropped).
        assert!(!content.contains(&format!("\n0 {line}\n")));
        // No partial line at the top of the kept tail (other than the marker).
        let mut lines = content.lines();
        assert!(lines.next().unwrap().starts_with("--- log truncated"));
        for l in lines {
            if l.is_empty() { continue; }
            assert!(l.ends_with(&line), "kept line should be a complete, unbroken original line: {l:?}");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn missing_file_is_a_noop() {
        let path = tmp_log("does-not-exist.log");
        let _ = std::fs::remove_file(&path);
        rotate_log_if_large(path.to_str().unwrap()).await; // must not panic
        assert!(!path.exists());
    }
}

