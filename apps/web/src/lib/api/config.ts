// App settings, per-user profile state, and persisted conversations —
// everything the control plane stores under the user's data dir rather than
// the browser. Also the combined /api/status poller both other domains'
// screens read from.

import { useEffect, useRef, useState } from 'react';
import type { AppSettings, ChatParams, ProfileState, SavedProfile, StatusPayload } from '../types';
import { getJSON, postJSON } from './core';

export const SECRET_MASK = '********';

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
    const hit = models.find((m) => m.id === model);
    return hit?.max_model_len != null ? hit.max_model_len : null;
  } catch {
    return null;
  }
}

/** `rejected` lists field names the server left at their previous value —
 *  an out-of-range `enginePort`/`costPerKwh`, or a port colliding with the
 *  other configured port — instead of silently applying nothing for them. */
export function saveConfig(patch: Partial<AppSettings>): Promise<AppSettings & { rejected?: string[] }> {
  return postJSON<AppSettings & { rejected?: string[] }>('/api/config', patch, 5000);
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
): Promise<ProfileState> {
  return postJSON<ProfileState>('/api/profile-state', patch, 5000);
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
  const inFlight = useRef(false);

  useEffect(() => {
    alive.current = true;
    const tick = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const s = await getStatus();
        if (!alive.current) return;
        setStatus(s);
        setError(null);
      } catch (e) {
        if (!alive.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlight.current = false;
      }
    };
    void tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [intervalMs]);
  return { status, error };
}

/** Auto-detect models available on an OpenAI-compatible cloud provider endpoint (/v1/models). */
export async function fetchCloudModels(baseUrl?: string, apiKey?: string, extraHeaders?: string): Promise<string[]> {
  const test = await testCloudConnection(baseUrl, apiKey, extraHeaders);
  if (!test.ok) {
    throw new Error(test.error || 'Failed to connect to cloud provider');
  }
  return test.models;
}

/** Context window + USD pricing for one model, when the provider's /models
 *  response reports it (OpenRouter does; most others don't — the field is
 *  simply absent for those models). Prices are per million tokens. */
export interface CloudModelInfo {
  id: string;
  contextLength?: number;
  pricePromptPerM?: number;
  priceCompletionPerM?: number;
}

export interface CloudTestResult {
  ok: boolean;
  latencyMs: number;
  models: string[];
  /** Metadata for models the provider reported pricing/context for — a
   *  subset of `models`, not parallel to it. */
  modelInfo?: CloudModelInfo[];
  error?: string;
}

export async function testCloudConnection(baseUrl?: string, apiKey?: string, extraHeaders?: string): Promise<CloudTestResult> {
  // Try control plane backend endpoint first (bypasses browser CORS completely)
  try {
    const res = await postJSON<CloudTestResult>('/api/cloud/test', { baseUrl, apiKey, extraHeaders }, 12_000);
    if (res && typeof res.ok === 'boolean') {
      return res;
    }
  } catch (e) {
    /* fallback to direct browser fetch if backend endpoint is unavailable (e.g. 404 route missing) */
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('HTTP 404')) {
      return {
        ok: false,
        latencyMs: 0,
        models: [],
        error: msg,
      };
    }
  }

  const t0 = performance.now();
  try {
    const base = (baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const url = base.endsWith('/models') ? base : `${base}/models`;
    const headers: Record<string, string> = {};
    const k = apiKey?.trim() ?? '';
    if (k && k !== SECRET_MASK) {
      headers['Authorization'] = `Bearer ${k}`;
    }
    if (extraHeaders?.trim()) {
      try {
        const parsed = JSON.parse(extraHeaders);
        if (parsed && typeof parsed === 'object') {
          Object.assign(headers, parsed);
        }
      } catch {
        /* ignore invalid custom json headers */
      }
    }
    const res = await fetch(url, { headers });
    const latencyMs = Math.round(performance.now() - t0);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        latencyMs,
        models: [],
        error: `HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`,
      };
    }
    const data = await res.json();
    let models: string[] = [];
    if (Array.isArray(data?.data)) {
      models = data.data
        .map((m: any) => (typeof m === 'string' ? m : m?.id))
        .filter((id: any): id is string => typeof id === 'string' && id.length > 0)
        .sort();
    }
    return {
      ok: true,
      latencyMs,
      models,
    };
  } catch (e) {
    const latencyMs = Math.round(performance.now() - t0);
    return {
      ok: false,
      latencyMs,
      models: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
