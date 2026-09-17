import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, RefreshCw, Square, Terminal } from 'lucide-react';
import { engineArgs, getConfig, getProfileState, saveConfig, saveProfileState, startEngine, stopEngine, type EngineArgsResult } from '../lib/api';
import { BLANK_PROFILE, PRESETS, SPEC_BACKEND_OPTIONS } from '../lib/presets';
import type { AppSettings, EngineProfile, SavedProfile, StatusPayload } from '../lib/types';
import { formatBytes, formatMs, formatRate, formatTime, formatUptime } from '../lib/format';
import {
  isLiveMetricsStale,
  useLatestRequestMetrics,
} from '../lib/liveMetrics';
import { Badge, Button, CodeBlock, SectionCard, Stat, cn } from '../components/ui';
import { BasicsTab } from './engine/BasicsTab';
import { PerformanceTab } from './engine/PerformanceTab';
import { AdvancedTab } from './engine/AdvancedTab';
import { ProfilesTab } from './engine/ProfilesTab';
import { UsageTrackerTab } from './engine/UsageTrackerTab';
import { CloudTab } from './engine/CloudTab';

type EngineTab = 'basics' | 'performance' | 'advanced' | 'profiles' | 'usage' | 'cloud';

const TABS: Array<{ id: EngineTab; label: string }> = [
  { id: 'basics', label: 'Basics' },
  { id: 'performance', label: 'Performance' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'usage', label: 'Usage' },
];

// P0-2: the in-UI launch-arg builder (buildArgs) and the restart-dirty logic
// moved to the control plane (POST /api/engine/args) — the same builder that
// spawns the engine computes both, so the displayed command and the dirty
// verdict can no longer drift from what actually runs.


function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10.5px] uppercase tracking-wider text-faint">{label}</span>
      <span className="font-mono text-sm font-medium text-main">{value}</span>
    </div>
  );
}

