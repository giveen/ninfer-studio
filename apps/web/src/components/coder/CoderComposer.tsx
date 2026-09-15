import React from 'react';
import {
  BrainCircuit,
  Image,
  File,
  X,
  Paperclip,
  SlidersHorizontal,
  Plus,
  Square,
  Play,
} from 'lucide-react';
import { cn, Button, SelectField, NumberField, Toggle } from '../ui';
import { ChatAttachment } from '../../lib/types';
import type { CoderStore } from '../../lib/coderStore';
import { VOICE_PROFILES, type VoiceProfile } from '../../lib/notai';
import { CODING_LENSES } from '../../lib/coderLens';

export interface CoderParams {
  thinking: boolean;
  thinkLevel?: 'low' | 'medium' | 'high' | 'xhigh';
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  criticModel?: string;
  promptCache?: boolean;
  humanize?: boolean;
  voiceProfile?: string;
  reviewLens?: string;
  maxAgentSteps?: number;
  compactAt?: number;
  primaryProvider?: 'ninfer' | 'cloud';
  primaryCloudModel?: string;
  subagentProvider?: 'ninfer' | 'cloud';
  subagentCloudModel?: string;
}

export const DEFAULT_CODER_PARAMS: CoderParams = {
  thinking: true,
};

export type LlmPhase = {
  stage: 'prefill' | 'decode';
  label: string;
  since: number;
  chars: number;
};

export type QueuedItem = {
  text: string;
  attachments: ChatAttachment[];
};

export interface CoderComposerProps {
  llmPhase: LlmPhase | null;
  nowTick: number;
  attachments: ChatAttachment[];
  removeAttachment: (path: string) => void;
  showCoderParams: boolean;
  setShowCoderParams: React.Dispatch<React.SetStateAction<boolean>>;
  coderParams: CoderParams;
  setCoderParams: React.Dispatch<React.SetStateAction<CoderParams>>;
  appConfig: any;
  openPicker: () => void;
  running: boolean;
  activeWs: string;
  input: string;
  setInput: (val: string) => void;
  onSubmit: () => void;
  pendingQuestion: string | null;
  stop: () => void;
  runElsewhere: boolean;
  runConv: { ws: string; convId: string } | null;
  activeConv: string | null;
  queued: Record<string, QueuedItem[]>;
  setQueued: React.Dispatch<React.SetStateAction<Record<string, QueuedItem[]>>>;
  coderSafeMode: boolean;
  baseName: (path: string) => string;
  store: CoderStore;
  defaultMaxAgentSteps: number;
}

