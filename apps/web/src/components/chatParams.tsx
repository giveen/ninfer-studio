// Composer parameter popover (sampling/thinking/humanize/presets) and the
// context-limit meter shown alongside it.

import { useState } from 'react';
import { Gauge, Save, X } from 'lucide-react';
import type { ChatParams, SavedChatParams } from '../lib/types';
import { VOICE_PROFILES, type VoiceProfile } from '../lib/notai';
import { formatTokens } from '../lib/format';
import { DEFAULT_PARAMS } from '../lib/chatHelpers';
import { Button, cn, NumberField, SelectField, Toggle } from './ui';

// ---------------------------------------------------------------------------
// Composer parameter popover
// ---------------------------------------------------------------------------
export function ParamsPopover({
  params,
  setParams,
  open,
  setOpen,
  disabled,
  presets,
  onSavePreset,
  onLoadPreset,
  onDeletePreset,
}: {
  params: ChatParams;
  setParams: (p: ChatParams) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
  disabled?: boolean;
  presets: SavedChatParams[];
  onSavePreset: (name: string) => void;
  onLoadPreset: (id: string) => void;
  onDeletePreset: (id: string) => void;
}) {
  const set = (patch: Partial<ChatParams>) => setParams({ ...params, ...patch });
  const row = 'grid grid-cols-[150px_1fr] items-center gap-3';
  const lab = 'text-[12px] text-mute';
  const num = 'w-24';
  const [presetName, setPresetName] = useState('');
  return (
    <div className="w-[430px] rounded-xl border border-line bg-panel p-4 shadow-2xl">
      <div className="space-y-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Toggle checked={params.thinking} onChange={(v) => set({ thinking: v, ...(v ? {} : { reasoningEffort: '' }) })} label="Thinking" hint="Chain-of-thought before the answer. The engine streams reasoning_content separately from the response text." />
            <Toggle checked={!!params.preserveThinking} onChange={(v) => set({ preserveThinking: v })} label="Preserve reasoning in history" hint="Send closed reasoning from earlier turns back with the request, so follow-ups build on prior thinking." />
          </div>
        </div>
        {params.thinking && (
          <div className={row}>
            <span className={lab}>Reasoning effort</span>
            <SelectField
              value={params.reasoningEffort || ''}
              onChange={(v) => set({ reasoningEffort: v as ChatParams['reasoningEffort'] })}
              options={[
                { value: '', label: 'template default' },
                { value: 'low', label: 'low' },
                { value: 'medium', label: 'medium' },
                { value: 'xhigh', label: 'xhigh' },
              ]}
            />
          </div>
        )}
        <div className={row}>
          <span className={lab}>Max output tokens</span>
          <div className={num}>
            <NumberField value={params.maxTokens ?? null} onChange={(v) => set({ maxTokens: v })} onEmpty={() => set({ maxTokens: undefined })} min={0} placeholder="engine default" />
          </div>
        </div>
        <div className="h-px bg-line" />
        <div className={row}>
          <span className={lab}>Temperature</span>
          <div className={num}>
            <NumberField value={params.temperature ?? null} onChange={(v) => set({ temperature: v, greedy: false })} onEmpty={() => set({ temperature: undefined, greedy: false })} min={0} max={2} step={0.1} placeholder="model default" />
          </div>
        </div>
        <div className={row}>
          <span className={lab}>Top-p</span>
          <div className={num}>
            <NumberField value={params.topP ?? null} onChange={(v) => set({ topP: v })} onEmpty={() => set({ topP: undefined })} min={0} max={1} step={0.05} placeholder="model default" />
          </div>
        </div>
        <div className={row}>
          <span className={lab}>Top-k</span>
          <div className={num}>
            <NumberField value={params.topK ?? null} onChange={(v) => set({ topK: v })} onEmpty={() => set({ topK: undefined })} min={0} max={20} placeholder="model default" />
          </div>
        </div>
        <div className={row}>
          <span className={lab}>Min-p</span>
          <div className={num}>
            <NumberField value={params.minP ?? null} onChange={(v) => set({ minP: v })} onEmpty={() => set({ minP: undefined })} min={0} max={1} step={0.05} placeholder="model default" />
          </div>
        </div>
        <div className={row}>
          <span className={lab}>Presence penalty</span>
          <div className={num}>
            <NumberField value={params.presencePenalty ?? null} onChange={(v) => set({ presencePenalty: v })} onEmpty={() => set({ presencePenalty: undefined })} step={0.1} placeholder="model default" />
          </div>
        </div>
        <div className={row}>
          <span className={lab}>Frequency penalty</span>
          <div className={num}>
            <NumberField value={params.frequencyPenalty ?? null} onChange={(v) => set({ frequencyPenalty: v })} onEmpty={() => set({ frequencyPenalty: undefined })} step={0.1} placeholder="0" />
          </div>
        </div>
        <div className={row}>
          <span className={lab}>Seed (0 = fresh per request)</span>
          <div className={num}>
            <NumberField value={params.seed ?? null} onChange={(v) => set({ seed: v })} onEmpty={() => set({ seed: undefined })} min={0} placeholder="random" />
          </div>
        </div>
        <div className="flex items-center">
          <Toggle checked={!!params.greedy} onChange={(v) => set({ greedy: v, ...(v ? { temperature: 0 } : { temperature: undefined }) })} label="Greedy (exact argmax)" hint="temperature 0 with no sampling — deterministic output. Overrides the other sampling fields while on." />
        </div>
        <div className="h-px bg-line" />
        <div className="flex items-center">
          <Toggle checked={!!params.humanize} onChange={(v) => set({ humanize: v })} label="Humanize replies (Not-Ai)" hint="Rewrite replies to sound human — no em dashes, no buzzwords, no empty framing. Replies that trip the tell-gate are silently re-written." />
        </div>
        <div className={row}>
          <span className={lab}>Voice / style</span>
          <SelectField
            value={(params.voiceProfile as VoiceProfile) || 'personal'}
            onChange={(v) => set({ voiceProfile: v })}
            disabled={!params.humanize}
            options={VOICE_PROFILES.map((p) => ({ value: p.value, label: p.label }))}
          />
        </div>
        <div className="h-px bg-line" />
        <div className={row}>
          <span className={lab} title="Once a reply's usage crosses this share of the model's context window, the conversation is silently folded into a summary checkpoint so the next message doesn't risk truncation.">Auto-compact at %</span>
          <div className={num}>
            <NumberField value={params.compactAt ?? null} onChange={(v) => set({ compactAt: v })} onEmpty={() => set({ compactAt: undefined })} min={20} max={95} placeholder="80" />
          </div>
        </div>
        <div className="h-px bg-line" />
        <div className={row}>
          <span className={lab}>System prompt</span>
          <textarea
            value={params.systemPrompt || ''}
            onChange={(e) => set({ systemPrompt: e.target.value })}
            rows={3}
            placeholder="optional system instructions"
            className="w-full resize-y rounded-lg border border-line bg-inset px-2.5 py-2 text-[12.5px] text-ink placeholder:text-faint focus:border-accent/50 focus:outline-none"
          />
        </div>
        <div className="h-px bg-line" />
        <div className="space-y-2">
          <span className={lab}>Presets (sampling + system prompt bundle)</span>
          {presets.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {presets.map((p) => (
                <span key={p.id} className="inline-flex items-center gap-1 rounded-md border border-line bg-inset px-2 py-1 text-[11.5px] text-mute">
                  <button type="button" title="Load this preset" onClick={() => onLoadPreset(p.id)} className="hover:text-ink">
                    {p.name}
                  </button>
                  <button type="button" title="Delete preset" onClick={() => onDeletePreset(p.id)} className="text-faint hover:text-danger">
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-1.5">
            <input
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && presetName.trim()) {
                  onSavePreset(presetName);
                  setPresetName('');
                }
              }}
              placeholder="preset name"
              className="min-w-0 flex-1 rounded-lg border border-line bg-inset px-2.5 py-1.5 text-[12px] text-ink placeholder:text-faint focus:border-accent/50 focus:outline-none"
            />
            <Button
              size="sm"
              variant="subtle"
              disabled={!presetName.trim()}
              onClick={() => {
                onSavePreset(presetName);
                setPresetName('');
              }}
            >
              <Save size={12} /> save current
            </Button>
          </div>
        </div>
        <div className="flex justify-between">
          <Button size="sm" variant="subtle" onClick={() => set({ ...DEFAULT_PARAMS, maxTokens: undefined })}>
            reset to defaults
          </Button>
          <Button size="sm" onClick={() => setOpen(false)}>
            done
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context-limit indicator — how close the latest request's context is to the
// engine's --max-context, so long sessions don't silently truncate.
// ---------------------------------------------------------------------------
export function ContextMeter({ used, limit }: { used: number | null; limit: number | null }) {
  if (limit == null) {
    return (
      <div className="flex items-center gap-1.5 text-[10.5px] text-faint">
        <Gauge size={11} /> context limit not reported — set --max-context to track usage
      </div>
    );
  }
  const pct = used ? Math.min(100, (used / limit) * 100) : 0;
  const pctLabel = `${pct.toFixed(0)}% of max-context`;
  const bar = pct > 90 ? 'bg-danger' : pct > 75 ? 'bg-warn' : 'bg-accent';
  // Proactive awareness: warn before the engine silently truncates older
  // context once the running total bumps into --max-context.
  const warn =
    pct > 90
      ? 'context nearly full — older messages will be truncated'
      : pct > 75
        ? `${pctLabel}: approaching the limit, start a new chat soon`
        : null;
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 text-[10.5px]',
        pct > 90 ? 'text-danger' : pct > 75 ? 'text-warn' : 'text-faint',
      )}
      title={used != null ? `${formatTokens(used)} / ${formatTokens(limit)} tokens` : 'no requests yet'}
    >
      <Gauge size={11} className={pct > 75 ? '' : 'text-faint'} />
      <span className="text-faint">ctx</span>
      <span className="relative h-1 w-20 overflow-hidden rounded-full bg-line">
        <span className={cn('absolute inset-y-0 left-0 rounded-full transition-[width] duration-300', bar)} style={{ width: `${pct}%` }} />
      </span>
      <span className="font-mono">{pctLabel}</span>
      {used != null && <span className="font-mono text-faint">{formatTokens(used)} / {formatTokens(limit)}</span>}
      {warn && <span className="ml-1 truncate text-[10px]">{warn}</span>}
    </div>
  );
}
