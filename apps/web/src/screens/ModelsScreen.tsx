import { useMemo, useState } from 'react';
import { Download, ExternalLink, Layers, Play, Trash2 } from 'lucide-react';
import { downloadModel, saveConfig } from '../lib/api';
import { formatBytes, formatTime } from '../lib/format';
import type { DownloadRec, StatusPayload } from '../lib/types';
import { Badge, Button, Field, SectionCard, TextField, cn } from '../components/ui';

function DlProgress({ dl }: { dl: DownloadRec }) {
  const pct = dl.totalBytes ? Math.min(100, (dl.downloadedBytes / dl.totalBytes) * 100) : null;
  const indeterminate = pct === null;
  return (
    <div className="flex w-full max-w-[240px] flex-col gap-1">
      <div className="flex items-center gap-2">
        <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-line">
          <div
            className={cn('h-full rounded-full bg-accent transition-[width] duration-300', indeterminate && 'w-1/3 animate-pulse')}
            style={pct !== null ? { width: `${pct}%` } : undefined}
          />
        </div>
        <span className="font-mono text-[10.5px] text-warn">{indeterminate ? '↓ …' : `${pct!.toFixed(0)}%`}</span>
      </div>
      <div className="font-mono text-[10px] text-faint">
        {formatBytes(dl.downloadedBytes)}
        {dl.totalBytes ? ` / ${formatBytes(dl.totalBytes)}` : ''}
        {dl.speedBps > 0 ? ` · ${formatBytes(dl.speedBps)}/s` : ''}
      </div>
    </div>
  );
}

// Normalize a catalog `spec` string (e.g. "mtp (1..5) or off" / "mtp (1..5) or
// dflash2 (1..15) or off") into a short label: "MTP" / "MTP or DFLASH2".
function formatSpec(spec: string | undefined): string {
  if (!spec) return '—';
  return spec
    .split(' or ')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'off')
    .map((s) => s.replace(/\s*\(.*\)\s*$/, '').toUpperCase())
    .join(' or ');
}

