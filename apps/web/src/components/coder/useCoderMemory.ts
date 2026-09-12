import { useCallback, useEffect, useRef, useState } from 'react';
import { coderMemoryGet } from '../../lib/api';
import type { CoderMemory } from '../../lib/api';

interface UseCoderMemoryOpts {
  /** Effective workspace directory (worktree-aware). Fetches are skipped when empty. */
  activeWsDir: string;
  /** Bumped when the control plane confirms a workspace re-point (triggers reload). */
  wsFlushed: number;
  /** Ref the control plane sets to the confirmed workspace dir on setCoderWorkspace success. */
  appliedDirRef: React.MutableRefObject<string | null>;
}

/**
 * Self-improving memory panel state (Hybrid A+B). Persisted OUTSIDE the repo
 * by the control plane, so it is never committed by accident. The agent sees
 * it only via system-prompt injection (`memoryRef`) — it can't read it as a file.
 *
 * Race guard (shared with the tree panel): the control plane's workspace
 * re-points asynchronously, so a response is adopted only if it is the newest
 * fetch AND the control plane is confirmed at this workspace — otherwise a
 * pre-switch response would leak the OTHER workspace's bank into this one.
 */
export function useCoderMemory({ activeWsDir, wsFlushed, appliedDirRef }: UseCoderMemoryOpts) {
  const [memory, setMemory] = useState<CoderMemory>({ bank: '', learnings: [] });
  const memoryRef = useRef<CoderMemory>({ bank: '', learnings: [] });
  const [memOpen, setMemOpen] = useState(false);
  const seqRef = useRef(0);

  /** Adopt a fetched bank only when it still belongs to the active workspace. */
  const adoptMemory = useCallback((m: CoderMemory) => {
    if (appliedDirRef.current === activeWsDir) {
      setMemory(m);
      memoryRef.current = m;
    }
  }, [activeWsDir, appliedDirRef]);

  /** Pull the bank + learnings for the active workspace. */
  const loadMemory = useCallback(async () => {
    if (!activeWsDir) return;
    const seq = ++seqRef.current;
    try {
      const m = await coderMemoryGet();
      // Same switch race as the tree: only adopt the newest response, and
      // only once the control is confirmed at this workspace.
      if (seq === seqRef.current) adoptMemory(m);
    } catch {
      // memory is best-effort; keep the last good value rather than wiping UI.
    }
  }, [activeWsDir, adoptMemory]);

  useEffect(() => {
    if (activeWsDir) void loadMemory();
  }, [activeWsDir, wsFlushed, loadMemory]);

  return { memory, memoryRef, memOpen, setMemOpen, loadMemory, adoptMemory };
}
