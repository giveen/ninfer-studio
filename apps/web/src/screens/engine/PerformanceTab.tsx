import { Gauge, Layers3, Zap } from 'lucide-react';
import { Field, NumberField, SectionCard, Segmented, SelectField, Toggle, cn } from '../../components/ui';
import { KV_DTYPE_OPTIONS } from '../../lib/presets';
import type { AppSettings, EngineProfile } from '../../lib/types';

interface SpecOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

interface PerformanceTabProps {
  profile: EngineProfile;
  set: <K extends keyof EngineProfile>(k: K, v: EngineProfile[K]) => void;
  setU: <K extends keyof EngineProfile>(k: K, v: EngineProfile[K] | undefined) => void;
  settings: AppSettings | null;
  onReasoningEffort: (v: string) => void;
  specOptions: SpecOption[];
  specSupported: { mtp: boolean; dflash: boolean; dflash2: boolean } | null;
  draftRange: number[];
}

export function PerformanceTab({ profile, set, setU, settings, onReasoningEffort, specOptions, specSupported, draftRange }: PerformanceTabProps) {
  const grid3 = 'grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-3';
  return (
    <div className="space-y-4">
      <SectionCard title="Context & memory" description="Per-sequence context ceiling and the shared Main-Text KV pool. 'auto' sizes from free GPU memory (1 GiB headroom)." icon={<Gauge size={15} />} collapsible>
        <div className={grid3}>
          <Field label="Max context" hint="Per-sequence logical token ceiling. Native model limit is 262,144; practical allocation depends on artifact, media, and KV type.">
            <NumberField value={profile.maxContext ?? null} onChange={(v) => set('maxContext', v)} onEmpty={() => setU('maxContext', undefined)} min={0} max={262144} placeholder="serve default 8192" />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-wider text-mute">KV capacity</span>
            <div className="flex items-center gap-2">
              <Segmented
                value={profile.kvCapacity === 'auto' ? 'auto' : profile.kvCapacity === undefined || profile.kvCapacity === '' ? 'follow' : 'fixed'}
                onChange={(v) => {
                  if (v === 'auto') set('kvCapacity', 'auto');
                  else if (v === 'follow') setU('kvCapacity', undefined);
                  else set('kvCapacity', profile.kvCapacity && profile.kvCapacity !== 'auto' ? profile.kvCapacity : 32768);
                }}
                options={[
                  { value: 'follow', label: 'follow', hint: 'omit flag: pool follows --max-context' },
                  { value: 'auto', label: 'auto', hint: 'maximize from remaining GPU memory, 1 GiB headroom' },
                  { value: 'fixed', label: 'fixed', hint: 'explicit token capacity (rounded to 64-token pages)' },
                ]}
              />
              {typeof profile.kvCapacity === 'number' ? (
                <div className="w-32">
                  <NumberField value={profile.kvCapacity} onChange={(v) => set('kvCapacity', v)} onEmpty={() => setU('kvCapacity', undefined)} min={0} />
                </div>
              ) : null}
            </div>
            <p className="text-[11px] leading-snug text-faint">Serves active requests and retained prefixes. Explicit values stay fixed for the process lifetime.</p>
          </div>
          <Field label="Prefill chunk" hint="Positive text-prefill chunk size, in multiples of 128 tokens.">
            <NumberField value={profile.prefillChunk ?? null} onChange={(v) => set('prefillChunk', v)} onEmpty={() => setU('prefillChunk', undefined)} min={128} step={128} placeholder="1024" />
          </Field>
          <Field label="Default max tokens" hint="Output budget applied when a request omits max_tokens.">
            <NumberField value={profile.defaultMaxTokens ?? null} onChange={(v) => set('defaultMaxTokens', v)} onEmpty={() => setU('defaultMaxTokens', undefined)} min={0} placeholder="8192" />
          </Field>
          <Field label="Default thinking budget" hint="Cap on model-origin thinking tokens for thinking-enabled requests. Unset lets each request choose.">
            <SelectField
              value={profile.defaultThinkingBudget != null ? String(profile.defaultThinkingBudget) : ''}
              onChange={(v) => setU('defaultThinkingBudget', v ? Number(v) : undefined)}
              options={[
                { value: '', label: 'unset (request chooses)' },
                { value: '1024', label: '1,024 tokens' },
                { value: '2048', label: '2,048 tokens' },
                { value: '4096', label: '4,096 tokens' },
                { value: '8192', label: '8,192 tokens' },
                { value: '16384', label: '16,384 tokens' },
                { value: '32768', label: '32,768 tokens' },
              ]}
            />
          </Field>
          <Field label="Default reasoning effort" hint="Global default applied to every request via the top-level reasoning_effort field. The Studio chat and external clients inherit it unless they set reasoning_effort themselves.">
            <SelectField
              value={settings?.reasoningEffort ?? ''}
              onChange={onReasoningEffort}
              options={[
                { value: '', label: 'unset (request chooses)' },
                { value: 'low', label: 'low' },
                { value: 'medium', label: 'medium' },
                { value: 'high', label: 'high' },
                { value: 'xhigh', label: 'x-high' },
              ]}
            />
          </Field>
        </div>
      </SectionCard>

      <SectionCard title="Scheduling" description="Fixed 1–8 request lanes with bounded FIFO ingress. No preemption or QoS." icon={<Zap size={15} />} collapsible>
        <div className={grid3}>
          <Field label="Max concurrency" hint="Maximum admitted concurrent requests (1..8), fixed at startup.">
            <NumberField value={profile.maxConcurrency ?? null} onChange={(v) => set('maxConcurrency', Math.max(1, Math.min(8, v)))} onEmpty={() => setU('maxConcurrency', undefined)} min={1} max={8} placeholder="1" />
          </Field>
          <Field label="Max pending requests" hint="Extra requests allowed to wait in the FIFO queue for admission.">
            <NumberField value={profile.maxPendingRequests ?? null} onChange={(v) => set('maxPendingRequests', v)} onEmpty={() => setU('maxPendingRequests', undefined)} min={0} placeholder="16" />
          </Field>
          <Field label="Pending timeout (ms)" hint="Maximum preparation-plus-admission wait before a queued request is rejected.">
            <NumberField value={profile.pendingTimeoutMs ?? null} onChange={(v) => set('pendingTimeoutMs', v)} onEmpty={() => setU('pendingTimeoutMs', undefined)} min={0} placeholder="30000" />
          </Field>
        </div>
      </SectionCard>

      <SectionCard title="KV cache & context cache" description="KV pool storage format, plus device/host checkpoint tiers for long-context reuse." icon={<Layers3 size={15} />} collapsible>
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
            <Field label="KV dtype" hint="KV-cache storage: bf16, int8, fp8, nvfp4, or k8v4 (INT8 group-64 KV is the published benchmark format).">
              <Segmented value={(profile.kvDtype as string) || 'bf16'} onChange={(v) => set('kvDtype', v as EngineProfile['kvDtype'])} options={[...KV_DTYPE_OPTIONS]} />
            </Field>
            <Toggle checked={!!profile.noPrefixReuse} onChange={(v) => set('noPrefixReuse', v)} label="Disable prefix reuse" hint="Root-only Engine mode. Cannot be combined with explicit context-cache capacity flags." />
            <Toggle checked={!!profile.noCudaGraph} onChange={(v) => set('noCudaGraph', v)} label="Disable CUDA Graph decode" hint="Decode uses eager kernel launches instead of captured graphs." />
          </div>
          {profile.noPrefixReuse && <p className="text-[12px] text-warn">Prefix reuse disabled: the context-cache tier options below are unavailable and will not be sent.</p>}
          <div className={cn(grid3, profile.noPrefixReuse && 'pointer-events-none opacity-40')}>
            <Field label="Device state slots" hint="Extra Device checkpoint StateImages beyond the active-lane guarantee (default = max-concurrency).">
              <NumberField value={profile.deviceStateSlots ?? null} onChange={(v) => set('deviceStateSlots', v)} onEmpty={() => setU('deviceStateSlots', undefined)} min={0} placeholder="= C" />
            </Field>
            <Field label="Host state slots" hint="Pinned Host StateImage capacity for inactive continuations under Device pressure.">
              <NumberField value={profile.hostStateSlots ?? null} onChange={(v) => set('hostStateSlots', v)} onEmpty={() => setU('hostStateSlots', undefined)} min={0} placeholder="8" />
            </Field>
            <Field label="Host KV (MiB)" hint="Shared pinned Host Main/Backend KV capacity beyond active StateImages.">
              <NumberField value={profile.hostKvMib ?? null} onChange={(v) => set('hostKvMib', v)} onEmpty={() => setU('hostKvMib', undefined)} min={0} step={512} placeholder="8192" />
            </Field>
            <Field label="Max private continuations" hint="Private continuation descriptor capacity (default 2 × max-concurrency).">
              <NumberField value={profile.maxPrivateContinuations ?? null} onChange={(v) => set('maxPrivateContinuations', v)} onEmpty={() => setU('maxPrivateContinuations', undefined)} min={0} placeholder="auto" />
            </Field>
            <Field label="Max shared prefixes" hint="Engine-wide shared stable-prefix descriptor capacity (default max(C, 4)).">
              <NumberField value={profile.maxSharedPrefixes ?? null} onChange={(v) => set('maxSharedPrefixes', v)} onEmpty={() => setU('maxSharedPrefixes', undefined)} min={0} placeholder="auto" />
            </Field>
            <Field label="Long anchors / continuation" hint="Private long-anchor limit per continuation (default 2).">
              <NumberField value={profile.maxLongAnchorsPerContinuation ?? null} onChange={(v) => set('maxLongAnchorsPerContinuation', v)} onEmpty={() => setU('maxLongAnchorsPerContinuation', undefined)} min={0} placeholder="2" />
            </Field>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Speculative decoding" description="Set at startup: one backend, one draft window. MTP 1–5; DFlash/DFlash2 1–15 (7 recommended)." icon={<Zap size={15} />} collapsible>
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
            <Field label="Backend" hint="Selects which speculative weights are resident at startup. None loads the smallest profile.">
              <Segmented value={(profile.spec as string) || ''} onChange={(v) => { set('spec', v as EngineProfile['spec']); if (!v) { setU('draftTokens', undefined); setU('lmHeadDraft', undefined); } else if (profile.draftTokens === undefined) set('draftTokens', v === 'mtp' ? 3 : 7); }} options={specOptions} />
            </Field>
            {profile.spec && (
              <>
                <Field label={`Draft tokens (${draftRange[0]}..${draftRange[1]})`} hint={profile.spec === 'mtp' ? 'MTP draft positions 1..5. Published results use 3.' : profile.spec === 'dflash' ? 'DFlash drafts 1..15; 7 → measured block length 8.' : 'DFlash2 drafts 1..15; 7 is the checkpoint recommendation.'}>
                  <div className="w-28">
                    <NumberField value={profile.draftTokens ?? null} onChange={(v) => set('draftTokens', Math.max(draftRange[0], Math.min(draftRange[1], v)))} onEmpty={() => setU('draftTokens', undefined)} min={draftRange[0]} max={draftRange[1]} placeholder={profile.spec === 'mtp' ? '3' : '7'} />
                  </div>
                </Field>
                <Toggle checked={!!profile.lmHeadDraft} onChange={(v) => set('lmHeadDraft', v)} label="Optimized proposal head" hint="Loads the optimized proposal head; requires a selected backend." />
              </>
            )}
          </div>
          {specSupported && (
            <p className="text-[11.5px] text-faint">
              For the selected artifact: {Object.entries(specSupported).map(([k, v]) => `${k}${v ? ' ✓' : ' ✗'}`).join('  ·  ')} — {profile.spec && !specSupported[profile.spec as 'mtp' | 'dflash' | 'dflash2'] && <span className="text-warn">the selected backend is not supported by this artifact.</span>}
            </p>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
