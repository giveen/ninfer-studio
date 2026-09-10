import { useEffect, useMemo, useState } from 'react';
import {
  BookmarkPlus,
  Box,
  Cpu,
  Gauge,
  Layers3,
  Play,
  Rocket,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Square,
  Terminal,
  Video,
  Zap,
} from 'lucide-react';
import { getConfig, getLogs, getProfileState, saveConfig, saveProfileState, startEngine, stopEngine } from '../lib/api';
import { BLANK_PROFILE, KV_DTYPE_OPTIONS, LOG_LEVELS, PRESETS, SPEC_BACKEND_OPTIONS } from '../lib/presets';
import type { AppSettings, EngineProfile, SavedProfile, StatusPayload } from '../lib/types';
import { formatBytes, formatMs, formatRate, formatTime, formatUptime } from '../lib/format';
import {
  getLatestRequestMetrics,
  subscribeLatestRequestMetrics,
  type LiveRequestMetrics,
} from '../lib/liveMetrics';
import { Badge, Button, CodeBlock, Field, LogPane, NumberField, SectionCard, Segmented, SelectField, Stat, TextField, Toggle, cn } from '../components/ui';

const NAV_SECTIONS = [
  { id: 'top', label: 'Status' },
  { id: 'command', label: 'Launch command' },
  { id: 'presets', label: 'Presets' },
  { id: 'artifact', label: 'Artifact' },
  { id: 'memory', label: 'Memory' },
  { id: 'scheduling', label: 'Scheduling' },
  { id: 'kv', label: 'KV cache' },
  { id: 'spec', label: 'Speculation' },
  { id: 'vision', label: 'Vision' },
  { id: 'sampling', label: 'Sampling' },
  { id: 'misc', label: 'Misc' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'log', label: 'Log' },
] as const;

function jumpTo(id: string) {
  const target = id === 'top' ? 'engine-top' : id;
  document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Mirror of the control plane's arg builder — used for the generated-command
// display (maskKey=true) and the dirty comparison (maskKey=false).
function buildArgs(p: EngineProfile, maskKey: boolean): string[] {
  const args: string[] = [];
  const kv = (flag: string, v: unknown) => {
    if (v === undefined || v === null || v === '') return;
    args.push(flag, String(v));
  };
  const flag = (f: string, v: unknown) => {
    if (v) args.push(f);
  };
  kv('--host', p.host);
  kv('--port', p.port);
  kv('--api-key', p.apiKey && (maskKey ? '••••••••' : p.apiKey));
  kv('--model-id', p.modelId);
  kv('--max-context', p.maxContext);
  kv('--kv-capacity', p.kvCapacity);
  kv('--max-concurrency', p.maxConcurrency);
  kv('--max-pending-requests', p.maxPendingRequests);
  kv('--pending-timeout-ms', p.pendingTimeoutMs);
  kv('--prefill-chunk', p.prefillChunk);
  kv('--log-stats-interval-ms', p.logStatsIntervalMs);
  kv('--log-level', p.logLevel);
  kv('--device', p.device);
  kv('--context-cost-presets', p.contextCostPresets);
  kv('--max-request-mib', p.maxRequestMib);
  kv('--media-cache-mib', p.mediaCacheMib);
  kv('--media-live-mib', p.mediaLiveMib);
  kv('--media-preprocess-threads', p.mediaPreprocessThreads);
  kv('--request-log-jsonl', p.requestLogJsonl);
  kv('--response-store-max-records', p.responseStoreMaxRecords);
  kv('--response-store-max-mib', p.responseStoreMaxMib);
  kv('--kv-dtype', p.kvDtype);
  if (p.spec) {
    args.push('--spec', String(p.spec));
    kv('--draft-tokens', p.draftTokens);
  }
  flag('--lm-head-draft', p.lmHeadDraft);
  kv('--default-max-tokens', p.defaultMaxTokens);
  kv('--default-thinking-budget', p.defaultThinkingBudget);
  flag('--vision', p.vision);
  flag('--no-cuda-graph', p.noCudaGraph);
  flag('--no-prefix-reuse', p.noPrefixReuse);
  kv('--device-state-slots', p.deviceStateSlots);
  kv('--host-state-slots', p.hostStateSlots);
  kv('--host-kv-mib', p.hostKvMib);
  kv('--max-private-continuations', p.maxPrivateContinuations);
  kv('--max-shared-prefixes', p.maxSharedPrefixes);
  kv('--max-long-anchors-per-continuation', p.maxLongAnchorsPerContinuation);
  flag('--no-thinking', p.noThinking);
  flag('--preserve-thinking', p.preserveThinking);
  kv('--temperature', p.temperature);
  kv('--top-p', p.topP);
  kv('--top-k', p.topK);
  kv('--min-p', p.minP);
  kv('--presence-penalty', p.presencePenalty);
  kv('--frequency-penalty', p.frequencyPenalty);
  kv('--seed', p.seed);
  flag('--greedy', p.greedy);
  flag('--cors', p.cors);
  return args;
}

// Order-insensitive flag/value comparison for two argv lists (positional
// args like the artifact path are ignored — compared separately).
function argsEqual(a: string[], b: string[]): boolean {
  const norm = (xs: string[]) => {
    const m = new Map<string, string>();
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      if (!x.startsWith('-')) continue;
      if (i + 1 < xs.length && !xs[i + 1].startsWith('-')) {
        m.set(x, xs[i + 1]);
        i++;
      } else {
        m.set(x, '');
      }
    }
    return m;
  };
  const ma = norm(a);
  const mb = norm(b);
  if (ma.size !== mb.size) return false;
  for (const [k, v] of ma) if (mb.get(k) !== v) return false;
  return true;
}

