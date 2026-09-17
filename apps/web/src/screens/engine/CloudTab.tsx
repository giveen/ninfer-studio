import { useCallback, useEffect, useRef, useState } from 'react';
import { Cloud, RefreshCw, Zap, CheckCircle2, XCircle, Sliders, ShieldAlert, Sparkles } from 'lucide-react';
import { Button, Field, SectionCard, SelectField, TextField, Toggle } from '../../components/ui';
import type { AppSettings } from '../../lib/types';
import { testCloudConnection, type CloudTestResult, type CloudModelInfo } from '../../lib/api';

interface CloudTabProps {
  settings: AppSettings | null;
  onUpdate: (patch: Partial<AppSettings>) => void;
}

interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  defaultPrimary: string;
  defaultSubagent: string;
  hint: string;
  extraHeaders?: string;
}

// Shown when the endpoint hasn't returned a model list yet (fresh setup, or
// Retrieve/Test not run). Kept in sync with the provider presets below so a
// new user always has something sensible to pick.
const COMMON_MODEL_FALLBACK = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo',
];
const PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultPrimary: 'gpt-4o',
    defaultSubagent: 'gpt-4o-mini',
    hint: 'Official OpenAI API endpoint',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultPrimary: 'anthropic/claude-3.5-sonnet',
    defaultSubagent: 'openai/gpt-4o-mini',
    hint: 'Unified access to Claude, GPT-4, DeepSeek & open models',
    extraHeaders: JSON.stringify({ 'HTTP-Referer': 'https://ninfer.studio', 'X-Title': 'NInfer Studio' }, null, 2),
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultPrimary: 'llama-3.3-70b-versatile',
    defaultSubagent: 'llama-3.1-8b-instant',
    hint: 'Ultra-fast LPU inference',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultPrimary: 'deepseek-chat',
    defaultSubagent: 'deepseek-chat',
    hint: 'Official DeepSeek V3/R1 API',
  },
  {
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    defaultPrimary: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    defaultSubagent: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    hint: 'Together AI cloud inference',
  },
];

