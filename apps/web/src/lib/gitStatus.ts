import { coderExec, type CoderDiffResult } from './api';

/** One-character git status letter shown on tabs + tree rows. */
export type GitFileStatus = 'M' | 'A' | 'U' | 'D' | 'R';

/** Same single-quote shell escaping as CoderScreen's exec helpers. */
const shellQuote = (s: string) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** git status --porcelain v1 → Map<workspace-relative path, letter>.
 *  Never throws: not a git repo / exec failure → empty map (no badges). */
export async function fetchGitStatusMap(): Promise<Map<string, GitFileStatus>> {
  const map = new Map<string, GitFileStatus>();
  let r;
  try {
    r = await coderExec('git status --porcelain', undefined, 10000);
  } catch {
    return map;
  }
  if (r.exitCode !== 0) return map;
  const toLetter = (xy: string): GitFileStatus | null => {
    if (xy === '??') return 'U';
    if (xy.includes('M')) return 'M';
    if (xy.includes('A')) return 'A';
    if (xy.includes('D')) return 'D';
    if (xy.includes('R') || xy.includes('C')) return 'R';
    return null;
  };
  for (const line of (r.stdout || '').split('\n')) {
    if (line.length < 4) continue;
    const letter = toLetter(line.slice(0, 2));
    if (!letter) continue;
    let path = line.slice(3);
    // Renames: `XY <old> -> <new>` — map onto the NEW path.
    const arrow = ' -> ';
    const i = path.indexOf(arrow);
    if (i !== -1) path = path.slice(i + arrow.length);
    // C-style quoted paths (git quotes unusual characters).
    if (path.startsWith('"') && path.endsWith('"')) {
      path = path.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (!path) continue;
    map.set(path, letter);
  }
  return map;
}

/** Per-file diff vs HEAD (staged changes included — bare `git diff` is
 *  worktree-vs-index and would show nothing once anything is staged). */
export async function fetchFileDiff(path: string): Promise<CoderDiffResult> {
  try {
    const r = await coderExec(`git --no-pager diff HEAD -- ${shellQuote(path)}`, undefined, 30000);
    const stdout = r.stdout || '';
    if (r.exitCode !== 0 && !stdout) {
      return { files: [], diff: '', error: (r.stderr || r.stdout || '').slice(0, 2000) || 'diff failed' };
    }
    return { files: [{ path }], diff: stdout, truncated: stdout.length > 60000 };
  } catch (e) {
    return { files: [], diff: '', error: e instanceof Error ? e.message : String(e) };
  }
}
