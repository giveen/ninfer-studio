import { useEffect, useRef, useState } from 'react';
import type { AppSettings, ChatMessage, ChatParams, MessageMeta, ProfileState, SavedProfile, StatusPayload } from './types';
import type { ChatAttachment } from './types';

async function getJSON<T>(path: string, timeoutMs = 4000): Promise<T> {
  const r = await fetch(path, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return (await r.json()) as T;
}

async function postJSON<T>(path: string, body: unknown, timeoutMs = 10_000): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new Error(`${path} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  return data;
}

export function getStatus(): Promise<StatusPayload> {
  return getJSON<StatusPayload>('/api/status', 6000);
}

export function getConfig(): Promise<AppSettings> {
  return getJSON<AppSettings>('/api/config');
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
  patch: Partial<{ profile: import('./types').EngineProfile; artifact: string; saved: SavedProfile[] }>,
): Promise<unknown> {
  return postJSON('/api/profile-state', patch, 5000);
}

export interface EngineActionResult {
  ok: boolean;
  code?: string;
  message?: string;
  engine?: StatusPayload['engine'];
}

export function startEngine(profile: unknown, artifact: string | null): Promise<EngineActionResult> {
  return postJSON<EngineActionResult>('/api/engine/start', { profile, artifact }, 15_000);
}

export function stopEngine(externalPid?: number): Promise<EngineActionResult> {
  return postJSON<EngineActionResult>('/api/engine/stop', { externalPid }, 15_000);
}

export function startEngineUpdate(action: 'pull' | 'build'): Promise<EngineActionResult> {
  return postJSON('/api/engine/update', { action });
}

export function getLogs(n = 400): Promise<{ lines: string[]; size: number }> {
  return getJSON<{ lines: string[]; size: number }>(`/api/logs?n=${n}`, 6000);
}

export function downloadModel(repo: string, file: string, localDir?: string) {
  return postJSON<{ ok: boolean; id?: string; message?: string }>('/api/models/download', {
    repo,
    file,
    localDir,
  });
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

// ---------------------------------------------------------------------------
// Streaming chat over OpenAI-compatible /v1/chat/completions (SSE)
// ---------------------------------------------------------------------------
export interface ChatStreamCallbacks {
  onReasoningDelta?: (text: string) => void;
  onContentDelta?: (text: string) => void;
  onUsage?: (usage: Record<string, unknown>, meta: MessageMeta) => void;
  onDone?: (meta: MessageMeta) => void;
  onError?: (message: string) => void;
}

export function buildChatRequest(
  model: string,
  systemPrompt: string | undefined,
  history: ChatMessage[],
  params: ChatParams,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (systemPrompt?.trim()) messages.push({ role: 'system', content: systemPrompt.trim() });
  for (const m of history) {
    if (m.role === 'system') continue;
    if (m.attachments && m.attachments.length) {
      const content: Array<Record<string, unknown>> = [];
      if (m.content.trim()) content.push({ type: 'text', text: m.content });
      for (const a of m.attachments) {
        if (a.kind === 'image') content.push({ type: 'image_url', image_url: { url: a.dataUrl } });
        else content.push({ type: 'video_url', video_url: { url: a.dataUrl } });
      }
      messages.push({ role: 'user', content });
    } else {
      messages.push({
        role: m.role,
        content: m.content,
        ...(m.role === 'assistant' && m.reasoning ? { reasoning_content: m.reasoning } : {}),
      });
    }
  }
  // Thinking switch + effort: a contradictory enable_thinking/reasoning_effort
  // pair is rejected by the engine, so derive both from one intent.
  let enableThinking = params.thinking;
  let effort: string | undefined;
  if (params.reasoningEffort === 'none') {
    enableThinking = false;
    effort = 'none';
  } else if (params.reasoningEffort) {
    enableThinking = true;
    effort = params.reasoningEffort;
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    enable_thinking: enableThinking,
  };
  if (effort) body.reasoning_effort = effort;
  if (params.preserveThinking !== undefined) body.preserve_thinking = params.preserveThinking;
  if (params.maxTokens) body.max_completion_tokens = params.maxTokens;
  if (params.greedy) body.temperature = 0;
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.topP !== undefined) body.top_p = params.topP;
  if (params.topK !== undefined) body.top_k = params.topK;
  if (params.minP !== undefined) body.min_p = params.minP;
  if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty;
  if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty;
  if (params.seed !== undefined) body.seed = params.seed;
  Object.assign(body, extra ?? {});
  return body;
}

export async function streamChat(
  body: Record<string, unknown>,
  signal: AbortSignal,
  cb: ChatStreamCallbacks,
): Promise<void> {
  const t0 = performance.now();
  const meta: MessageMeta = {};
  let firstContentAt: number | null = null;

  const finish = () => {
    if (firstContentAt !== null) meta.ttftMs = firstContentAt - t0;
    cb.onDone?.(meta);
  };

  try {
    const r = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => '');
      let detail = `HTTP ${r.status}`;
      try {
        const j = JSON.parse(text);
        detail = j?.error?.message || j?.error?.code || detail;
      } catch {
        if (text) detail = text.slice(0, 400);
      }
      cb.onError?.(`engine request failed: ${detail}`);
      return;
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue; // skip comments / keep-alives / event: lines
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') {
          finish();
          return;
        }
        let chunk: Record<string, any>;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        if (chunk.timings) {
          const t = chunk.timings;
          meta.promptTokPerSec = t.prompt_per_second;
          meta.decodeTokPerSec = t.predicted_per_second;
          meta.cachedTokens = t.cache_n;
          meta.promptTokens = t.cache_n + t.prompt_n;
          meta.completionTokens = t.predicted_n;
          if (t.draft_n !== undefined) meta.draftN = t.draft_n;
          if (t.draft_n_accepted !== undefined) meta.draftNAccepted = t.draft_n_accepted;
        }
        if (chunk.usage) {
          meta.promptTokens = chunk.usage.prompt_tokens ?? meta.promptTokens;
          meta.completionTokens = chunk.usage.completion_tokens ?? meta.completionTokens;
          meta.cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? meta.cachedTokens;
          meta.reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens;
        }
        const choice = chunk.choices?.[0];
        if (choice) {
          const d = choice.delta ?? {};
          if (d.reasoning_content) cb.onReasoningDelta?.(d.reasoning_content);
          if (d.content) {
            if (firstContentAt === null) firstContentAt = performance.now();
            cb.onContentDelta?.(d.content);
          }
          if (choice.finish_reason) meta.finishReason = choice.finish_reason;
        }
        if (chunk.usage) cb.onUsage?.(chunk.usage, meta);
      }
    }
    finish();
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      meta.finishReason = meta.finishReason || 'cancelled';
      finish();
      return;
    }
    cb.onError?.(e instanceof Error ? e.message : String(e));
  }
}

export function attachmentsToParts(att: ChatAttachment[]): Array<Record<string, unknown>> | null {
  if (!att.length) return null;
  return att.map((a) =>
    a.kind === 'image'
      ? { type: 'image_url', image_url: { url: a.dataUrl } }
      : { type: 'video_url', video_url: { url: a.dataUrl } },
  );
}

export type { ChatAttachment };
