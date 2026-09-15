// Shared, live Chat Agent Mode state (tool tier + Memory/Reflection/Deep
// research toggles) — same cross-mount problem coderSafety.tsx solves
// (app.tsx keeps every screen mounted forever, so ChatScreen and Settings >
// Agent must share one live value or one side goes stale the instant the
// other changes it), kept as its own provider rather than folded into
// CoderSafetyProvider since these are a distinct, Chat-only concern.

import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode, type MutableRefObject } from 'react';
import {
  chatAgentResearchGet, chatAgentResearchSet,
  chatMemoryEnabledGet, chatMemoryEnabledSet,
  chatReflectionEnabledGet, chatReflectionEnabledSet,
  chatDeepResearchEnabledGet, chatDeepResearchEnabledSet,
  chatMemoryGet, type CoderMemory,
  getConfig, saveConfig, coderPermsSet,
} from './api';
import type { PermTier, PermConfig } from './coderTools';
import { DEFAULT_PERMS } from './coderTools';

interface ChatAgentState {
  /** Tool tier: false = today's default (web_fetch/web_search only), true = adds `browser`. */
  agentResearch: boolean;
  setAgentResearch: (v: boolean) => void;
  memoryEnabled: boolean;
  setMemoryEnabled: (v: boolean) => void;
  reflectionEnabled: boolean;
  setReflectionEnabled: (v: boolean) => void;
  deepResearchEnabled: boolean;
  setDeepResearchEnabled: (v: boolean) => void;
  /** The global chat memory bank + learnings — same {bank, learnings} shape
   *  Coder's per-workspace store uses. `memoryRef` mirrors `memory` for the
   *  system-prompt injection point, which needs the latest snapshot without
   *  closing over a stale render. */
  memory: CoderMemory;
  memoryRef: MutableRefObject<CoderMemory>;
  loadMemory: () => Promise<void>;
  adoptMemory: (m: CoderMemory) => void;
  memoryModalOpen: boolean;
  setMemoryModalOpen: (v: boolean) => void;
  /** Optional model id Reflection critiques/regenerates with instead of the
   *  conversation's own model — '' = same model (today's default). */
  reflectionModel: string;
  setReflectionModel: (v: string) => void;
  /** Permission tier for the `browser`/`memory_update` tools — reuses
   *  Coder's PermTier vocabulary. Default 'allow' (today's behavior). */
  browserTier: PermTier;
  setBrowserTier: (v: PermTier) => void;
  memoryToolTier: PermTier;
  setMemoryToolTier: (v: PermTier) => void;
  /** Deep Research: max parallel angles / tool-call steps per angle. */
  deepResearchMaxAngles: number;
  setDeepResearchMaxAngles: (v: number) => void;
  deepResearchMaxSteps: number;
  setDeepResearchMaxSteps: (v: number) => void;
  /** Reflection: token budget for the critique call itself. */
  reflectionCritiqueMaxTokens: number;
  setReflectionCritiqueMaxTokens: (v: number) => void;
  /** Computer Use: file/shell/search/basic-git tools scoped to their own
   *  directory (independent of Coder's workspace) — for general "use my
   *  computer" tasks, not the coding-harness-specific features (subagents,
   *  todo tracking, PRs) that stay Coder-exclusive. */
  computerUseEnabled: boolean;
  setComputerUseEnabled: (v: boolean) => void;
  computerUseDir: string;
  setComputerUseDir: (v: string) => void;
  /** Mirrors `computerUseDir` for the `set_directory` tool: a multi-turn tool
   *  loop builds its registry once per user message, so a plain closed-over
   *  value would go stale the instant the tool changes it mid-turn — the
   *  same problem `memoryRef` solves for `memory`. */
  computerUseDirRef: MutableRefObject<string>;
  /** Per-tool tiers + denied path prefixes for Computer Use's tools, mirrored
   *  to the control plane's perms map under `computerUseDir` as the scope. */
  computerUsePerms: PermConfig;
  setComputerUsePerms: (v: PermConfig) => void;
}

