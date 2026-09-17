//! VRAM accounting read from the engine log `capacity |` lines.
use super::log::log_path_for;

/// VRAM safety floor (GiB): when the engine reports less free memory than this
/// after load, the UI warns that any growth (CUDA graph re-capture, media
/// buffers, desktop spill) can OOM the run.
pub const VRAM_FLOOR_GIB: f64 = 1.8;

/// Returns true if a log line is an engine capacity announcement line.
pub fn is_capacity_line(line: &str) -> bool {
    line.contains("capacity |")
}

/// Parse one engine `capacity |` log line into (runtime GiB, free GiB).
/// Real shapes seen in the wild:
///   capacity | KV 240,000 tokens, fp8, explicit | pages 3,750/7,500 | runtime 9.41 GiB | free 3.34 GiB
///   capacity | KV 8,192 tokens, bf16, explicit | pages 128/128 | runtime 982.1 MiB | free 9.70 GiB
/// Units vary per line, so both MiB and GiB are handled.
pub fn parse_capacity_line(line: &str) -> Option<(f64, f64)> {
    if !is_capacity_line(line) {
        return None;
    }
    let mut runtime = None;
    let mut free = None;
    for seg in line.split('|') {
        let seg_lower = seg.trim().to_lowercase();
        for (label, slot) in [("runtime", &mut runtime), ("free", &mut free)] {
            if let Some(rest) = seg_lower.strip_prefix(label) {
                let rest = rest.trim();
                let mut it = rest.split_whitespace();
                if let Some(num_str) = it.next() {
                    let cleaned_num = num_str.replace(',', "");
                    if let Ok(val) = cleaned_num.parse::<f64>() {
                        if val.is_finite() && val >= 0.0 {
                            if let Some(unit) = it.next() {
                                match unit {
                                    "gib" => *slot = Some(val),
                                    "mib" => *slot = Some(val / 1024.0),
                                    _ => {}
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    match (runtime, free) {
        (Some(r), Some(f)) => Some((r, f)),
        _ => None,
    }
}

/// Tail the engine log for the most recent `capacity |` line — the engine's
/// own VRAM accounting after weights + KV are resident. Works for adopted
/// engines too, since it reads the shared log file rather than our spawn pipe.
pub async fn vram_status(data_dir: &std::path::Path, port: u16) -> Option<(f64, f64)> {
    let path_str = log_path_for(data_dir, port);
    tokio::task::spawn_blocking(move || read_vram_status_from_file(std::path::Path::new(&path_str)))
        .await
        .unwrap_or(None)
}

/// Helper function to perform chunked backward reading of VRAM status from a file path.
fn read_vram_status_from_file(path: &std::path::Path) -> Option<(f64, f64)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let file_len = f.metadata().ok()?.len();
    if file_len == 0 {
        return None;
    }

    // Growing search windows: 64 KiB, 256 KiB, 1 MiB, 4 MiB, 16 MiB
    let chunk_sizes = [65_536, 262_144, 1_048_576, 4_194_304, 16_777_216];
    for &chunk_size in &chunk_sizes {
        let read_size = (chunk_size as u64).min(file_len);
        let start = file_len.saturating_sub(read_size);
        if f.seek(SeekFrom::Start(start)).is_err() {
            continue;
        }
        let mut buf = vec![0u8; read_size as usize];
        if f.read_exact(&mut buf).is_err() {
            continue;
        }
        let tail = String::from_utf8_lossy(&buf);
        for line in tail.lines().rev() {
            if is_capacity_line(line) {
                // Return the parsed result of the MOST RECENT capacity line found.
                // If it fails to parse (e.g. corrupted numbers), return None (honest unknown)
                // rather than searching further back for a stale capacity line.
                return parse_capacity_line(line);
            }
        }
        if start == 0 {
            break;
        }
    }
    None
}

#[cfg(test)]
mod vram_tests {
    use super::*;
    use std::io::Write;

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

    #[test]
    fn handles_case_insensitivity_and_commas() {
        let line = "2026-09-10 17:42:45.669  INFO  capacity | KV 240,000 tokens | Runtime 1,024.0 MiB | FREE 3,072.0 MiB";
        let (r, f) = parse_capacity_line(line).expect("case insensitive line parses");
        assert!((r - 1.0).abs() < 1e-9);
        assert!((f - 3.0).abs() < 1e-9);
    }

    #[test]
    fn rejects_nan_and_infinite_values() {
        let nan_line = "capacity | runtime NaN GiB | free 3.34 GiB";
        assert!(parse_capacity_line(nan_line).is_none());

        let inf_line = "capacity | runtime inf GiB | free 3.34 GiB";
        assert!(parse_capacity_line(inf_line).is_none());
    }

    #[test]
    fn vram_status_finds_capacity_line_beyond_64k_window() {
        let temp_dir = std::env::temp_dir();
        let file_path = temp_dir.join("test_vram_64k.log");
        let mut file = std::fs::File::create(&file_path).unwrap();

        // Write initial capacity line
        writeln!(
            file,
            "2026-09-10 17:42:45.669  INFO  capacity | pages 1/1 | runtime 4.0 GiB | free 8.0 GiB"
        )
        .unwrap();

        // Write 100 KiB of filler log text after capacity line
        let filler_line = "2026-09-10 17:45:00.000  INFO  request processing iteration token generation test payload data log entry line\n";
        let repetitions = (100 * 1024) / filler_line.len() + 1;
        for _ in 0..repetitions {
            file.write_all(filler_line.as_bytes()).unwrap();
        }
        file.flush().unwrap();

        let res = read_vram_status_from_file(&file_path);
        assert!(res.is_some(), "Expected VRAM status to be found beyond 64 KiB window");
        let (r, f) = res.unwrap();
        assert!((r - 4.0).abs() < 1e-9);
        assert!((f - 8.0).abs() < 1e-9);

        let _ = std::fs::remove_file(file_path);
    }

    #[test]
    fn vram_status_handles_multibyte_utf8_at_chunk_boundary() {
        let temp_dir = std::env::temp_dir();
        let file_path = temp_dir.join("test_vram_utf8.log");
        let mut file = std::fs::File::create(&file_path).unwrap();

        // Write initial capacity line
        writeln!(
            file,
            "2026-09-10 17:42:45.669  INFO  capacity | pages 1/1 | runtime 2.0 GiB | free 6.0 GiB"
        )
        .unwrap();

        // Pad up to ~65534 bytes
        let cap_len = 82; // approximate line length
        let pad_bytes = vec![b'a'; 65534 - cap_len];
        file.write_all(&pad_bytes).unwrap();

        // Write a multi-byte UTF-8 sequence right across the 65,536 boundary
        // E.g. 4-byte emoji 🦀 (0xF0 0x9F 0xA6 0x80)
        file.write_all("🦀🦀🦀🦀🦀".as_bytes()).unwrap();
        writeln!(file, "\n2026-09-10 17:46:00.000  INFO  end of log").unwrap();
        file.flush().unwrap();

        let res = read_vram_status_from_file(&file_path);
        assert!(res.is_some(), "Expected VRAM status despite multi-byte UTF-8 sequence at 64k boundary");
        let (r, f) = res.unwrap();
        assert!((r - 2.0).abs() < 1e-9);
        assert!((f - 6.0).abs() < 1e-9);

        let _ = std::fs::remove_file(file_path);
    }

    #[test]
    fn vram_status_returns_none_on_corrupted_latest_capacity_line() {
        let temp_dir = std::env::temp_dir();
        let file_path = temp_dir.join("test_vram_corrupted.log");
        let mut file = std::fs::File::create(&file_path).unwrap();

        // Old valid capacity line
        writeln!(
            file,
            "2026-09-10 17:00:00.000  INFO  capacity | runtime 1.0 GiB | free 10.0 GiB"
        )
        .unwrap();

        // New corrupted capacity line
        writeln!(
            file,
            "2026-09-10 18:00:00.000  INFO  capacity | runtime INVALID GiB | free NaN GiB"
        )
        .unwrap();
        file.flush().unwrap();

        let res = read_vram_status_from_file(&file_path);
        assert!(res.is_none(), "Expected None when latest capacity line is corrupted rather than falling back to stale line");

        let _ = std::fs::remove_file(file_path);
    }
}
