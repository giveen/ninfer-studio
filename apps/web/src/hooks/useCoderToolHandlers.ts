import { useCallback } from 'react';
import { coderExec } from '../lib/api';
import { parseDiagnostics } from '../lib/diagnostics';

export interface UseCoderToolHandlersOptions {
  activeWsDir: string;
  detectedCmdsByWsRef: React.MutableRefObject<Map<string, { lint?: string; build?: string; test?: string }>>;
}

/** Cheap guard used by the commit-approval gate: does this shell command commit? */
export const isGitCommitCommand = (cmd: string): boolean => {
  const c = cmd.replace(/^\s*(sudo|env|time|setsid|nice)\s+/, '').trim();
  return /^git\b/.test(c) && /\bcommit\b/.test(c);
};

export function useCoderToolHandlers({ activeWsDir, detectedCmdsByWsRef }: UseCoderToolHandlersOptions) {
  /** Return a bounded unified-diff preview of uncommitted changes in one file against HEAD. */
  const getFilePreview = useCallback(
    async (path: string, signal?: AbortSignal): Promise<{ ok: boolean; preview: string }> => {
      const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
      const d = await coderExec(`git diff HEAD -- ${q(path)}`, undefined, 10000, undefined, false, signal, activeWsDir);
      return { ok: d.exitCode === 0, preview: (d.stdout || '').slice(0, 4000) };
    },
    [activeWsDir],
  );

  /** Post-edit verification: lint (falls back to build) then test, each bounded.
   * Returns extra result fields; the first failure stops the chain so the
   * model sees one error to fix at a time. */
  const runPostEditChecks = useCallback(
    async (res: unknown, preview: string, signal?: AbortSignal): Promise<Record<string, unknown>> => {
      const out: Record<string, unknown> = { ...(res as Record<string, unknown>), ...(preview ? { preview_diff: preview } : {}) };
      const cmds = (activeWsDir ? detectedCmdsByWsRef.current.get(activeWsDir) : undefined) ?? {};
      const lintCmd = cmds.lint || cmds.build;
      if (lintCmd) {
        const check = await coderExec(lintCmd, undefined, 120000, undefined, false, signal, activeWsDir);
        if (check.exitCode !== 0) {
          const diags = parseDiagnostics(lintCmd, check.stderr || check.stdout || '');
          return { ...out, linter_error: (check.stderr || check.stdout || '').slice(0, 8000), diagnostics: diags };
        }
      }
      if (cmds.test) {
        const t = await coderExec(cmds.test, undefined, 180000, undefined, false, signal, activeWsDir);
        if (t.exitCode !== 0) {
          const diags = parseDiagnostics(cmds.test, t.stderr || t.stdout || '');
          return { ...out, test_error: (t.stderr || t.stdout || '').slice(0, 8000), diagnostics: diags };
        }
      }
      return out;
    },
    [activeWsDir, detectedCmdsByWsRef],
  );

  return {
    getFilePreview,
    runPostEditChecks,
  };
}