export function CloudTab({ settings, onUpdate }: CloudTabProps) {
  const [apiDraft, setApiDraft] = useState('');
  const [models, setModels] = useState<string[]>([]);
  /** Context length / $ pricing for whichever models the provider reported
   *  it for (OpenRouter does, most others don't) — keyed by model id. */
  const [modelInfo, setModelInfo] = useState<Record<string, CloudModelInfo>>({});
  const [testing, setTesting] = useState(false);
  const [retrieving, setRetrieving] = useState(false);
  const [retrieveNotice, setRetrieveNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testResult, setTestResult] = useState<CloudTestResult | null>(null);
  const [showHeaders, setShowHeaders] = useState(false);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatchRef = useRef<Partial<AppSettings> | null>(null);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const debouncedOnUpdate = useCallback((patch: Partial<AppSettings>) => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    pendingPatchRef.current = patch;
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      pendingPatchRef.current = null;
      onUpdateRef.current(patch);
    }, 500);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        if (pendingPatchRef.current) onUpdateRef.current(pendingPatchRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (settings?.cloudProviderExtraHeaders) {
      setShowHeaders(true);
    }
  }, [settings?.cloudProviderExtraHeaders]);

  /** Compact "128K ctx · $3.00/$15.00 per M" caption for a model the
   *  provider reported pricing/context for — omitted entirely (not "—")
   *  when nothing is known, matching how the rest of this tab treats
   *  provider-reported optional metadata.
   *
   *  Declared before the `!settings` early return below: every hook in this
   *  component must run on every render regardless of `settings`, or a
   *  render where it's null (skipping this hook) followed by one where it
   *  isn't (calling it) throws "Rendered more hooks than during the
   *  previous render." */
  const modelInfoCaption = useCallback((modelId: string): string | null => {
    const info = modelInfo[modelId];
    if (!info) return null;
    const parts: string[] = [];
    if (info.contextLength) {
      parts.push(`${info.contextLength >= 1000 ? `${Math.round(info.contextLength / 1000)}K` : info.contextLength} ctx`);
    }
    if (info.pricePromptPerM != null || info.priceCompletionPerM != null) {
      const fmt = (n: number | undefined) => (n != null ? `$${n.toFixed(2)}` : '?');
      parts.push(`${fmt(info.pricePromptPerM)}/${fmt(info.priceCompletionPerM)} per M`);
    }
    return parts.length ? parts.join(' · ') : null;
  }, [modelInfo]);

  if (!settings) return null;

  const handleApiKeyChange = (v: string) => {
    setApiDraft(v);
    // Send empty string '' when cleared so it persists unsetting the key, rather than undefined (dropped by JSON.stringify)
    debouncedOnUpdate({ cloudProviderApiKey: v });
  };

  const applyPreset = (preset: ProviderPreset) => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    onUpdate({
      cloudProviderBaseUrl: preset.baseUrl,
      cloudProviderPrimaryModel: preset.defaultPrimary,
      cloudProviderSubagentModel: preset.defaultSubagent,
      cloudProviderDefaultModel: preset.defaultPrimary,
      cloudProviderExtraHeaders: preset.extraHeaders || '',
    });
    if (preset.extraHeaders) setShowHeaders(true);
  };

  const applyModelInfo = (info: CloudModelInfo[] | undefined) => {
    if (!info?.length) return;
    setModelInfo((prev) => {
      const next = { ...prev };
      for (const m of info) next[m.id] = m;
      return next;
    });
  };

  const handleRetrieveModels = async () => {
    setRetrieving(true);
    setRetrieveNotice(null);
    try {
      const baseUrl = settings.cloudProviderBaseUrl || 'https://api.openai.com/v1';
      // Empty string = "use the saved key": the backend substitutes the
      // stored secret (the UI only ever holds the redaction mask).
      const key = apiDraft.trim();
      const headers = settings.cloudProviderExtraHeaders;
      const res = await testCloudConnection(baseUrl, key, headers);
      if (!res.ok) throw new Error(res.error || 'Failed to retrieve models');
      setModels(res.models);
      applyModelInfo(res.modelInfo);
      setRetrieveNotice({ ok: true, msg: `Retrieved ${res.models.length} model${res.models.length === 1 ? '' : 's'} from endpoint` });
    } catch (e) {
      setRetrieveNotice({ ok: false, msg: e instanceof Error ? e.message : 'Failed to retrieve models' });
    } finally {
      setRetrieving(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const baseUrl = settings.cloudProviderBaseUrl || 'https://api.openai.com/v1';
      const key = apiDraft.trim();
      const headers = settings.cloudProviderExtraHeaders;
      const res = await testCloudConnection(baseUrl, key, headers);
      setTestResult(res);
      if (res.ok && res.models.length > 0) {
        setModels(res.models);
        applyModelInfo(res.modelInfo);
      }
    } catch (e) {
      setTestResult({
        ok: false,
        error: e instanceof Error ? e.message : 'Connection test failed',
        latencyMs: 0,
        models: [],
      });
    } finally {
      setTesting(false);
    }
  };

  const primaryModel = settings.cloudProviderPrimaryModel || settings.cloudProviderDefaultModel || 'gpt-4o';
  const subagentModel = settings.cloudProviderSubagentModel || settings.cloudProviderDefaultModel || 'gpt-4o-mini';

  const combinedList = Array.from(new Set([...models, primaryModel, subagentModel, ...COMMON_MODEL_FALLBACK].filter(Boolean)));
  const modelOptions = combinedList.map((m) => ({ value: m, label: m }));

  return (
    <div className="space-y-4">
      <SectionCard
        title="Cloud AI Providers"
        description="Connect external OpenAI-compatible APIs (OpenAI, OpenRouter, Groq, DeepSeek, Together AI) to use cloud models in Chat and Coder."
        icon={<Cloud size={15} />}
      >
        <div className="space-y-5">
          <Toggle
            checked={!!settings.cloudProviderEnabled}
            onChange={(v) => onUpdate({ cloudProviderEnabled: v })}
            label="Enable custom cloud provider"
            hint="When enabled, you can switch between ninfer and cloud providers or set global cloud routing."
          />

          {settings.cloudProviderEnabled && (
            <div className="space-y-5 pt-1 border-t border-line/50">
              {/* Presets Quick-Select */}
              <div className="space-y-2">
                <label className="text-[12px] font-semibold text-ink flex items-center gap-1.5">
                  <Sparkles size={13} className="text-accent" />
                  Provider Presets
                </label>
                <div className="flex flex-wrap gap-2">
                  {PRESETS.map((p) => {
                    const isActive = settings.cloudProviderBaseUrl === p.baseUrl;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => applyPreset(p)}
                        className={`rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-all ${
                          isActive
                            ? 'border-accent bg-accent/10 text-accent shadow-sm'
                            : 'border-line bg-panel hover:bg-panel2 text-mute hover:text-ink'
                        }`}
                        title={p.hint}
                      >
                        {p.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Endpoint & Key */}
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
                <Field label="Base URL" hint="The API endpoint URL for the cloud provider (e.g., https://api.openai.com/v1).">
                  <TextField
                    value={settings.cloudProviderBaseUrl || ''}
                    onChange={(v) => debouncedOnUpdate({ cloudProviderBaseUrl: v })}
                    placeholder="https://api.openai.com/v1"
                  />
                </Field>
                <Field label="API Key" hint="Your API key for the cloud provider.">
                  <div className="flex items-center gap-2">
                    <TextField
                      value={apiDraft}
                      onChange={handleApiKeyChange}
                      placeholder={settings.cloudProviderApiKey ? '******** (saved)' : 'sk-...'}
                      type="password"
                      spellCheck={false}
                    />
                    {settings.cloudProviderApiKey && !apiDraft && (
                      <Button size="sm" variant="ghost" onClick={() => onUpdate({ cloudProviderApiKey: '' })}>
                        clear
                      </Button>
                    )}
                  </div>
                </Field>
              </div>

              {/* Extra Headers Toggle / Drawer */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setShowHeaders(!showHeaders)}
                  className="text-[11.5px] font-medium text-accent hover:underline flex items-center gap-1"
                >
                  <Sliders size={12} />
                  {showHeaders ? 'Hide Custom Headers' : '+ Add Custom HTTP Headers (JSON)'}
                </button>
                {showHeaders && (
                  <Field label="Custom HTTP Headers (JSON)" hint='JSON key-value object appended to cloud requests (e.g. {"HTTP-Referer": "https://ninfer.studio"}).'>
                    <textarea
                      value={settings.cloudProviderExtraHeaders || ''}
                      onChange={(e) => debouncedOnUpdate({ cloudProviderExtraHeaders: e.target.value })}
                      placeholder='{\n  "HTTP-Referer": "https://ninfer.studio",\n  "X-Title": "NInfer Studio"\n}'
                      rows={3}
                      className="w-full rounded-lg border border-line bg-inset px-3 py-2 font-mono text-[11.5px] text-ink placeholder:text-faint focus:border-accent/50 focus:outline-none"
                    />
                  </Field>
                )}
              </div>

              {/* Global Agent Routing Toggles */}
              <div className="rounded-xl border border-line bg-panel p-4 space-y-3">
                <h4 className="text-[13px] font-semibold text-ink">Global Execution Routing</h4>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Toggle
                    checked={!!settings.cloudUseForPrimary}
                    onChange={(v) => onUpdate({ cloudUseForPrimary: v })}
                    label="Cloud as Main Agent"
                    hint="Automatically use cloud provider for primary chat and code agents."
                  />
                  <Toggle
                    checked={!!settings.cloudUseForSubagent}
                    onChange={(v) => onUpdate({ cloudUseForSubagent: v })}
                    label="Cloud as Subagent"
                    hint="Automatically use cloud provider for background subagent workers."
                  />
                </div>
              </div>

              {/* Role-Specific Default Models */}
              <div className="rounded-xl border border-line bg-panel p-4 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h4 className="text-[13px] font-semibold text-ink flex items-center gap-1.5">
                      Default Models per Role
                    </h4>
                    <p className="text-[11.5px] text-faint">
                      Assign distinct models for your Main Agent (reasoning/coding) vs. Subagent Workers (speed/cost).
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleRetrieveModels}
                    disabled={retrieving}
                    className="border border-line/60 self-start sm:self-auto shrink-0"
                  >
                    <RefreshCw size={13} className={retrieving ? 'animate-spin' : ''} />
                    {retrieving ? 'Retrieving…' : 'Retrieve Models'}
                  </Button>
                </div>

                {retrieveNotice && (
                  <div
                    className={`rounded-lg border px-3 py-2 text-[11.5px] ${
                      retrieveNotice.ok ? 'border-ok/30 bg-ok/5 text-ok' : 'border-danger/30 bg-danger/5 text-danger'
                    }`}
                  >
                    {retrieveNotice.msg}
                  </div>
                )}

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field label="Main Agent Cloud Model" hint="Used for primary agent turns when cloud is active.">
                    <div className="space-y-1.5">
                      <SelectField
                        value={primaryModel}
                        onChange={(v) => onUpdate({ cloudProviderPrimaryModel: v, cloudProviderDefaultModel: v })}
                        options={modelOptions}
                      />
                      <TextField
                        value={settings.cloudProviderPrimaryModel || ''}
                        onChange={(v) => debouncedOnUpdate({ cloudProviderPrimaryModel: v })}
                        placeholder="Custom model name..."
                        className="text-[12px]"
                      />
                      {modelInfoCaption(primaryModel) && (
                        <p className="text-[11px] text-faint">{modelInfoCaption(primaryModel)}</p>
                      )}
                    </div>
                  </Field>

                  <Field label="Subagent Cloud Model" hint="Used for Scout probes, background workers, and Critic passes.">
                    <div className="space-y-1.5">
                      <SelectField
                        value={subagentModel}
                        onChange={(v) => onUpdate({ cloudProviderSubagentModel: v })}
                        options={modelOptions}
                      />
                      <TextField
                        value={settings.cloudProviderSubagentModel || ''}
                        onChange={(v) => debouncedOnUpdate({ cloudProviderSubagentModel: v })}
                        placeholder="Custom model name..."
                        className="text-[12px]"
                      />

                      {modelInfoCaption(subagentModel) && (
                        <p className="text-[11px] text-faint">{modelInfoCaption(subagentModel)}</p>
                      )}
                    </div>
                  </Field>
                </div>
              </div>

              {/* Test Connection & Latency Benchmark */}
              <div className="rounded-xl border border-line bg-panel p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h4 className="text-[13px] font-semibold text-ink flex items-center gap-1.5">
                      <Zap size={14} className="text-accent" />
                      Test Connection & Latency Benchmark
                    </h4>
                    <p className="text-[11.5px] text-faint">
                      Probe the endpoint, verify your API key, measure round-trip ping, and auto-detect models.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleTestConnection}
                    disabled={testing}
                    className="border border-line/60"
                  >
                    <RefreshCw size={13} className={testing ? 'animate-spin' : ''} />
                    {testing ? 'Benchmarking…' : 'Run Benchmark'}
                  </Button>
                </div>

                {testResult && (
                  <div
                    className={`rounded-lg border p-3 text-[12px] ${
                      testResult.ok ? 'border-ok/30 bg-ok/5 text-ok' : 'border-danger/30 bg-danger/5 text-danger'
                    }`}
                  >
                    <div className="flex items-center gap-2 font-medium">
                      {testResult.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                      <span>{testResult.ok ? 'Connection Successful' : 'Connection Failed'}</span>
                      <span className="ml-auto text-[11px] opacity-80">{testResult.latencyMs}ms latency</span>
                    </div>
                    {testResult.ok ? (
                      <p className="mt-1 text-[11px] opacity-90">
                        Detected {testResult.models.length} model{testResult.models.length === 1 ? '' : 's'} on provider endpoint.
                      </p>
                    ) : (
                      <p className="mt-1 text-[11px] font-mono opacity-90">{testResult.error}</p>
                    )}
                  </div>
                )}
              </div>

              {/* Smart Context Compression & Tiering Options */}
              <div className="rounded-xl border border-line bg-panel p-4 space-y-4">
                <h4 className="text-[13px] font-semibold text-ink flex items-center gap-1.5">
                  <Sparkles size={14} className="text-accent" />
                  Hybrid Intelligence & Cost Optimization
                </h4>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Toggle
                    checked={settings.cloudPruneContext !== false}
                    onChange={(v) => onUpdate({ cloudPruneContext: v })}
                    label="Smart Context Compression"
                    hint="Prune bloated historical tool outputs (>1500 chars) in older turns before shipping prompts to paid Cloud APIs, saving up to 70% in input tokens."
                  />
                  <Toggle
                    checked={settings.cloudUseLocalCompactor !== false}
                    onChange={(v) => onUpdate({ cloudUseLocalCompactor: v })}
                    label="Local Engine Context Compaction"
                    hint="Use your zero-cost local NInfer model to summarize long history into a checkpoint before clearing & feeding the compressed context to cloud models."
                  />
                  <Toggle
                    checked={!!settings.cloudSmartTiering}
                    onChange={(v) => onUpdate({ cloudSmartTiering: v })}
                    label="Task-Based Model Tiering"
                    hint="Automatically route lightweight read/search/summary sub-passes to local NInfer or fast subagent models to conserve primary cloud tokens."
                  />
                </div>
              </div>

              {/* Local Fallback Toggle */}
              <div className="rounded-xl border border-line bg-panel p-4">
                <Toggle
                  checked={!!settings.cloudFallbackToLocal}
                  onChange={(v) => onUpdate({ cloudFallbackToLocal: v })}
                  label={
                    <span className="flex items-center gap-1.5">
                      <ShieldAlert size={14} className="text-warn" />
                      Fallback to Local Engine on Rate Limits / Outage
                    </span>
                  }
                  hint="If the cloud API returns 429 Rate Limit or 5xx server errors, automatically fallback to the local ninfer engine to prevent interrupting agent loops."
                />
              </div>
            </div>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