export function ModelsScreen({ status }: { status: StatusPayload | null }) {
  const artifacts = status?.artifacts || [];
  const downloads = status?.downloads || [];
  const modelsDir = status?.config.modelsDir || '';
  const runningArtifact = status?.engine?.artifact;

  const local = useMemo(() => {
    const localNames = new Set(artifacts.map((a) => a.file));
    return { localNames };
  }, [artifacts]);

  const startDownload = async (repo: string, file: string) => {
    await downloadModel(repo, file);
  };

  const [dlRepo, setDlRepo] = useState('');
  const [dlFile, setDlFile] = useState('');
  const [dlError, setDlError] = useState<string | null>(null);
  const [hfTokenDraft, setHfTokenDraft] = useState('');
  const hfTokenStored = !!status?.config.hfToken;

  const startCustom = async () => {
    if (!dlRepo || !dlFile) return;
    setDlError(null);
    try {
      const r = await downloadModel(dlRepo, dlFile);
      if (!r.ok) setDlError(r.message || 'download failed to start');
    } catch (e) {
      setDlError(e instanceof Error ? e.message : String(e));
    }
  };

  const saveHfToken = async () => {
    await saveConfig({ hfToken: hfTokenDraft.trim() });
    setHfTokenDraft('');
  };

  const catalog = status?.artifacts ? status.artifacts : [];
  const catalogEntries = (status && (status as any).catalog) || [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 px-5 py-4">
        <SectionCard
          title="Downloaded artifacts"
          description="Only explicitly registered .ninfer artifacts are loadable by the engine."
          icon={<Layers size={15} />}
          actions={<Badge tone="accent">{artifacts.length} local</Badge>}
        >
          {artifacts.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-[13px] text-mute">No .ninfer artifacts in the models directory yet.</p>
              <p className="mt-1 text-[12px] text-faint">Download one from the catalog below — files land in your configured models directory.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {artifacts.map((a) => (
                <div
                  key={a.file}
                  className={cn(
                    'rounded-xl border p-4 transition-colors',
                    runningArtifact === a.path ? 'border-accent/50 bg-accent/6' : 'border-line bg-inset hover:border-line2',
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border font-mono text-[15px] font-bold', runningArtifact === a.path ? 'border-accent/40 bg-accent/12 text-accent' : 'border-line bg-panel2 text-mute')}>
                      {(a.model || 'N').slice(0, 1)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-mono text-[13px] font-semibold text-ink">{a.file}</span>
                        {runningArtifact === a.path && <Badge tone="ok">loaded</Badge>}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {a.model && <Badge tone="neutral">{a.model}</Badge>}
                        {a.weights && <Badge tone="info">{a.weights}</Badge>}
                        {a.modelId && <Badge tone="neutral">id {a.modelId}</Badge>}
                        {!a.known && <Badge tone="warn">unregistered</Badge>}
                      </div>
                      <div className="mt-2 flex items-center gap-3 font-mono text-[11px] text-faint">
                        <span>{formatBytes(a.size)}</span>
                        <span>{formatTime(a.mtime)}</span>
                        {a.repo && (
                          <a className="inline-flex items-center gap-1 text-mute hover:text-accent" href={`https://huggingface.co/${a.repo}`} target="_blank" rel="noreferrer">
                            source <ExternalLink size={10} />
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                  {a.known && (
                    <p className="mt-2.5 border-t border-line pt-2 text-[11.5px] leading-snug text-faint">
                      spec: {a.known.spec} · vision {a.known.vision ? 'supported' : 'n/a'}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Registered catalog"
          description="The five artifact identities NInfer explicitly supports. Weights and the embedded tokenizer, chat template, and media frontends are fixed per artifact."
          icon={<Download size={15} />}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wider text-faint">
                  <th className="py-2 pr-4">artifact</th>
                  <th className="py-2 pr-4">model</th>
                  <th className="py-2 pr-4">weights</th>
                  <th className="py-2 pr-4">speculation</th>
                  <th className="py-2 pr-4">status</th>
                  <th className="py-2">actions</th>
                </tr>
              </thead>
              <tbody>
                {catalogEntries.length === 0 && artifacts.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-4 text-faint">waiting for sidecar status…</td>
                  </tr>
                )}
                {(catalogEntries.length ? catalogEntries : []).map((c: any) => {
                  const local = artifacts.find((a) => a.file === c.file);
                  const dl = downloads.find((d) => d.file === c.file && !d.done);
                  return (
                    <tr key={c.file} className="border-b border-line/60 last:border-0">
                      <td className="py-2.5 pr-4 font-mono text-[12px] text-ink">{c.file}</td>
                      <td className="py-2.5 pr-4">{c.model}</td>
                      <td className="py-2.5 pr-4"><Badge tone="info">{c.weights}</Badge></td>
                      <td className="py-2.5 pr-4 font-mono text-[11.5px] text-mute">{formatSpec(c.spec)}</td>
                      <td className="py-2.5 pr-4">
                        {local ? (
                          <span className="inline-flex items-center gap-1.5 font-mono text-[11.5px] text-ok">
                            ✓ {formatBytes(local.size)}
                          </span>
                        ) : dl ? (
                          <DlProgress dl={dl} />
                        ) : (
                          <span className="font-mono text-[11.5px] text-faint">not downloaded</span>
                        )}
                      </td>
                      <td className="py-2.5">
                        <div className="flex items-center gap-1.5">
                          {local ? (
                            <Button size="sm" variant="subtle" title="Start the engine with this artifact (Engine tab holds the launch profile)" disabled={!!dl}>
                              <Play size={12} /> launch
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => startDownload(c.repo, c.file)} disabled={!!dl}>
                              <Download size={12} /> download
                            </Button>
                          )}
                          <a className="rounded-md p-1.5 text-faint hover:text-ink" title={`open ${c.repo} on Hugging Face`} href={`https://huggingface.co/${c.repo}`} target="_blank" rel="noreferrer">
                            <ExternalLink size={13} />
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>

        <SectionCard
          title="Download from Hugging Face"
          description="Fetch a .ninfer artifact from any HF repo via the hf CLI into the models directory."
          icon={<Download size={15} />}
        >
          <div className="space-y-2.5">
            <Field
              label="HuggingFace token (optional)"
              hint={
                hfTokenStored
                  ? 'A token is saved — downloads use it for faster, non-rate-limited transfers. Type a new one to replace it.'
                  : 'Set one for faster, non-rate-limited downloads from gated or busy repos. Stored locally, sent only to hf as HF_TOKEN.'
              }
            >
              <div className="flex items-center gap-2">
                <TextField
                  type="password"
                  value={hfTokenDraft}
                  onChange={(v) => setHfTokenDraft(v)}
                  placeholder={hfTokenStored ? '******** (saved)' : 'hf_…'}
                  className="font-mono text-[12px]"
                  spellCheck={false}
                />
                <Button size="sm" variant="ghost" onClick={saveHfToken} disabled={!hfTokenDraft.trim()}>
                  save
                </Button>
              </div>
            </Field>
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
              <Field label="HF repository" hint="e.g. neroued/Qwen3.8-27B-nvfp4-NInfer">
                <TextField value={dlRepo} onChange={(v) => setDlRepo(v)} placeholder="neroued/Qwen3.8-27B-NInfer" className="font-mono text-[12px]" />
              </Field>
              <Field label="File" hint="Artifact filename inside the repo, e.g. qwen3_8_27b_nvfp4.ninfer">
                <TextField value={dlFile} onChange={(v) => setDlFile(v)} placeholder="qwen3_8_27b_nvfp4.ninfer" className="font-mono text-[12px]" />
              </Field>
            </div>
            <div className="flex items-center justify-end gap-3">
              {dlError && <span className="text-[12px] text-danger">{dlError}</span>}
              <Button size="sm" variant="primary" onClick={startCustom} disabled={!dlRepo || !dlFile}>
                <Download size={13} /> download to {modelsDir?.split('/').pop() || 'models/'}
              </Button>
            </div>
            {downloads.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-lg border border-line bg-inset p-2.5 font-mono text-[11px] leading-relaxed text-mute">
                {downloads.slice(-5).map((d) => (
                  <div key={d.id} className={cn('mb-1', d.failed && 'text-danger')}>
                    {d.failed ? '✗' : d.done ? '✓' : '↓'} {d.file} — {d.done ? `exit ${d.exitCode}` : `pid ${d.pid}`}
                    {d.out && <div className="whitespace-pre-wrap text-[10.5px] opacity-70">{d.out.split('\n').slice(-3).join('\n')}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </SectionCard>

      </div>
    </div>
  );
}
