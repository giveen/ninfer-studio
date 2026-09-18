import { SlidersHorizontal, Terminal, Video } from 'lucide-react';
import { Field, NumberField, SectionCard, SelectField, TextField, Toggle } from '../../components/ui';
import { LOG_LEVELS } from '../../lib/presets';
import type { EngineProfile } from '../../lib/types';

interface AdvancedTabProps {
  profile: EngineProfile;
  set: <K extends keyof EngineProfile>(k: K, v: EngineProfile[K]) => void;
  setU: <K extends keyof EngineProfile>(k: K, v: EngineProfile[K] | undefined) => void;
}

export function AdvancedTab({ profile, set, setU }: AdvancedTabProps) {
  const grid3 = 'grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-3';
  return (
    <div className="space-y-4">
      <SectionCard title="Vision & media" description="Vision is fixed at startup; without --vision, image/video requests are rejected." icon={<Video size={15} />} collapsible>
        <div className={grid3}>
          <div className="flex flex-col gap-2">
            <Toggle checked={!!profile.vision} onChange={(v) => set('vision', v)} label="Enable vision" hint="Loads Vision weights, expands the unified workspace, and enables image/video input. Can combine with DFlash/DFlash2." />
          </div>
          <Field label="Media cache (MiB)" hint="LRU-retained prepared BF16 media payloads; 0 disables retention.">
            <NumberField value={profile.mediaCacheMib ?? null} onChange={(v) => set('mediaCacheMib', v)} onEmpty={() => setU('mediaCacheMib', undefined)} min={0} step={128} placeholder="1024" />
          </Field>
          <Field label="Media live budget (MiB)" hint="All live prepared BF16 payloads (cache, request, or runtime-referenced).">
            <NumberField value={profile.mediaLiveMib ?? null} onChange={(v) => set('mediaLiveMib', v)} onEmpty={() => setU('mediaLiveMib', undefined)} min={0} step={128} placeholder="2048" />
          </Field>
          <Field label="Media preprocess threads" hint="Bounded host worker pool for media cache misses (decode → resize → BF16-pack). 0 = up to 16 from host concurrency.">
            <NumberField value={profile.mediaPreprocessThreads ?? null} onChange={(v) => set('mediaPreprocessThreads', v)} onEmpty={() => setU('mediaPreprocessThreads', undefined)} min={0} max={16} placeholder="auto" />
          </Field>
          <Field label="Max request size (MiB)" hint="Body-size limit enforced before JSON parsing (413 request_too_large).">
            <NumberField value={profile.maxRequestMib ?? null} onChange={(v) => set('maxRequestMib', v)} onEmpty={() => setU('maxRequestMib', undefined)} min={1} placeholder="384" />
          </Field>
          <div />
        </div>
      </SectionCard>

      <SectionCard title="Sampling defaults" description="Process-wide defaults. Order: model/preset → flags → request → --greedy forces temp 0." icon={<SlidersHorizontal size={15} />} collapsible>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <Toggle checked={!!profile.noThinking} onChange={(v) => set('noThinking', v)} label="Disable thinking by default" hint="Engine-wide default: no chain-of-thought unless a request asks for it." />
            <Toggle checked={!!profile.preserveThinking} onChange={(v) => set('preserveThinking', v)} label="Preserve closed-turn reasoning" hint="Keep closed reasoning in served history so follow-ups build on prior thinking." />
            <Toggle checked={!!profile.greedy} onChange={(v) => set('greedy', v)} label="Greedy decoding" hint="Forces temperature 0 and deterministic decoding; overrides model and request sampling fields." />
          </div>
          <div className={grid3}>
            <Field label="Temperature" hint="Process-level temperature override; unset uses the registered model/prompt-mode preset.">
              <NumberField value={profile.temperature ?? null} onChange={(v) => set('temperature', v)} onEmpty={() => setU('temperature', undefined)} min={0} max={2} step={0.1} placeholder="model preset" />
            </Field>
            <Field label="Top-p">
              <NumberField value={profile.topP ?? null} onChange={(v) => set('topP', v)} onEmpty={() => setU('topP', undefined)} min={0} max={1} step={0.05} placeholder="model preset" />
            </Field>
            <Field label="Top-k" hint="0..20; zero selects the top-20 cap.">
              <NumberField value={profile.topK ?? null} onChange={(v) => set('topK', v)} onEmpty={() => setU('topK', undefined)} min={0} max={20} placeholder="model preset" />
            </Field>
            <Field label="Min-p">
              <NumberField value={profile.minP ?? null} onChange={(v) => set('minP', v)} onEmpty={() => setU('minP', undefined)} min={0} max={1} step={0.05} placeholder="model preset" />
            </Field>
            <Field label="Presence penalty">
              <NumberField value={profile.presencePenalty ?? null} onChange={(v) => set('presencePenalty', v)} onEmpty={() => setU('presencePenalty', undefined)} min={-2} max={2} step={0.1} placeholder="model preset" />
            </Field>
            <Field label="Frequency penalty">
              <NumberField value={profile.frequencyPenalty ?? null} onChange={(v) => set('frequencyPenalty', v)} onEmpty={() => setU('frequencyPenalty', undefined)} min={-2} max={2} step={0.1} placeholder="model preset" />
            </Field>

            <Field label="Seed" hint="Fixed seed when a request omits one; unset = fresh random seed per request.">
              <NumberField value={profile.seed ?? null} onChange={(v) => set('seed', v)} onEmpty={() => setU('seed', undefined)} min={0} placeholder="random" />
            </Field>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Logging, storage & misc" description="Log verbosity, request JSONL, response-store budgets, context-cost presets, CORS." icon={<Terminal size={15} />} collapsible defaultCollapsed>
        <div className={grid3}>
          <Field label="Log level" hint="Pretty stderr verbosity for operational records.">
            <SelectField value={profile.logLevel || ''} onChange={(v) => setU('logLevel', v || undefined)} options={[{ value: '', label: 'default (info)' }, ...LOG_LEVELS.map((l) => ({ value: l, label: l }))]} />
          </Field>
          <Field label="Stats interval (ms)" hint="Aggregate throughput report interval on stderr; 0 disables.">
            <NumberField value={profile.logStatsIntervalMs ?? null} onChange={(v) => set('logStatsIntervalMs', v)} onEmpty={() => setU('logStatsIntervalMs', undefined)} min={0} step={500} placeholder="5000" />
          </Field>
          <Field label="Request log (JSONL file)" hint="Append full-precision server/request records (schema v20). Parent directory must exist.">
            <TextField value={profile.requestLogJsonl || ''} onChange={(v) => setU('requestLogJsonl', v || undefined)} placeholder="disabled" />
          </Field>
          <Field label="Response store records" hint="Maximum locally retained Responses objects (LRU).">
            <NumberField value={profile.responseStoreMaxRecords ?? null} onChange={(v) => set('responseStoreMaxRecords', v)} onEmpty={() => setU('responseStoreMaxRecords', undefined)} min={1} placeholder="1024" />
          </Field>
          <Field label="Response store budget (MiB)">
            <NumberField value={profile.responseStoreMaxMib ?? null} onChange={(v) => set('responseStoreMaxMib', v)} onEmpty={() => setU('responseStoreMaxMib', undefined)} min={1} placeholder="256" />
          </Field>
          <Field label="Context-cost presets (file)" hint="Optional runtime context-cost preset registry; malformed file aborts startup.">
            <TextField value={profile.contextCostPresets || ''} onChange={(v) => setU('contextCostPresets', v || undefined)} placeholder="compiled defaults" />
          </Field>
          <div className="flex items-end pb-1">
            <Toggle checked={!!profile.cors} onChange={(v) => set('cors', v)} label="Permissive browser CORS" hint="Adds permissive CORS headers for browser clients." />
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