const Ctx = createContext<ChatAgentState | null>(null);

export function ChatAgentProvider({ children }: { children: ReactNode }) {
  const [agentResearch, setAgentResearchState] = useState(false);
  const [memoryEnabled, setMemoryEnabledState] = useState(false);
  const [reflectionEnabled, setReflectionEnabledState] = useState(false);
  const [deepResearchEnabled, setDeepResearchEnabledState] = useState(false);

  const [memory, setMemory] = useState<CoderMemory>({ learnings: [] });
  const memoryRef = useRef<CoderMemory>({ learnings: [] });
  const [memoryModalOpen, setMemoryModalOpen] = useState(false);

  const [reflectionModel, setReflectionModelState] = useState('');
  const [browserTier, setBrowserTierState] = useState<PermTier>('allow');
  const [memoryToolTier, setMemoryToolTierState] = useState<PermTier>('allow');
  const [deepResearchMaxAngles, setDeepResearchMaxAnglesState] = useState(3);
  const [deepResearchMaxSteps, setDeepResearchMaxStepsState] = useState(5);
  const [reflectionCritiqueMaxTokens, setReflectionCritiqueMaxTokensState] = useState(400);
  const [computerUseEnabled, setComputerUseEnabledState] = useState(false);
  const [computerUseDir, setComputerUseDirState] = useState('');
  const computerUseDirRef = useRef('');
  const [computerUsePerms, setComputerUsePermsState] = useState<PermConfig>(DEFAULT_PERMS);

  const adoptMemory = useCallback((m: CoderMemory) => {
    setMemory(m);
    memoryRef.current = m;
  }, []);
  const loadMemory = useCallback(async () => {
    try {
      adoptMemory(await chatMemoryGet());
    } catch {
      // best-effort — keep the last good snapshot rather than wiping the UI
    }
  }, [adoptMemory]);

  useEffect(() => {
    chatAgentResearchGet().then((r) => setAgentResearchState(r.enabled)).catch(() => {});
    chatMemoryEnabledGet().then((r) => setMemoryEnabledState(r.enabled)).catch(() => {});
    chatReflectionEnabledGet().then((r) => setReflectionEnabledState(r.enabled)).catch(() => {});
    chatDeepResearchEnabledGet().then((r) => setDeepResearchEnabledState(r.enabled)).catch(() => {});
    getConfig().then((c) => {
      setReflectionModelState(c.chatReflectionModel ?? '');
      setBrowserTierState((c.chatBrowserTier as PermTier) || 'allow');
      setMemoryToolTierState((c.chatMemoryToolTier as PermTier) || 'allow');
      setDeepResearchMaxAnglesState(c.chatDeepResearchMaxAngles ?? 3);
      setDeepResearchMaxStepsState(c.chatDeepResearchMaxSteps ?? 5);
      setReflectionCritiqueMaxTokensState(c.chatReflectionCritiqueMaxTokens ?? 400);
      setComputerUseEnabledState(c.chatComputerUseEnabled ?? false);
      setComputerUseDirState(c.chatComputerUseDir ?? '');
      computerUseDirRef.current = c.chatComputerUseDir ?? '';
      try {
        const parsed = c.chatComputerUsePerms ? JSON.parse(c.chatComputerUsePerms) : null;
        if (parsed && typeof parsed === 'object') setComputerUsePermsState({ tools: parsed.tools ?? {}, denyPaths: parsed.denyPaths ?? [] });
      } catch { /* keep DEFAULT_PERMS on malformed stored JSON */ }
    }).catch(() => {});
  }, []);

  // Load the bank/learnings once memory is confirmed on — no point fetching
  // it while the toggle (and thus the injection/tool) is off.
  useEffect(() => {
    if (memoryEnabled) void loadMemory();
  }, [memoryEnabled, loadMemory]);

  const setAgentResearch = useCallback((v: boolean) => {
    setAgentResearchState(v);
    chatAgentResearchSet(v).catch(() => {});
  }, []);
  const setMemoryEnabled = useCallback((v: boolean) => {
    setMemoryEnabledState(v);
    chatMemoryEnabledSet(v).catch(() => {});
  }, []);
  const setReflectionEnabled = useCallback((v: boolean) => {
    setReflectionEnabledState(v);
    chatReflectionEnabledSet(v).catch(() => {});
  }, []);
  const setDeepResearchEnabled = useCallback((v: boolean) => {
    setDeepResearchEnabledState(v);
    chatDeepResearchEnabledSet(v).catch(() => {});
  }, []);
  const setReflectionModel = useCallback((v: string) => {
    setReflectionModelState(v);
    saveConfig({ chatReflectionModel: v }).catch(() => {});
  }, []);
  const setBrowserTier = useCallback((v: PermTier) => {
    setBrowserTierState(v);
    saveConfig({ chatBrowserTier: v }).catch(() => {});
  }, []);
  const setMemoryToolTier = useCallback((v: PermTier) => {
    setMemoryToolTierState(v);
    saveConfig({ chatMemoryToolTier: v }).catch(() => {});
  }, []);
  const setDeepResearchMaxAngles = useCallback((v: number) => {
    setDeepResearchMaxAnglesState(v);
    saveConfig({ chatDeepResearchMaxAngles: v }).catch(() => {});
  }, []);
  const setDeepResearchMaxSteps = useCallback((v: number) => {
    setDeepResearchMaxStepsState(v);
    saveConfig({ chatDeepResearchMaxSteps: v }).catch(() => {});
  }, []);
  const setReflectionCritiqueMaxTokens = useCallback((v: number) => {
    setReflectionCritiqueMaxTokensState(v);
    saveConfig({ chatReflectionCritiqueMaxTokens: v }).catch(() => {});
  }, []);
  const setComputerUseEnabled = useCallback((v: boolean) => {
    setComputerUseEnabledState(v);
    saveConfig({ chatComputerUseEnabled: v }).catch(() => {});
  }, []);
  const setComputerUseDir = useCallback((v: string) => {
    setComputerUseDirState(v);
    computerUseDirRef.current = v;
    saveConfig({ chatComputerUseDir: v }).catch(() => {});
  }, []);
  const setComputerUsePerms = useCallback((v: PermConfig) => {
    setComputerUsePermsState(v);
    saveConfig({ chatComputerUsePerms: JSON.stringify(v) }).catch(() => {});
  }, []);
  // Mirror Computer Use's tiers to the control plane so `deny` is enforced
  // server-side too (see coderPermsSet) — same pattern Coder's own perms
  // panel uses, but scoped to computerUseDir so the two never collide.
  // Re-synced on every edit and on directory change.
  useEffect(() => {
    if (!computerUseDir) return;
    coderPermsSet({ tools: computerUsePerms.tools, denyPaths: computerUsePerms.denyPaths }, computerUseDir).catch(() => { /* best-effort mirror */ });
  }, [computerUseDir, computerUsePerms]);

  return (
    <Ctx.Provider
      value={{
        agentResearch, setAgentResearch,
        memoryEnabled, setMemoryEnabled,
        reflectionEnabled, setReflectionEnabled,
        deepResearchEnabled, setDeepResearchEnabled,
        memory, memoryRef, loadMemory, adoptMemory, memoryModalOpen, setMemoryModalOpen,
        reflectionModel, setReflectionModel,
        browserTier, setBrowserTier,
        memoryToolTier, setMemoryToolTier,
        deepResearchMaxAngles, setDeepResearchMaxAngles,
        deepResearchMaxSteps, setDeepResearchMaxSteps,
        reflectionCritiqueMaxTokens, setReflectionCritiqueMaxTokens,
        computerUseEnabled, setComputerUseEnabled,
        computerUseDir, setComputerUseDir, computerUseDirRef,
        computerUsePerms, setComputerUsePerms,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useChatAgent(): ChatAgentState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useChatAgent must be used within ChatAgentProvider');
  return ctx;
}
