//! VRAM accounting read from the engine log `capacity |` lines.
use super::log::log_path_for;

/// VRAM safety floor (GiB): when the engine reports less free memory than this
/// after load, the UI warns that any growth (CUDA graph re-capture, media
/// buffers, desktop spill) can OOM the run.
pub const VRAM_FLOOR_GIB: f64 = 1.8;

/// Parse one engine `capacity |` log line into (runtime GiB, free GiB).
/// Real shapes seen in the wild:
///   capacity | KV 240,000 tokens, fp8, explicit | pages 3,750/7,500 | runtime 9.41 GiB | free 3.34 GiB
///   capacity | KV 8,192 tokens, bf16, explicit | pages 128/128 | runtime 982.1 MiB | free 9.70 GiB
/// Units vary per line, so both MiB and GiB are handled.
fn parse_capacity_line(line: &str) -> Option<(f64, f64)> {
    if !line.contains("capacity |") {
        return None;
    }
    let mut runtime = None;
    let mut free = None;
    for seg in line.split('|') {
        let seg = seg.trim();
        for (label, slot) in [("runtime ", &mut runtime), ("free ", &mut free)] {
            if let Some(rest) = seg.strip_prefix(label) {
                let mut it = rest.split_whitespace();
                let val: f64 = it.next()?.parse().ok()?;
                match it.next()?.to_lowercase().as_str() {
                    "gib" => *slot = Some(val),
                    "mib" => *slot = Some(val / 1024.0),
                    _ => {}
                }
            }
        }
    }
    Some((runtime?, free?))
}

/// Tail the engine log for the most recent `capacity |` line — the engine's
/// own VRAM accounting after weights + KV are resident. Works for adopted
/// engines too, since it reads the shared log file rather than our spawn pipe.
pub async fn vram_status(data_dir: &std::path::Path, port: u16) -> Option<(f64, f64)> {
    let path = log_path_for(data_dir, port);
    tokio::task::spawn_blocking(move || {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = std::fs::File::open(&path).ok()?;
        let start = f.metadata().ok()?.len().saturating_sub(65_536);
        f.seek(SeekFrom::Start(start)).ok()?;
        let mut tail = String::new();
        f.read_to_string(&mut tail).ok()?;
        tail.lines().rev().find_map(parse_capacity_line)
    })
    .await
    .unwrap_or(None)
}

#[cfg(test)]
mod vram_tests {
    use super::parse_capacity_line;

    #[test]
    fn parses_the_two_observed_line_shapes() {
        let gig = "2026-09-10 17:42:45.669  INFO  capacity | KV 240,000 tokens, fp8, explicit | pages 3,750/7,500 | runtime 9.41 GiB | free 3.34 GiB";
        let (r, f) = parse_capacity_line(gig).expect("gigabyte line parses");
        assert!((r - 9.41).abs() < 1e-9 && (f - 3.34).abs() < 1e-9);

        let mib = "2026-09-10 17:20:03.051  INFO  capacity | KV 8,192 tokens, bf16, explicit | pages 128/128 | runtime 982.1 MiB | free 9.70 GiB";
        let (r, f) = parse_capacity_line(mib).expect("megabyte line parses");
        assert!((r - 982.1 / 1024.0).abs() < 1e-9 && (f - 9.70).abs() < 1e-9);
    }

    #[test]
    fn rejects_non_capacity_lines() {
        assert!(parse_capacity_line("2026-09-10 17:42:45.763  INFO  listening on http://127.0.0.1:8080 | model qwen3.8-27b | auth disabled").is_none());
        assert!(parse_capacity_line("").is_none());
    }
}

