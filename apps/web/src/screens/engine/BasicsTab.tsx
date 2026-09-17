import { useMemo, useState } from 'react';
import { Box, ChevronDown, Sparkles } from 'lucide-react';
import { Field, NumberField, SectionCard, SelectField, TextField, Toggle, cn } from '../../components/ui';
import { PRESETS } from '../../lib/presets';
import type { EngineProfile, ModelArtifact } from '../../lib/types';

/** One preset card: the name applies the preset; the chevron toggles the
 *  (often long) description without triggering apply. Collapsed by default
 *  so the preset grid stays scannable. */
function PresetCard({ name, description, onApply }: { name: string; description: string; onApply: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="w-[220px] rounded-lg border border-line bg-inset transition-colors hover:border-accent/40 hover:bg-panel2">
      <div className="flex items-center gap-1 pr-1">
        <button type="button" onClick={onApply} className="min-w-0 flex-1 px-3 py-2 text-left text-[12.5px] font-semibold text-ink">
          {name}
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={open ? 'Hide description' : 'Show description'}
          className="shrink-0 rounded p-1 text-faint hover:text-ink"
        >
          <ChevronDown size={13} className={cn('transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {open && <div className="border-t border-line px-3 py-2 text-[11px] leading-snug text-faint">{description}</div>}
    </div>
  );
}

interface BasicsTabProps {
  profile: EngineProfile;
  set: <K extends keyof EngineProfile>(k: K, v: EngineProfile[K]) => void;
  setU: <K extends keyof EngineProfile>(k: K, v: EngineProfile[K] | undefined) => void;
  artifacts: ModelArtifact[];
  artifact: string;
  setArtifact: (v: string) => void;
  modelsDir?: string;
  applyPreset: (id: string) => void;
}

export function BasicsTab({ profile, set, setU, artifacts, artifact, setArtifact, modelsDir, applyPreset }: BasicsTabProps) {
  const grid3 = 'grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-3';
  const selectedArtifact = useMemo(() => artifacts.find((a) => a.path === artifact), [artifacts, artifact]);

  return (
    <div className="space-y-4">
      <SectionCard title="Presets" description="Quickly apply a tested profile baseline, then adjust below." icon={<Sparkles size={15} />}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
          {PRESETS.map((p) => (
            <PresetCard key={p.id} name={p.name} description={p.description} onApply={() => applyPreset(p.id)} />
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Artifact & network" description="One model per engine. Chat requests address it by the public model alias." icon={<Box size={15} />} collapsible>
        <div className={grid3}>
          <Field label="Model artifact" hint="Path to a downloaded .ninfer file. Only explicitly registered artifacts are accepted.">
            <SelectField
              value={artifact}
              onChange={setArtifact}
              options={[
                ...artifacts.map((a) => ({ value: a.path, label: `${a.file}${a.weights ? ` · ${a.weights}` : ''}` })),
              ]}
            />
            {selectedArtifact?.version !== undefined && selectedArtifact.version < 3 && (
              <p className="mt-1 text-[11px] text-danger">⚠️ This artifact is v2. ninfer-serve requires v3. Please upgrade it in the Models tab.</p>
            )}
          </Field>
          <Field label="Public model alias" hint="Override the OpenAI public alias. The loaded artifact is unchanged — this only relabels /v1/models.">
            <TextField value={profile.modelId || ''} onChange={(v) => setU('modelId', v || undefined)} placeholder="artifact identity" />
          </Field>
          <Field label="API key" hint="When set, requests must send it as Bearer token or x-api-key. Studio injects it on proxied requests.">
            <TextField value={profile.apiKey || ''} onChange={(v) => setU('apiKey', v || undefined)} placeholder="unset (open)" />
          </Field>
          <Field label="Chat template" hint="Jinja chat template. Defaults to the artifact's embedded template.">
            <Toggle checked={profile.chatTemplate !== undefined} onChange={(v) => { if (v) setU('chatTemplate', ''); else setU('chatTemplate', undefined); }} label="Custom template" />
            {profile.chatTemplate !== undefined && (
              <div className="mt-2">
                <TextField value={profile.chatTemplate || ''} onChange={(v) => setU('chatTemplate', v || undefined)} placeholder="/path/to/template.jinja" />
              </div>
            )}
          </Field>
          <Field label="Listen host">
            <TextField value={profile.host || ''} onChange={(v) => setU('host', v || undefined)} placeholder="127.0.0.1" />
          </Field>
          <Field label="Port" hint="HTTP port the engine listens on. Studio proxies /v1 to this port.">
            <NumberField value={profile.port} onChange={(v) => set('port', v)} min={1} max={65535} />
          </Field>
          <Field label="CUDA device" hint="CUDA device index. NInfer is a single-GPU engine (RTX 5090 target).">
            <NumberField value={profile.device ?? null} onChange={(v) => set('device', v)} onEmpty={() => setU('device', undefined)} min={0} placeholder="0" />
          </Field>
        </div>
        {artifacts.length === 0 && (
          <p className="mt-3 text-[12px] text-warn">No .ninfer artifacts found in {modelsDir || 'models directory'} — download one from the Models tab first.</p>
        )}
      </SectionCard>
    </div>
  );
}