const baseName = (p: string | null) => (p ? p.split('/').pop() || p : null);

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10.5px] uppercase tracking-wider text-faint">{label}</span>
      <span className="font-mono text-[14px] leading-none text-ink">{value}</span>
    </div>
  );
}

export function EngineScreen({ status }: { status: StatusPayload | null }) {
  const engine = status?.engine;
  const gpu = status?.gpu;
  const artifacts = status?.artifacts || [];
  const [profile, setProfile] = useState<EngineProfile>(() => ({ ...PRESETS[1].profile }));
  const [artifact, setArtifact] = useState<string>('');
  const [saved, setSaved] = useState<SavedProfile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState<'' | 'start' | 'stop' | 'restart' | 'pull' | 'build'>('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'danger'; text: string } | null>(null);

  // Global request-default settings (reasoning effort). The Engine screen is
  // where the user picks thinking levels, but the value is applied by the proxy
  // to every request as a chat_template_kwargs default.
  const [settings, setSettings] = useState<AppSettings | null>(null);
  useEffect(() => {
    getConfig().then(setSettings).catch(() => undefined);
  }, []);

  // Hydrate the engine profile, chosen artifact, and saved named profiles from
  // the user's profile dir on the control plane (survives app restarts).
  useEffect(() => {
    let cancelled = false;
    getProfileState()
      .then((s) => {
        if (cancelled) return;
        if (s.profile) setProfile({ ...BLANK_PROFILE, ...s.profile });
        else setProfile({ ...PRESETS[1].profile });
        // Only restore a *non-empty* artifact. A persisted "" means "no explicit
        // choice", and restoring it would clobber the auto-selected artifact if
        // this fetch resolves after the status feed has already filled it in.
        if (s.artifact) setArtifact(s.artifact);
        if (s.saved) setSaved(s.saved);
        setLoaded(true);
      })
      .catch(() => cancelled || setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  // Live token metrics from the most recent chat request (lifted from the SSE
  // `timings`/`usage` so they show here, not just in the chat footer).
  const [liveMetrics, setLiveMetrics] = useState<LiveRequestMetrics | null>(getLatestRequestMetrics());
  useEffect(() => subscribeLatestRequestMetrics(setLiveMetrics), []);

  const running = engine?.state === 'running' || engine?.state === 'external';
  const starting = engine?.state === 'starting' || engine?.state === 'stopping';

  // dirty = the engine running on the form's port was started with a different
  // (profile, artifact) than the form holds. The running command is read from
  // the process list, so this works for external engines too.
  const lastStart = status?.lastStart ?? null;
  const portMatch = !engine?.port || engine.port === profile.port;
  // empty/missing argv = command not readable (e.g. adopted engine without a
  // --port flag) — never treat that as "different settings"
  const runningArgs = engine?.argv?.length ? engine.argv : null;
  const formArgs = buildArgs(profile, false);
  const runningArtifact = runningArgs?.find((x) => !x.startsWith('-')) ?? null;
  const dirty =
    !!engine &&
    (engine.state === 'running' || engine.state === 'external') &&
    portMatch &&
    (runningArgs !== null
      ? !argsEqual(formArgs, runningArgs) || baseName(artifact) !== baseName(runningArtifact)
      : !!lastStart &&
        (lastStart.artifact !== (artifact || null) ||
          JSON.stringify(lastStart.profile) !== JSON.stringify(profile)));
  const otherEngines = (status?.engines ?? []).filter((e) => e.port !== engine?.port && e.pid !== engine?.pid);
  const set = <K extends keyof EngineProfile>(k: K, v: EngineProfile[K]) => setProfile((p) => ({ ...p, [k]: v }));
  const setU = <K extends keyof EngineProfile>(k: K, v: EngineProfile[K] | undefined) =>
    setProfile((p) => {
      const n = { ...p, [k]: v };
      if (v === undefined) delete n[k];
      return n;
    });

  // Persist the global reasoning-effort default and reflect it immediately.
  const onReasoningEffort = (v: string) => {
    setSettings((s) => (s ? { ...s, reasoningEffort: v } : s));
    saveConfig({ reasoningEffort: v }).catch(() => undefined);
  };

  // Persist the engine profile, chosen artifact, and saved named profiles to the
  // user's profile dir on the control plane. Skipped until the initial hydrate
  // completes so we never clobber disk with the first-render defaults.
  useEffect(() => {
    if (!loaded) return;
    const snapshot = { profile, artifact, saved };
    saveProfileState(snapshot).catch(() => undefined);
  }, [profile, artifact, saved, loaded]);

  useEffect(() => {
    if (!engine?.logPath && engine?.state !== 'stopped') return;
    const t = setInterval(async () => {
      try {
        const r = await getLogs(300);
        setLogs(r.lines);
      } catch {
        /* sidecar busy */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [engine?.logPath, engine?.state, engine?.startedAt]);

  // Pick the most recently added artifact when none is explicitly chosen. Depends
  // on `artifact` too, so if it ever gets cleared (e.g. via loaded profile state)
  // it is re-selected instead of leaving the Start button disabled.
  useEffect(() => {
    if (!artifact && artifacts.length) setArtifact(artifacts[artifacts.length - 1].path);
  }, [artifact, artifacts.length]);

  const generatedCommand = useMemo(() => {
    const args = buildArgs(profile, true);
    const command = [
      `ninfer-serve ${artifact ? artifact.split('/').pop() : '<artifact>.ninfer'}`,
      ...(args.length ? ['  ' + args.join(' \\\n  ')] : []),
    ].join('\n');
    return { command, argCount: args.length };
  }, [profile, artifact]);

  const doStart = async () => {
    setBusy('start');
    setNotice(null);
    try {
      // Stop any existing engine first so the launched process always reflects
      // the current form. Without this, an adopted/orphaned engine (e.g. one
      // discovered on the default port at boot) keeps serving while a second
      // engine is spawned elsewhere — which looks exactly like "the settings
      // were ignored" because the stale process is the one actually answering.
      await stopEngine(engine?.adopted && engine.pid ? engine.pid : undefined);
      await new Promise((res) => setTimeout(res, 800));
      const r = await startEngine(profile, artifact || null);
      if (r.code === 'already_serving') setNotice({ tone: 'warn', text: `Port ${profile.port} already serves an engine — adopted as external (see Engine status).` });
      else if (!r.ok) setNotice({ tone: 'danger', text: r.message || 'start failed' });
      else setNotice({ tone: 'ok', text: 'engine starting — watch the log below; it takes a while to load weights.' });
    } catch (e) {
      setNotice({ tone: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  };

  const doStop = async () => {
    setBusy('stop');
    setNotice(null);
    try {
      const r = await stopEngine();
      setNotice({ tone: r.ok ? 'ok' : 'danger', text: r.message || 'stop failed' });
    } catch (e) {
      setNotice({ tone: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  };

  // stop a non-primary (discovered) engine by its pid
  const stopOther = async (pid: number | null) => {
    setBusy('stop');
    setNotice(null);
    try {
      const r = await stopEngine(pid ?? undefined);
      setNotice({ tone: r.ok ? 'ok' : 'danger', text: r.message || 'stop failed' });
    } catch (e) {
      setNotice({ tone: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  };

  // stop + start with the current form. The old engine may still be releasing
  // its port when the start lands, so retry `already_serving` a few times.
  const doRestart = async () => {
    setBusy('restart');
    setNotice(null);
    try {
      const s = await stopEngine(engine?.adopted && engine.pid ? engine.pid : undefined);
      if (!s.ok) {
        setNotice({ tone: 'danger', text: s.message || 'stop failed — engine not restarted' });
        return;
      }
      let r = await startEngine(profile, artifact || null);
      let tries = 0;
      while (r.code === 'already_serving' && tries < 4) {
        tries++;
        await new Promise((res) => setTimeout(res, 2500));
        r = await startEngine(profile, artifact || null);
      }
      if (r.code === 'already_serving') setNotice({ tone: 'warn', text: `Port ${profile.port} still held by the old engine after stop — wait a moment and start manually.` });
      else if (!r.ok) setNotice({ tone: 'danger', text: r.message || 'start failed' });
      else setNotice({ tone: 'ok', text: 'engine restarted with the current settings' });
    } catch (e) {
      setNotice({ tone: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  };

  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setProfile({ ...BLANK_PROFILE, ...p.profile, port: profile.port });
    setNotice({ tone: 'ok', text: `preset “${p.name}” applied — review the generated command before starting.` });
  };

  const saveCurrent = () => {
    const name = saveName.trim() || `profile-${saved.length + 1}`;
    setSaved((s) => [...s.filter((x) => x.name !== name), { name, profile: { ...profile } }]);
    setSaveName('');
    setNotice({ tone: 'ok', text: `saved profile “${name}”` });
  };

  const draftRange = profile.spec === 'mtp' ? [1, 5] : [1, 15];
  // Real per-artifact capability comes from the catalog's `spec` string
  // (e.g. "mtp (1..5) or dflash2 (1..15) or off"), not a filename heuristic.
  const specSupported = useMemo(() => {
    const a = artifacts.find((x) => x.path === artifact)?.known;
    if (!a?.spec) return null;
    const s = ` ${a.spec.toLowerCase()} `;
    return {
      mtp: /\bmtp\b/.test(s),
      dflash: /\bdflash\b(?!2)/.test(s),
      dflash2: /\bdflash2\b/.test(s),
    };
  }, [artifacts, artifact]);

  // Disable backends the selected artifact's catalog entry does not support.
  const specOptions = useMemo(
    () =>
      SPEC_BACKEND_OPTIONS.map((o) => ({
        value: o.id,
        label: o.name,
        hint: o.hint,
        disabled: !!specSupported && o.id !== '' && !specSupported[o.id as 'mtp' | 'dflash' | 'dflash2'],
      })),
    [specSupported],
  );

  // KV-cache dtype support, derived from the selected artifact's weight family
  // (the catalog's `weights` field). The accepted KV dtype is the one that does
  // NOT collide with the artifact's own weights: a groupwise-int (bf16-weight)
  // artifact only honors bf16 KV, and an nvfp4-weight artifact silently falls
  // back to bf16 (and drops the KV-capacity override -> 8,192 tokens) when given
  // `--kv-dtype nvfp4`. The portable compressed KV dtype for nvfp4-weight
  // artifacts is fp8. See engine logs: nvfp4 artifact + `--kv-dtype nvfp4`
  // reported `bf16` + `8,192 tokens` despite `--kv-capacity 240000`, while
  // `--kv-dtype fp8` reported `KV 240,000 tokens, fp8`. `null` means "don't
  // restrict" (unknown artifact -> allow every KV dtype).
  const kvDtypeSupport = useMemo(() => {
    const w = artifacts.find((x) => x.path === artifact)?.known?.weights;
    if (!w) return null;
    if (w === 'groupwise-int') return new Set<string>(['bf16']);
    if (w === 'nvfp4') return new Set<string>(['bf16', 'int8', 'fp8', 'k8v4']);
    return null; // unknown weight family: don't second-guess the engine
  }, [artifacts, artifact]);

  // True when the selected artifact silently ignores explicit --max-context /
  // --kv-capacity overrides (observed for groupwise-int weights).
  const contextOverridesIgnored = useMemo(() => {
    const w = artifacts.find((x) => x.path === artifact)?.known?.weights;
    return w === 'groupwise-int';
  }, [artifacts, artifact]);

  // Disable KV dtypes the selected artifact's weight family can't honor.
  const kvDtypeOptions = useMemo(
    () =>
      KV_DTYPE_OPTIONS.map((o) => ({
        value: o.value,
        label: o.label,
        hint: o.hint,
        disabled: !!kvDtypeSupport && !kvDtypeSupport.has(o.value),
      })),
    [kvDtypeSupport],
  );

  const grid2 = 'grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2';
  const grid3 = 'grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-3';

  return (
    <div className="h-full overflow-y-auto">
      <nav className="sticky top-0 z-20 border-b border-line bg-panel/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-5 py-1.5">
          {NAV_SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => jumpTo(s.id)}
              className="shrink-0 rounded-full border border-line bg-inset px-2.5 py-1 text-[11px] text-mute transition-colors hover:border-line2 hover:text-ink"
            >
              {s.label}
            </button>
          ))}
        </div>
      </nav>
      <div className="mx-auto max-w-5xl space-y-4 px-5 py-4" id="engine-top">
        {status?.sidecar?.stale && (
          <div className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-[13px] text-warn">
            <span className="font-medium">Sidecar is running stale code.</span>{' '}
            server.js was edited on disk after this sidecar process started
            {status.sidecar.codeMtime ? ` (${new Date(status.sidecar.codeMtime).toLocaleTimeString()})` : ''}, so
            engine settings from this GUI may be silently dropped at launch — this is exactly how "the GUI ignores my
            parameters" happens. Restart the sidecar (re-run start-stack.sh or quit/relaunch the app), then Start the
            engine again.
          </div>
        )}
        {/* status row */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="engine"
            tone={engine?.state === 'running' ? 'ok' : engine?.state === 'external' ? 'accent' : engine?.state === 'starting' ? 'warn' : engine?.state === 'failed' ? 'danger' : 'neutral' as never}
            value={
              <span className="flex items-center gap-2">
                <span className={cn('h-2 w-2 rounded-full', engine?.state === 'running' ? 'bg-ok' : engine?.state === 'external' ? 'bg-info' : engine?.state === 'starting' || engine?.state === 'stopping' ? 'bg-warn pulse-dot' : engine?.state === 'failed' ? 'bg-danger' : 'bg-faint')} />
                {engine?.state || 'unknown'}
              </span>
            }
            sub={
              engine?.state === 'external'
                ? `external process (pid ${engine.pid || '?'}) — not spawned by Studio`
                : engine?.artifact
                  ? engine.artifact.split('/').pop()
                  : 'no artifact selected'
            }
          />
          <Stat
            label="model"
            value={<span className="break-all text-[15px]">{engine?.modelId || '—'}</span>}
            sub={engine?.startedAt ? `up ${formatUptime(engine.startedAt)} · :${engine.port}` : `port :${engine?.port || status?.config.enginePort || 8080}`}
          />
          <Stat
            label="gpu memory"
            tone={(gpu?.memUsedMiB ?? 0) > (gpu?.memTotalMiB ?? 1) * 0.9 ? 'danger' : 'accent'}
            value={
              gpu?.available ? (
                <span className="flex items-center gap-2">
                  <span>{gpu.memUsedMiB ? formatBytes(gpu.memUsedMiB! * 1024 * 1024) : '—'}</span>
                  <span className="text-[12px] text-faint">/ {gpu.memTotalMiB ? formatBytes(gpu.memTotalMiB! * 1024 * 1024) : ''}</span>
                </span>
              ) : (
                'no gpu'
              )
            }
            sub={gpu?.available ? `${gpu.name} · ${gpu.utilPct ?? 0}% util` : 'nvidia-smi not found'}
          />
          <div className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-line bg-inset px-3.5 py-3">
            <div className="flex items-center gap-2">
              {running ? (
                <>
                  <Button
                    variant={dirty ? 'primary' : 'subtle'}
                    size="md"
                    onClick={doRestart}
                    disabled={busy !== '' || starting || !dirty}
                    title={dirty ? 'Stop + start the engine with the settings in this form' : 'The running engine matches this form'}
                  >
                    <RefreshCw size={14} /> {busy === 'restart' ? 'restarting…' : 'restart'}
                  </Button>
                  <Button variant="danger" size="md" onClick={doStop} disabled={busy !== ''}>
                    <Square size={14} /> stop
                  </Button>
                </>
              ) : (
                <Button variant="primary" size="md" onClick={doStart} disabled={busy !== '' || !artifact || starting}>
                  <Play size={14} /> {starting ? 'working…' : 'start engine'}
                </Button>
              )}
            </div>
            {running && (
              <p className={cn('text-[11px] leading-tight', dirty ? 'text-warn' : 'text-faint')}>
                {!portMatch
                  ? `form targets :${profile.port} — engine serves :${engine?.port}`
                  : runningArgs === null && engine?.adopted
                    ? 'external engine — running command not readable'
                    : dirty
                      ? 'settings changed — restart to apply'
                      : 'running engine matches this form'}
              </p>
            )}
          </div>
        </div>

        {/* live token metrics from the most recent chat request */}
        {liveMetrics?.meta && (
          <div className="rounded-lg border border-line bg-inset px-3.5 py-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-faint">last request metrics</span>
              <span className="font-mono text-[10.5px] text-faint">{liveMetrics.model} · {formatTime(liveMetrics.at)}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MiniStat label="TTFT" value={formatMs(liveMetrics.meta.ttftMs)} />
              <MiniStat label="prompt" value={formatRate(liveMetrics.meta.promptTokPerSec)} />
              <MiniStat label="decode" value={formatRate(liveMetrics.meta.decodeTokPerSec)} />
              <MiniStat
                label="draft"
                value={
                  liveMetrics.meta.draftN
                    ? `${liveMetrics.meta.draftNAccepted}/${liveMetrics.meta.draftN} (${Math.round(((liveMetrics.meta.draftNAccepted ?? 0) / liveMetrics.meta.draftN) * 100)}%)`
                    : '—'
                }
              />
            </div>
          </div>
        )}

        {otherEngines.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-line">
            {otherEngines.map((e) => (
              <div key={`${e.port ?? 0}-${e.pid ?? 0}`} className="flex items-center gap-3 border-b border-line bg-inset px-3 py-2 last:border-b-0">
                <span className="h-2 w-2 shrink-0 rounded-full bg-ok" />
                <span className="min-w-0 truncate text-[12.5px] font-medium">{e.modelId || 'unknown model'}</span>
                <span className="shrink-0 font-mono text-[11px] text-faint">:{e.port}</span>
                {e.artifact && (
                  <span className="hidden shrink-0 font-mono text-[11px] text-faint lg:inline">{e.artifact.split('/').pop()}</span>
                )}
                <span className="shrink-0 text-[10.5px] text-faint">external · pid {e.pid || '?'}</span>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <Button variant="danger" size="sm" onClick={() => stopOther(e.pid)} disabled={busy !== ''}>
                    <Square size={12} /> stop
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {engine?.state === 'failed' && engine?.failReason && (
          <div className="rounded-lg border border-danger/30 bg-danger/8 px-3.5 py-2.5 text-[12.5px] text-danger">
            {engine.failHint ? (
              <>
                <div className="font-medium leading-snug">{engine.failHint}</div>
                <div className="mt-1 text-[11px] text-danger/80">{engine.failReason}</div>
              </>
            ) : (
              <>{engine.failReason} — check the log below, or fix the profile and start again.</>
            )}
          </div>
        )}
        {notice && (
          <div
            className={cn(
              'rounded-lg border px-3.5 py-2.5 text-[12.5px]',
              notice.tone === 'ok' && 'border-ok/30 bg-ok/8 text-ok',
              notice.tone === 'warn' && 'border-warn/30 bg-warn/8 text-warn',
              notice.tone === 'danger' && 'border-danger/30 bg-danger/8 text-danger',
            )}
          >
            {notice.text}
            <button className="ml-3 opacity-60 hover:opacity-100" onClick={() => setNotice(null)}>
              ✕
            </button>
          </div>
        )}

        {/* generated command */}
        <SectionCard
          title="Generated launch command"
          description="The exact argv Studio sends to ninfer-serve; omitted flags use engine defaults."
          icon={<Terminal size={15} />}
          anchor="command"
          collapsible
          actions={
            <div className="flex items-center gap-2">
              {running && engine?.argv && <Badge tone="ok">running</Badge>}
              <Button size="sm" variant="subtle" onClick={() => applyPreset('long-context-mtp3')}>
                long-context preset
              </Button>
            </div>
          }
        >
          <CodeBlock code={generatedCommand.command} />
        </SectionCard>

        {/* presets */}
        <SectionCard title="Presets" description="One-click profiles. Applying one fills every option below — review the command before starting." icon={<Rocket size={15} />} anchor="presets" collapsible>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => applyPreset(p.id)}
                title={p.description}
                className="rounded-lg border border-line bg-inset px-3 py-2 text-left transition-colors hover:border-accent/40 hover:bg-panel2"
              >
                <div className="text-[12.5px] font-semibold text-ink">{p.name}</div>
                <div className="mt-0.5 max-w-[220px] text-[11px] leading-snug text-faint">{p.description}</div>
              </button>
            ))}
          </div>
        </SectionCard>

        {/* artifact + network */}
        <SectionCard title="Artifact & network" description="One model per engine. Chat requests address it by the public model alias." icon={<Box size={15} />} anchor="artifact" collapsible>
          <div className={grid3}>
            <Field label="Model artifact" hint="Path to a downloaded .ninfer file. Only explicitly registered artifacts are accepted.">
              <SelectField
                value={artifact}
                onChange={setArtifact}
                options={[
                  ...artifacts.map((a) => ({ value: a.path, label: `${a.file}${a.weights ? ` · ${a.weights}` : ''}` })),
                ]}
              />
            </Field>
            <Field label="Public model alias" hint="Override the OpenAI public alias. The loaded artifact is unchanged — this only relabels /v1/models.">
              <TextField value={profile.modelId || ''} onChange={(v) => setU('modelId', v || undefined)} placeholder="artifact identity" />
            </Field>
            <Field label="API key" hint="When set, requests must send it as Bearer token or x-api-key. Studio injects it on proxied requests.">
              <TextField value={profile.apiKey || ''} onChange={(v) => setU('apiKey', v || undefined)} placeholder="unset (open)" />
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
            <p className="mt-3 text-[12px] text-warn">No .ninfer artifacts found in {status?.config.modelsDir} — download one from the Models tab first.</p>
          )}
        </SectionCard>

        {/* context & memory */}
        <SectionCard title="Context & memory" description="Per-sequence context ceiling and the shared Main-Text KV pool. 'auto' sizes from free GPU memory (1 GiB headroom)." icon={<Gauge size={15} />} anchor="memory" collapsible>
          <div className={grid3}>
            <Field label="Max context" hint="Per-sequence logical token ceiling. Native model limit is 262,144; practical allocation depends on artifact, media, and KV type.">
              <NumberField value={profile.maxContext ?? null} onChange={(v) => set('maxContext', v)} onEmpty={() => setU('maxContext', undefined)} min={0} placeholder="serve default 8192" />
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
            <Field label="Default reasoning effort" hint="Global default applied to every request via chat_template_kwargs.reasoning_effort. The Studio chat and external clients inherit it unless they set reasoning_effort themselves.">
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
          {contextOverridesIgnored && ((profile.maxContext && profile.maxContext > 0) || (typeof profile.kvCapacity === 'number' && profile.kvCapacity > 0)) && (
            <p className="text-[11.5px] text-warn">
              The selected artifact ignores explicit <code className="font-mono">--max-context</code> / <code className="font-mono">--kv-capacity</code> overrides and uses its compiled context window — your settings won&apos;t take effect. Use the nvfp4 artifact for large contexts.
            </p>
          )}
        </SectionCard>

        {/* scheduling */}
        <SectionCard title="Scheduling" description="Fixed 1–8 request lanes with bounded FIFO ingress. No preemption or QoS." icon={<Zap size={15} />} anchor="scheduling" collapsible>
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

        {/* kv cache */}
        <SectionCard title="KV cache & context cache" description="KV pool storage format, plus device/host checkpoint tiers for long-context reuse." icon={<Layers3 size={15} />} anchor="kv" collapsible>
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
              <Field label="KV dtype" hint="KV-cache storage: bf16, int8, fp8, nvfp4, or k8v4 (INT8 group-64 KV is the published benchmark format).">
                <Segmented value={(profile.kvDtype as string) || 'bf16'} onChange={(v) => set('kvDtype', v as EngineProfile['kvDtype'])} options={kvDtypeOptions} />
              </Field>
              <Toggle checked={!!profile.noPrefixReuse} onChange={(v) => set('noPrefixReuse', v)} label="Disable prefix reuse" hint="Root-only Engine mode. Cannot be combined with explicit context-cache capacity flags." />
              <Toggle checked={!!profile.noCudaGraph} onChange={(v) => set('noCudaGraph', v)} label="Disable CUDA Graph decode" hint="Decode uses eager kernel launches instead of captured graphs." />
            </div>
            {kvDtypeSupport && profile.kvDtype && !kvDtypeSupport.has(profile.kvDtype) && (
              <p className="text-[11.5px] text-warn">
                The selected artifact ({artifacts.find((x) => x.path === artifact)?.known?.weights}) does not support{' '}
                <code className="font-mono">--kv-dtype {profile.kvDtype}</code> — the engine silently falls back to bf16 and ignores your KV capacity.{' '}
                {profile.kvDtype === 'nvfp4'
                  ? 'Use fp8 (or bf16) KV on an nvfp4-weight artifact.'
                  : 'Use bf16 KV on a groupwise-int artifact.'}
              </p>
            )}
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

        {/* speculative decoding */}
        <SectionCard title="Speculative decoding" description="Set at startup: one backend, one draft window. MTP 1–5; DFlash/DFlash2 1–15 (7 recommended)." icon={<Zap size={15} />} anchor="spec" collapsible>
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

        {/* vision & media */}
        <SectionCard title="Vision & media" description="Vision is fixed at startup; without --vision, image/video requests are rejected." icon={<Video size={15} />} anchor="vision" collapsible>
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

        {/* sampling defaults */}
        <SectionCard title="Sampling defaults" description="Process-wide defaults. Order: model/preset → flags → request → --greedy forces temp 0." icon={<SlidersHorizontal size={15} />} anchor="sampling" collapsible>
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
                <NumberField value={profile.presencePenalty ?? null} onChange={(v) => set('presencePenalty', v)} onEmpty={() => setU('presencePenalty', undefined)} step={0.1} placeholder="model preset" />
              </Field>
              <Field label="Frequency penalty">
                <NumberField value={profile.frequencyPenalty ?? null} onChange={(v) => set('frequencyPenalty', v)} onEmpty={() => setU('frequencyPenalty', undefined)} step={0.1} placeholder="0" />
              </Field>
              <Field label="Seed" hint="Fixed seed when a request omits one; unset = fresh random seed per request.">
                <NumberField value={profile.seed ?? null} onChange={(v) => set('seed', v)} onEmpty={() => setU('seed', undefined)} min={0} placeholder="random" />
              </Field>
            </div>
          </div>
        </SectionCard>

        {/* logging & misc */}
        <SectionCard title="Logging, storage & misc" description="Log verbosity, request JSONL, response-store budgets, context-cost presets, CORS." icon={<Terminal size={15} />} anchor="misc" collapsible defaultCollapsed>
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

        <SectionCard title="Profiles" description="Saved profiles map 1:1 to ninfer-serve flags and persist with your Studio profile. 'load' fills the form — then stop + start." icon={<BookmarkPlus size={15} />} anchor="profiles" collapsible defaultCollapsed>
            <div className="flex items-center gap-2">
              <TextField value={saveName} onChange={setSaveName} placeholder="profile name" className="flex-1" />
              <Button size="sm" variant="primary" onClick={saveCurrent}>
                <Save size={13} /> save current
              </Button>
            </div>
            <div className="mt-3 space-y-1.5">
              {saved.length === 0 && <p className="text-[12px] text-faint">Nothing saved yet.</p>}
              {saved.map((s) => {
                const p = s.profile;
                const bits = [
                  p.spec ? `${p.spec} ${p.draftTokens ?? ''}`.trim() : 'no spec',
                  p.maxContext ? `ctx ${p.maxContext}` : 'ctx default',
                  p.kvDtype ? `KV ${p.kvDtype}` : '',
                  p.maxConcurrency ? `C=${p.maxConcurrency}` : '',
                  p.vision ? 'vision' : '',
                ].filter(Boolean);
                return (
                  <div key={s.name} className="flex items-center gap-2 rounded-lg border border-line bg-inset px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[12px] text-ink">{s.name}</p>
                      <p className="truncate text-[11px] text-faint">{bits.join(' · ')}</p>
                    </div>
                    <Button size="sm" variant="primary" onClick={() => { setProfile({ ...BLANK_PROFILE, ...s.profile, port: profile.port }); setNotice({ tone: 'ok', text: `loaded “${s.name}” — review the generated command, then stop + start the engine` }); }}>
                      load
                    </Button>
                    <button className="text-faint hover:text-danger" title="Delete profile" onClick={() => setSaved((x) => x.filter((y) => y.name !== s.name))}>
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          </SectionCard>

        <SectionCard title="Engine log" description={engine?.logPath ? engine.logPath : 'log appears when the engine starts'} icon={<Cpu size={15} />} anchor="log" collapsible>
          <div className="h-64">
            <LogPane lines={logs} />
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