export function EngineScreen({
  engine,
  settings: _settings,
  onSaveConfig: _onSaveConfig,
}: {
  engine: StatusPayload | null;
  settings: AppSettings;
  onSaveConfig: (c: Partial<AppSettings>) => Promise<void>;
}) {
  const [tab, setTab] = useState<EngineTab>('basics');
  const [profile, setProfile] = useState<EngineProfile>({ ...PRESETS[1].profile });
  const [artifact, setArtifact] = useState<string>('');
  const [saved, setSaved] = useState<SavedProfile[]>([]);
  const [appliedPresetId, setAppliedPresetId] = useState<string | null>(PRESETS[1].id);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getProfileState()
      .then((s) => {
        if (cancelled) return;
        if (s.profile) { setProfile({ ...BLANK_PROFILE, ...s.profile }); setAppliedPresetId(null); }
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
  const liveMetrics = useLatestRequestMetrics();
  const isStale = isLiveMetricsStale(liveMetrics);

  const running = engine?.engine?.state === 'running' || engine?.engine?.state === 'external';
  const starting = engine?.engine?.state === 'starting' || engine?.engine?.state === 'stopping';

  // The restart-dirty verdict is computed by the control plane (single source
  // of truth; debounced + sequenced so a stale response can't answer a newer
  // form edit). Until the first response lands, dirty stays false and only
  // the local port rule is used for the port-mismatch message.
  const [argsInfo, setArgsInfo] = useState<EngineArgsResult | null>(null);
  const argsSeq = useRef(0);
  useEffect(() => {
    const seq = ++argsSeq.current;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const r = await engineArgs(profile, artifact);
          if (seq === argsSeq.current) setArgsInfo(r);
        } catch {
          /* keep the previous verdict; the next profile change re-asks */
        }
      })();
    }, 150);
    return () => clearTimeout(t);
  }, [profile, artifact]);
  const dirty = argsInfo?.dirty ?? false;
  const portMatch = argsInfo?.portMatch ?? (!engine?.port || engine.port === profile.port);
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

  const onUpdateSettings = (patch: Partial<AppSettings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s));
    saveConfig(patch).catch(() => undefined);
  };

  // Persist the engine profile, chosen artifact, and saved named profiles to the
  // user's profile dir on the control plane. Skipped until the initial hydrate
  // completes so we never clobber disk with the first-render defaults.
  useEffect(() => {
    if (!loaded) return;
    const snapshot = { profile, artifact, saved };
    saveProfileState(snapshot).catch(() => undefined);
  }, [profile, artifact, saved, loaded]);

  // Pick the most recently added artifact when none is explicitly chosen. Depends
  // on `artifact` too, so if it ever gets cleared (e.g. via loaded profile state)
  // it is re-selected instead of leaving the Start button disabled.
  useEffect(() => {
    if (!artifact && artifacts.length) setArtifact(artifacts[artifacts.length - 1].path);
  }, [artifact, artifacts.length]);

  const generatedCommand = useMemo(() => {
    // Server-built argv (api key masked server-side); empty until the first
    // response lands (debounced, typically <300ms after the screen opens).
    const args = argsInfo?.args ?? [];
    const command = [
      `ninfer-serve ${artifact ? artifact.split('/').pop() : '<artifact>.ninfer'}`,
      ...(args.length ? ['  ' + args.join(' \\\n  ')] : []),
    ].join('\n');
    return { command, argCount: args.length };
  }, [argsInfo, artifact]);

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
      if (r.profileParseError) setNotice({ tone: 'warn', text: r.profileParseError });
      else if (r.code === 'already_serving') setNotice({ tone: 'warn', text: `Port ${profile.port} already serves an engine — adopted as external (see Engine status).` });
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
    setAppliedPresetId(id);
    setNotice({ tone: 'ok', text: `preset “${p.name}” applied — review the generated command before starting.` });
  };
  /** Preset shown next to the generated command; "(modified)" when the profile
   *  has drifted from the preset's values (port excluded). */
  const appliedPreset = appliedPresetId ? PRESETS.find((p) => p.id === appliedPresetId) : null;
  const presetMatches = appliedPreset
    ? Object.entries(appliedPreset.profile).every(([k, v]) => (profile as unknown as Record<string, unknown>)[k] === v)
    : false;

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

  return (
    <div className="h-full overflow-y-auto">
      <nav className="sticky top-0 z-20 border-b border-line bg-panel/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl gap-1 px-5 py-1.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                'shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                tab === t.id ? 'border-accent/40 bg-accent/12 text-accent' : 'border-line bg-inset text-mute hover:border-line2 hover:text-ink',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>
      <div className="mx-auto max-w-5xl space-y-4 px-5 py-4">
        {status?.vram?.under && (
          <div className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-[13px] text-warn">
            <span className="font-medium">VRAM safety floor breached.</span>{' '}
            The engine reports only <code className="font-mono">{Number(status.vram.freeGib ?? 0).toFixed(2)} GiB</code> free
            after load (floor: {status.vram.floorGib} GiB, runtime{' '}
            <code className="font-mono">{Number(status.vram.runtimeGib ?? 0).toFixed(2)} GiB</code>). Any growth — CUDA graph
            re-capture, media buffers, other GPU apps — can OOM the run. Stop the engine and reduce context/KV capacity, use a denser
            KV dtype (k8v4 or nvfp4), or switch to a smaller artifact.
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
                  : !engine?.argv?.length && engine?.adopted
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
          <div className={cn("rounded-lg border border-line bg-inset px-3.5 py-3 transition-opacity", isStale && "opacity-60")}>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-faint">
                last request metrics {isStale && <span className="normal-case font-normal text-warn/80 ml-1">(stale)</span>}
              </span>
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

        {/* generated command — not relevant to the Usage tab */}
        {tab !== 'usage' && (
          <SectionCard
            title="Generated launch command"
            description="The exact argv Studio sends to ninfer-serve; omitted flags use engine defaults."
            icon={<Terminal size={15} />}
            anchor="command"
            collapsible
            actions={
              <div className="flex items-center gap-2">
                {running && engine?.argv && <Badge tone="ok">running</Badge>}
                {appliedPreset && (
                  <span title={presetMatches ? `Preset "${appliedPreset.name}" is active` : `Profile changed since "${appliedPreset.name}" was applied`}>
                    <Badge tone={presetMatches ? 'info' : 'warn'}>
                      {appliedPreset.name}
                      {!presetMatches && ' (modified)'}
                    </Badge>
                  </span>
                )}
              </div>
            }
          >
            <CodeBlock code={generatedCommand.command} />
          </SectionCard>
        )}

        <div className={cn(tab !== 'basics' && 'hidden')}>
          <BasicsTab
            profile={profile}
            set={set}
            setU={setU}
            artifacts={artifacts}
            artifact={artifact}
            setArtifact={setArtifact}
            modelsDir={status?.config.modelsDir}
            applyPreset={applyPreset}
          />
        </div>
        <div className={cn(tab !== 'performance' && 'hidden')}>
          <PerformanceTab
            profile={profile}
            set={set}
            setU={setU}
            settings={settings}
            onReasoningEffort={onReasoningEffort}
            specOptions={specOptions}
            specSupported={specSupported}
            draftRange={draftRange}
          />
        </div>
        <div className={cn(tab !== 'advanced' && 'hidden')}>
          <AdvancedTab profile={profile} set={set} setU={setU} />
        </div>
        <div className={cn(tab !== 'profiles' && 'hidden')}>
          <ProfilesTab
            profile={profile}
            setProfile={setProfile}
            setAppliedPresetId={setAppliedPresetId}
            setNotice={setNotice}
            saveName={saveName}
            setSaveName={setSaveName}
            saveCurrent={saveCurrent}
            saved={saved}
            setSaved={setSaved}
          />
        </div>
        <div className={cn(tab !== 'cloud' && 'hidden')}>
          <CloudTab settings={settings} onUpdate={onUpdateSettings} />
        </div>
        <div className={cn(tab !== 'usage' && 'hidden')}>
          <UsageTrackerTab />
        </div>
      </div>
    </div>
  );
}
