// Shared, live Chat Agent Mode state (tool tier + Memory/Reflection/Deep
// research toggles) — same cross-mount problem coderSafety.tsx solves
// (app.tsx keeps every screen mounted forever, so ChatScreen and Settings >
// Agent must share one live value or one side goes stale the instant the
// other changes it), kept as its own provider rather than folded into
// CoderSafetyProvider since these are a distinct, Chat-only concern.

import { createContext, useContext, useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  chatAgentResearchGet, chatAgentResearchSet,
  chatMemoryEnabledGet, chatMemoryEnabledSet,
  chatReflectionEnabledGet, chatReflectionEnabledSet,
  chatDeepResearchEnabledGet, chatDeepResearchEnabledSet,
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
}

const Ctx = createContext<ChatAgentState | null>(null);

export function ChatAgentProvider({ children }: { children: ReactNode }) {
  const [agentResearch, setAgentResearchState] = useState(false);
  const [memoryEnabled, setMemoryEnabledState] = useState(false);
  const [reflectionEnabled, setReflectionEnabledState] = useState(false);
  const [deepResearchEnabled, setDeepResearchEnabledState] = useState(false);

  useEffect(() => {
    chatAgentResearchGet().then((r) => setAgentResearchState(r.enabled)).catch(() => {});
    chatMemoryEnabledGet().then((r) => setMemoryEnabledState(r.enabled)).catch(() => {});
    chatReflectionEnabledGet().then((r) => setReflectionEnabledState(r.enabled)).catch(() => {});
    chatDeepResearchEnabledGet().then((r) => setDeepResearchEnabledState(r.enabled)).catch(() => {});
  }, []);

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

  return (
    <Ctx.Provider
      value={{
        agentResearch, setAgentResearch,
        memoryEnabled, setMemoryEnabled,
        reflectionEnabled, setReflectionEnabled,
        deepResearchEnabled, setDeepResearchEnabled,
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
