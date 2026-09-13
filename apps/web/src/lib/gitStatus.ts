import { coderExec, type CoderDiffResult } from './api';

/** One-character git status letter shown on tabs + tree rows. */
export type GitFileStatus = 'M' | 'A' | 'U' | 'D' | 'R';

/** Same single-quote shell escaping as CoderScreen's exec helpers. */
export const shellQuote = (s: string) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** Lists local branches: current branch + full branch list (current included).
 *  `git branch --show-current` emits zero bytes (not even a blank line) when
 *  HEAD is detached, which would otherwise shift every line after it by one —
 *  the `printf` wrapper guarantees exactly one line of output for the current
 *  branch (empty string when detached) so the split below stays aligned. */
export const GIT_BRANCH_LIST_CMD = `printf '%s\\n' "$(git branch --show-current)" && git branch --format='%(refname:short)'`;

export function parseBranchList(stdout: string): { current: string; branches: string[] } {
  const nl = stdout.indexOf('\n');
  const current = (nl === -1 ? stdout : stdout.slice(0, nl)).trim();
  const rest = nl === -1 ? '' : stdout.slice(nl + 1);
  return { current, branches: rest.split('\n').map((s) => s.trim()).filter(Boolean) };
}

/** git status --porcelain v1 → Map<workspace-relative path, letter>.
 *  Never throws: not a git repo / exec failure → empty map (no badges).
 *  `-uall` lists every untracked file individually — plain porcelain
 *  collapses an untracked DIRECTORY to a single `?? dir/` entry, and newly
 *  created files under it would then get no `U` badge (tree rows are
 *  dir/file, the map is keyed by exact path). */
export async function fetchGitStatusMap(): Promise<Map<string, GitFileStatus>> {
  const map = new Map<string, GitFileStatus>();
  let r;
  try {
    r = await coderExec('git status --porcelain -uall', undefined, 10000);
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
 *  worktree-vs-index and would show nothing once anything is staged).
 *  A clean file returns an EMPTY file list (the modal shows "No uncommitted
 *  changes" — a synthetic single-file entry for an empty diff would render
 *  a blank "1 file changed" view), and the diff is bounded to the slice the
 *  modal can render. */
const DIFF_MAX = 60000;
export async function fetchFileDiff(path: string): Promise<CoderDiffResult> {
  try {
    const r = await coderExec(`git --no-pager diff HEAD -- ${shellQuote(path)}`, undefined, 30000);
    const stdout = r.stdout || '';
    if (r.exitCode !== 0 && !stdout) {
      return { files: [], diff: '', error: (r.stderr || r.stdout || '').slice(0, 2000) || 'diff failed' };
    }
    if (stdout.trim() === '') return { files: [], diff: '' };
    return { files: [{ path }], diff: stdout.length > DIFF_MAX ? stdout.slice(0, DIFF_MAX) : stdout, truncated: stdout.length > DIFF_MAX };
  } catch (e) {
    return { files: [], diff: '', error: e instanceof Error ? e.message : String(e) };
  }
}
