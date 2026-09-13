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
  getConfig, saveConfig,
} from './api';

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
}

const Ctx = createContext<ChatAgentState | null>(null);

export function ChatAgentProvider({ children }: { children: ReactNode }) {
  const [agentResearch, setAgentResearchState] = useState(false);
  const [memoryEnabled, setMemoryEnabledState] = useState(false);
  const [reflectionEnabled, setReflectionEnabledState] = useState(false);
  const [deepResearchEnabled, setDeepResearchEnabledState] = useState(false);

  const [memory, setMemory] = useState<CoderMemory>({ bank: '', learnings: [] });
  const memoryRef = useRef<CoderMemory>({ bank: '', learnings: [] });
  const [memoryModalOpen, setMemoryModalOpen] = useState(false);

  const [reflectionModel, setReflectionModelState] = useState('');

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
    getConfig().then((c) => setReflectionModelState(c.chatReflectionModel ?? '')).catch(() => {});
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

  return (
    <Ctx.Provider
      value={{
        agentResearch, setAgentResearch,
        memoryEnabled, setMemoryEnabled,
        reflectionEnabled, setReflectionEnabled,
        deepResearchEnabled, setDeepResearchEnabled,
        memory, memoryRef, loadMemory, adoptMemory, memoryModalOpen, setMemoryModalOpen,
        reflectionModel, setReflectionModel,
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