export const CoderComposer: React.FC<CoderComposerProps> = ({
  llmPhase,
  nowTick,
  attachments,
  removeAttachment,
  showCoderParams,
  setShowCoderParams,
  coderParams,
  setCoderParams,
  appConfig,
  openPicker,
  running,
  activeWs,
  input,
  setInput,
  onSubmit,
  pendingQuestion,
  stop,
  runElsewhere,
  runConv,
  activeConv,
  queued,
  setQueued,
  coderSafeMode,
  baseName,
  store,
  defaultMaxAgentSteps,
}) => {
  return (
    <div className="border-t border-line bg-panel p-3">
      {llmPhase && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-accent/25 bg-accent/8 px-2.5 py-1.5 text-[11.5px] text-mute">
          <BrainCircuit size={13} className="animate-pulse text-accent" />
          <span className="font-medium text-ink">
            {llmPhase.stage === 'prefill' ? 'Model reading context (prefill)' : 'Model writing (decode)'}
          </span>
          <span className="text-faint">
            · {llmPhase.label} · {((nowTick - llmPhase.since) / 1000).toFixed(1)}s · {llmPhase.chars.toLocaleString()} chars
          </span>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {attachments.map((a, i) => (
            <span key={a.path || i} className="inline-flex items-center gap-1 rounded-full border border-line bg-panel2 px-2 py-0.5 text-[11.5px] text-ink">
              {a.kind === 'image' ? <Image size={11} /> : <File size={11} />} {a.name}
              {a.path && (
                <button type="button" onClick={() => removeAttachment(a.path!)} className="text-faint hover:text-danger" title="Remove">
                  <X size={11} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {showCoderParams && (
        <div className="rounded-md border border-line bg-panel2 px-3 py-2 mb-2">
          <div className="flex items-center gap-4 flex-wrap">
            {appConfig?.cloudProviderEnabled && (
              <>
                <div className="flex w-full items-center gap-4 flex-wrap pb-1 border-b border-line/50">
                  <span className="text-[11.5px] font-medium uppercase tracking-wider text-faint">Primary Agent</span>
                  <label className="flex items-center gap-1.5 text-[12px] text-mute">
                    provider
                    <SelectField
                      value={coderParams.primaryProvider || 'ninfer'}
                      onChange={(v: string) => setCoderParams({ ...coderParams, primaryProvider: v as 'ninfer' | 'cloud' })}
                      options={[
                        { value: 'ninfer', label: 'Local (ninfer)' },
                        { value: 'cloud', label: 'Cloud API' },
                      ]}
                    />
                  </label>
                  {coderParams.primaryProvider === 'cloud' && (
                    <label className="flex items-center gap-1.5 text-[12px] text-mute">
                      cloud model
                      <SelectField
                        value={coderParams.primaryCloudModel || appConfig?.cloudProviderDefaultModel || 'gpt-4o'}
                        onChange={(v: string) => setCoderParams({ ...coderParams, primaryCloudModel: v })}
                        options={Array.from(
                          new Set([
                            'gpt-4o',
                            'gpt-4o-mini',
                            'gpt-4-turbo',
                            'o1',
                            'o3-mini',
                            ...(appConfig?.cloudProviderDefaultModel ? [appConfig.cloudProviderDefaultModel] : []),
                            ...(coderParams.primaryCloudModel ? [coderParams.primaryCloudModel] : []),
                          ])
                        ).map((m) => ({ value: m, label: m }))}
                      />
                      <input
                        type="text"
                        value={coderParams.primaryCloudModel || ''}
                        onChange={(e) => setCoderParams({ ...coderParams, primaryCloudModel: e.target.value })}
                        placeholder={appConfig?.cloudProviderDefaultModel || 'gpt-4o'}
                        className="w-28 rounded border border-line bg-inset px-2 py-1 text-[11px] text-ink placeholder:text-faint focus:border-accent/50 focus:outline-none"
                      />
                    </label>
                  )}
                </div>
                <div className="flex w-full items-center gap-4 flex-wrap pb-2 border-b border-line/50">
                  <span className="text-[11.5px] font-medium uppercase tracking-wider text-faint">Subagent (Worker)</span>
                  <label className="flex items-center gap-1.5 text-[12px] text-mute">
                    provider
                    <SelectField
                      value={coderParams.subagentProvider || 'ninfer'}
                      onChange={(v: string) => setCoderParams({ ...coderParams, subagentProvider: v as 'ninfer' | 'cloud' })}
                      options={[
                        { value: 'ninfer', label: 'Local (ninfer)' },
                        { value: 'cloud', label: 'Cloud API' },
                      ]}
                    />
                  </label>
                  {coderParams.subagentProvider === 'cloud' && (
                    <label className="flex items-center gap-1.5 text-[12px] text-mute">
                      cloud model
                      <SelectField
                        value={coderParams.subagentCloudModel || appConfig?.cloudProviderDefaultModel || 'gpt-4o-mini'}
                        onChange={(v: string) => setCoderParams({ ...coderParams, subagentCloudModel: v })}
                        options={Array.from(
                          new Set([
                            'gpt-4o-mini',
                            'gpt-4o',
                            'gpt-4-turbo',
                            'o1-mini',
                            'o3-mini',
                            ...(appConfig?.cloudProviderDefaultModel ? [appConfig.cloudProviderDefaultModel] : []),
                            ...(coderParams.subagentCloudModel ? [coderParams.subagentCloudModel] : []),
                          ])
                        ).map((m) => ({ value: m, label: m }))}
                      />
                      <input
                        type="text"
                        value={coderParams.subagentCloudModel || ''}
                        onChange={(e) => setCoderParams({ ...coderParams, subagentCloudModel: e.target.value })}
                        placeholder={appConfig?.cloudProviderDefaultModel || 'gpt-4o-mini'}
                        className="w-28 rounded border border-line bg-inset px-2 py-1 text-[11px] text-ink placeholder:text-faint focus:border-accent/50 focus:outline-none"
                      />
                    </label>
                  )}
                </div>
              </>
            )}
            <label className="flex items-center gap-1.5 text-[12px] text-mute">
              <Toggle checked={coderParams.thinking} onChange={(v: boolean) => setCoderParams({ ...coderParams, thinking: v })} /> thinking
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-mute" title="Reasoning effort sent to the engine as reasoning_effort (low/medium/high/xhigh). Default follows the thinking toggle; choosing a level forces thinking on.">
              think level
              <SelectField
                value={coderParams.thinkLevel || ''}
                onChange={(v: string) => setCoderParams({ ...coderParams, thinkLevel: (v || undefined) as CoderParams['thinkLevel'] })}
                options={[
                  { value: '', label: 'default' },
                  { value: 'low', label: 'low' },
                  { value: 'medium', label: 'medium' },
                  { value: 'high', label: 'high' },
                  { value: 'xhigh', label: 'xhigh' },
                ]}
              />
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-mute" title="Hard ceiling on agent turns per run — the run stops with a warning instead of looping forever once it's hit. Blank = default (60).">
              max steps
              <NumberField
                value={coderParams.maxAgentSteps ?? null}
                onChange={(v: number) => setCoderParams({ ...coderParams, maxAgentSteps: v })}
                onEmpty={() => setCoderParams({ ...coderParams, maxAgentSteps: undefined })}
                empty
                min={1}
                max={500}
                placeholder={String(defaultMaxAgentSteps)}
              />
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-mute" title="Once usage crosses this share of the model's context window, the run auto-summarizes and continues instead of risking truncation. Blank = default (80%).">
              compact at %
              <NumberField
                value={coderParams.compactAt ?? null}
                onChange={(v: number) => setCoderParams({ ...coderParams, compactAt: v })}
                onEmpty={() => setCoderParams({ ...coderParams, compactAt: undefined })}
                empty
                min={20}
                max={95}
                placeholder="80"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-mute" title="Mark the system prompt with cache_control so the engine can cache it across turns (prefix caching). Only enable if your engine supports it.">
              <Toggle checked={!!coderParams.promptCache} onChange={(v: boolean) => setCoderParams({ ...coderParams, promptCache: v })} /> prompt cache
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-mute">
              temp <NumberField value={coderParams.temperature ?? null} onChange={(v: number) => setCoderParams({ ...coderParams, temperature: v })} onEmpty={() => setCoderParams({ ...coderParams, temperature: undefined })} empty />
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-mute">
              top_p <NumberField value={coderParams.topP ?? null} onChange={(v: number) => setCoderParams({ ...coderParams, topP: v })} onEmpty={() => setCoderParams({ ...coderParams, topP: undefined })} empty />
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-mute">
              top_k <NumberField value={coderParams.topK ?? null} onChange={(v: number) => setCoderParams({ ...coderParams, topK: v })} onEmpty={() => setCoderParams({ ...coderParams, topK: undefined })} empty />
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-mute">
              seed <NumberField value={coderParams.seed ?? null} onChange={(v: number) => setCoderParams({ ...coderParams, seed: v })} onEmpty={() => setCoderParams({ ...coderParams, seed: undefined })} empty />
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-mute" title="Optional model id for the critic (defaults to the supervisor's model). Empty = same model reviews the diff.">
              critic
              <input
                value={coderParams.criticModel ?? ''}
                onChange={(e) => setCoderParams({ ...coderParams, criticModel: e.target.value })}
                placeholder="same model"
                className="w-28 bg-inset border border-line rounded px-1.5 py-0.5 text-[11px] outline-none focus:border-accent/50"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-mute" title="Rewrite the agent's user-facing summaries to sound human — no em dashes, no buzzwords, no empty framing. Content-only replies that trip the tell-gate are silently re-written.">
              <Toggle checked={!!coderParams.humanize} onChange={(v: boolean) => setCoderParams({ ...coderParams, humanize: v })} /> humanize
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-mute">
              voice
              <SelectField
                value={(coderParams.voiceProfile as VoiceProfile) || 'technical'}
                onChange={(v: string) => setCoderParams({ ...coderParams, voiceProfile: v })}
                disabled={!coderParams.humanize}
                options={VOICE_PROFILES.map((p) => ({ value: p.value, label: p.label }))}
              />
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-mute">
              lens
              <SelectField
                value={coderParams.reviewLens || ''}
                onChange={(v: string) => setCoderParams({ ...coderParams, reviewLens: v })}
                options={CODING_LENSES.map((l) => ({ value: l.value, label: l.label }))}
              />
            </label>
            <button type="button" onClick={() => setCoderParams({ ...DEFAULT_CODER_PARAMS })} className="ml-auto text-[11px] text-faint hover:text-ink">reset</button>
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="ghost" onClick={openPicker} disabled={running || !activeWs} title="Attach workspace files">
          <Paperclip size={14} />
        </Button>
        <Button variant="ghost" onClick={() => setShowCoderParams((v) => !v)} disabled={!activeWs} title="Sampling params (thinking, temperature, top_p, top_k, seed)">
          <SlidersHorizontal size={14} />
        </Button>
        <input
          className="flex-1 bg-inset border border-line rounded px-3 py-1.5 text-sm outline-none focus:border-accent/50"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
          placeholder={pendingQuestion ? "Use the popup above to approve or disapprove…" : !activeWs ? "Add a workspace to begin" : running ? "Queue another instruction for when this run finishes…" : "Instruct the coder agent..."}
          disabled={!activeWs || pendingQuestion !== null}
        />
        {running ? (
          <>
            <Button variant="ghost" onClick={onSubmit} disabled={!input.trim() && attachments.length === 0} title="Queue this for when the current run finishes"><Plus size={14} /> Queue</Button>
            <Button variant="danger" onClick={stop} disabled={runElsewhere}
              title={runElsewhere && runConv
                ? `Run is in ${baseName(runConv.ws)} / ${store.workspaces[runConv.ws]?.conversations[runConv.convId]?.title || '…'} — switch to that conversation to stop it.`
                : 'Stop the running agent'}><Square size={14} /> Stop</Button>
          </>
        ) : (
          <Button variant="primary" onClick={onSubmit} disabled={(!activeWs && attachments.length === 0) || pendingQuestion !== null}><Play size={14} /> Run</Button>
        )}
      </div>
      {activeConv && (queued[activeConv]?.length ?? 0) > 0 && (
        <div className="mt-2 space-y-1">
          {queued[activeConv].map((item, i) => (
            <div key={i} className="flex items-center gap-2 rounded border border-line bg-inset px-2 py-1 text-[11.5px] text-mute">
              <span className="shrink-0 font-mono text-[10px] text-faint">#{i + 1} queued</span>
              <span className="min-w-0 flex-1 truncate">{item.text}</span>
              <button
                type="button"
                title="Remove from queue"
                onClick={() => setQueued((q) => ({ ...q, [activeConv]: q[activeConv].filter((_, j) => j !== i) }))}
                className="shrink-0 rounded p-0.5 text-faint hover:bg-panel hover:text-danger"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {activeWs && (
        <div className={cn('mt-2 text-[10.5px]', coderSafeMode ? 'text-faint' : 'font-medium text-danger')}>
          {coderSafeMode
            ? `Agent runs shell commands locally in ${baseName(activeWs)} — destructive commands are blocked by Safe Mode.`
            : `Agent runs shell commands locally in ${baseName(activeWs)} — Safe Mode is OFF, destructive commands are allowed.`}
        </div>
      )}
    </div>
  );
};
