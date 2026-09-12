import { useCallback, useEffect, useState } from 'react';
import { coderJob, coderJobKill } from '../../lib/api';
import type { CoderJob } from '../../lib/types';

export interface BgJobEntry { id: string; command: string; ws: string; }
export interface SubEntry { id: string; label: string; task: string; since: number; ws: string; }
export interface CoderJobs {
  bgJobs: BgJobEntry[];
  activeSubs: SubEntry[];
  subTick: number;
  jobStatus: Record<string, CoderJob>;
  jobsOpen: boolean;
  setJobsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  registerJob: (id: string, command: string, ws: string) => void;
  settleJobStatus: (jobId: string, s: CoderJob) => void;
  registerSub: (sub: Omit<SubEntry, 'since'>) => void;
  unregisterSub: (id: string) => void;
  killJob: (id: string) => Promise<void>;
  dismissJob: (id: string) => void;
}

/**
 * Background shell jobs + live subagent runs for the Jobs panel.
 * Registration is fire-and-forget from the run loop (deduped, capped);
 * polling runs on a 3s cadence while the panel is open and stops when all
 * tracked jobs are done.
 */
export function useCoderJobs({ activeWs, onError }: { activeWs: string; onError: (detail: string) => void }): CoderJobs {
  /** Recent background jobs (cap 20 — the sidebar panel polls + kills them). */
  const [bgJobs, setBgJobs] = useState<BgJobEntry[]>([]);
  /** Live subagent runs (delegate / subagent / scout) for the Jobs panel. */
  const [activeSubs, setActiveSubs] = useState<SubEntry[]>([]);
  const [subTick, setSubTick] = useState(Date.now());
  useEffect(() => {
    if (activeSubs.length === 0) return;
    const t = setInterval(() => setSubTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [activeSubs.length]);
  const [jobStatus, setJobStatus] = useState<Record<string, CoderJob>>({});
  const [jobsOpen, setJobsOpen] = useState(true);

  /** Poll unfinished jobs while the panel is open (3s cadence, stops when all done). */
  useEffect(() => {
    if (!jobsOpen) return;
    const pending = bgJobs.filter((j) => !(jobStatus[j.id]?.done ?? false));
    if (pending.length === 0) return;
    let cancelled = false;
    const poll = async () => {
      for (const j of pending) {
        try {
          const s = await coderJob(j.id);
          if (!cancelled) setJobStatus((prev) => ({ ...prev, [j.id]: s }));
        } catch { /* job expired server-side; leave last status */ }
      }
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [jobsOpen, bgJobs, activeWs, jobStatus]);

  const registerJob = useCallback((id: string, command: string, ws: string) => {
    setBgJobs((prev) => (prev.some((j) => j.id === id) ? prev : [...prev.slice(-19), { id, command, ws }]));
  }, []);

  const settleJobStatus = useCallback((jobId: string, s: CoderJob) => {
    setJobStatus((prev) => ({ ...prev, [jobId]: s }));
  }, []);

  const registerSub = useCallback((sub: Omit<SubEntry, 'since'>) => {
    setActiveSubs((prev) => [...prev.slice(-11), { ...sub, since: Date.now() }]);
  }, []);

  const unregisterSub = useCallback((id: string) => {
    setActiveSubs((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const killJob = useCallback(async (id: string) => {
    try {
      const k = await coderJobKill(id);
      setJobStatus((prev) => ({ ...prev, [id]: k }));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }, [onError]);

  const dismissJob = useCallback((id: string) => {
    setBgJobs((prev) => prev.filter((x) => x.id !== id));
    setJobStatus((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  return {
    bgJobs, activeSubs, subTick, jobStatus, jobsOpen, setJobsOpen,
    registerJob, settleJobStatus, registerSub, unregisterSub, killJob, dismissJob,
  };
}

