// Shared, live Coder safety state (Safe Mode / Sandbox / Commit Approval).
//
// app.tsx keeps every top-level screen mounted forever (only toggles
// `hidden` — unmounting would drop in-flight streams), so CoderScreen's
// sidebar and Settings > Safety & Permissions must share one live value for
// each of these or one side goes stale the instant the other changes it.
// This provider is the single source of truth: it hydrates once from the
// backend and both consumers read/write through the same context value.

import { createContext, useContext, useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  coderSafeModeGet, coderSafeModeSet,
  coderSandboxGet, coderSandboxSet,
  coderCommitApprovalGet, coderCommitApprovalSet,
} from './api';

interface CoderSafetyState {
  safeMode: boolean;
  setSafeMode: (v: boolean) => void;
  sandbox: boolean;
  setSandbox: (v: boolean) => void;
  bwrapAvailable: boolean;
  commitApproval: boolean;
  setCommitApproval: (v: boolean) => void;
}

const Ctx = createContext<CoderSafetyState | null>(null);

export function CoderSafetyProvider({ children }: { children: ReactNode }) {
  const [safeMode, setSafeModeState] = useState(true);
  const [sandbox, setSandboxState] = useState(true);
  const [bwrapAvailable, setBwrapAvailable] = useState(true);
  const [commitApproval, setCommitApprovalState] = useState(false);

  useEffect(() => {
    coderSafeModeGet().then((r) => setSafeModeState(r.enabled)).catch(() => {});
    coderSandboxGet().then((r) => { setSandboxState(r.enabled); setBwrapAvailable(r.bwrapAvailable); }).catch(() => {});
    coderCommitApprovalGet().then((r) => setCommitApprovalState(r.enabled)).catch(() => {});
  }, []);

  const setSafeMode = useCallback((v: boolean) => {
    setSafeModeState(v);
    coderSafeModeSet(v).catch(() => {});
  }, []);
  const setSandbox = useCallback((v: boolean) => {
    setSandboxState(v);
    coderSandboxSet(v).then((r) => setBwrapAvailable(r.bwrapAvailable)).catch(() => {});
  }, []);
  const setCommitApproval = useCallback((v: boolean) => {
    setCommitApprovalState(v);
    coderCommitApprovalSet(v).catch(() => {});
  }, []);

  return (
    <Ctx.Provider value={{ safeMode, setSafeMode, sandbox, setSandbox, bwrapAvailable, commitApproval, setCommitApproval }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCoderSafety(): CoderSafetyState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCoderSafety must be used within CoderSafetyProvider');
  return ctx;
}
