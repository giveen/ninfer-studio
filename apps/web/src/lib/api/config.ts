// App settings, per-user profile state, and persisted conversations —
// everything the control plane stores under the user's data dir rather than
// the browser. Also the combined /api/status poller both other domains'
// screens read from.

import { useEffect, useRef, useState } from 'react';
import type { AppSettings, ChatParams, ProfileState, SavedProfile, StatusPayload } from '../types';
import { getJSON, postJSON } from './core';

export function getStatus(): Promise<StatusPayload> {
  return getJSON<StatusPayload>('/api/status', 6000);
}

export function getConfig(): Promise<AppSettings> {
  return getJSON<AppSettings>('/api/config');
}

/** Read the engine's context window (max_model_len) for `model` from its
 *  /v1/models advertisement. Falls back to null so callers can try the
 *  control-plane-reported maxContext instead. */
export async function getEngineContextSize(model = 'qwen-coder'): Promise<number | null> {
  try {
    const data = await getJSON<{ data?: Array<{ id: string; max_model_len?: number }> }>('/v1/models');
    const models = data?.data ?? [];
    const hit = models.find((m) => m.id === model) ?? models[0];
    return hit?.max_model_len != null ? hit.max_model_len : null;
  } catch {
    return null;
  }
}

export function saveConfig(patch: Partial<AppSettings>): Promise<AppSettings> {
  return postJSON<AppSettings>('/api/config', patch, 5000);
}

// ---------------------------------------------------------------------------
// Per-user profile state (engine profile + artifact + saved named profiles).
// Persisted by the control plane under the user's profile dir, not the browser.
// ---------------------------------------------------------------------------
export function getProfileState(): Promise<ProfileState> {
  return getJSON<ProfileState>('/api/profile-state', 5000);
}

export function saveProfileState(
  patch: Partial<{ profile: import('../types').EngineProfile; artifact: string; saved: SavedProfile[] }>,
): Promise<unknown> {
  return postJSON('/api/profile-state', patch, 5000);
}

// ---------------------------------------------------------------------------
// Conversations + chat params — persisted by the control plane under the user's
// profile dir (not the browser), so chat history survives a fresh install.
// ---------------------------------------------------------------------------
export interface ConversationsState {
  conversations: import('../types').Conversation[];
  params: ChatParams | null;
  presets?: import('../types').SavedChatParams[];
}

export function getConversations(): Promise<ConversationsState> {
  return getJSON<ConversationsState>('/api/conversations', 8000);
}

export function saveConversations(
  patch: Partial<{ conversations: import('../types').Conversation[]; params: ChatParams; presets: import('../types').SavedChatParams[] }>,
): Promise<unknown> {
  return postJSON('/api/conversations', patch, 20_000);
}

/** Poll /api/status on an interval and keep it fresh in state. */
export function useStatus(intervalMs = 2500): { status: StatusPayload | null; error: string | null } {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const tick = async () => {
      try {
        const s = await getStatus();
        if (!alive.current) return;
        setStatus(s);
        setError(null);
      } catch (e) {
        if (!alive.current) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [intervalMs]);
  return { status, error };
}

/** Auto-detect models available on an OpenAI-compatible cloud provider endpoint (/v1/models). */
export async function fetchCloudModels(baseUrl?: string, apiKey?: string): Promise<string[]> {
  const base = (baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = base.endsWith('/models') ? base : `${base}/models`;
  const headers: Record<string, string> = {};
  if (apiKey?.trim() && apiKey !== '******** (saved)') {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Cloud models request failed (${res.status}): ${text.slice(0, 100) || res.statusText}`);
  }
  const data = await res.json();
  if (Array.isArray(data?.data)) {
    return data.data
      .map((m: any) => (typeof m === 'string' ? m : m?.id))
      .filter((id: any): id is string => typeof id === 'string' && id.length > 0)
      .sort();
  }
  return [];
}
