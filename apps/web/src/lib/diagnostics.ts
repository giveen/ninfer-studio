/** Parse common linter/test output into structured {file,line,col,message} diagnostics. */
export function parseDiagnostics(
  cmd: string,
  output: string,
): Array<{ file?: string; line?: number; col?: number; severity?: string; message: string }> {
  const out: Array<{ file?: string; line?: number; col?: number; severity?: string; message: string }> = [];
  const lines = (output || '').split('\n');
  for (const raw of lines) {
    let m = raw.match(/^([^\s()]+\.[A-Za-z0-9]+)\((\d+),(\d+)\):\s*(error|warning):\s*(.+)$/);
    if (m) { out.push({ file: m[1], line: +m[2], col: +m[3], severity: m[4], message: m[5] }); continue; }
    m = raw.match(/^([^\s()]+\.[A-Za-z0-9]+):(\d+):(\d+):\s*(error|warning):\s*(.+)$/);
    if (m) { out.push({ file: m[1], line: +m[2], col: +m[3], severity: m[4], message: m[5] }); continue; }
    m = raw.match(/^([^\s()]+\.[A-Za-z0-9]+):(\d+):(\d+)\s+(error|warning)\s+(.+?)\s+\S+$/);
    if (m) { out.push({ file: m[1], line: +m[2], col: +m[3], severity: m[4], message: m[5] }); continue; }
    m = raw.match(/error(?:\[[^\]]+\])?:\s*(.+?)\s*\(([^\s()]+\.[A-Za-z0-9]+):(\d+):(\d+)\)/);
    if (m) { out.push({ file: m[2], line: +m[3], col: +m[4], severity: 'error', message: m[1] }); continue; }
  }
  for (const raw of lines) {
    const m = raw.match(/^(FAILED|ERROR)\s+([^\s()]+\.[A-Za-z0-9]+)::(.+)$/);
    if (m) out.push({ file: m[2], message: `${m[1]} ${m[3]}` });
  }
  return out.slice(0, 100);
}
