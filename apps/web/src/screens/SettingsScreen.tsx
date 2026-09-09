import { useEffect, useState } from 'react';
import { FolderCog, Save } from 'lucide-react';
import { getConfig, saveConfig } from '../lib/api';
import type { AppSettings, StatusPayload } from '../lib/types';
import { Button, Field, SectionCard, TextField } from '../components/ui';

export function SettingsScreen({ status }: { status: StatusPayload | null }) {
  const [form, setForm] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!form && status?.config) setForm(status.config);
  }, [status, form]);
  useEffect(() => {
    getConfig().then(setForm).catch(() => undefined);
  }, []);

  if (!form) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-faint">loading settings…</div>
    );
  }

  const set = (k: keyof AppSettings, v: string | number) => setForm({ ...form, [k]: v });

  const save = async () => {
    setError(null);
    try {
      const c = await saveConfig({
        engineBinary: form.engineBinary,
        engineCli: form.engineCli,
        modelsDir: form.modelsDir,
        enginePort: Number(form.enginePort),
        apiKey: form.apiKey,
        hfCli: form.hfCli,
        repoDir: form.repoDir ?? '',
        buildCommand: form.buildCommand ?? '',
      });
      setForm(c);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 px-5 py-4">
        <SectionCard title="Engine paths" description="Studio spawns the compiled engine binary and scans the models directory. Both must exist on this machine." icon={<FolderCog size={15} />}>
          <div className="space-y-4">
            <Field label="ninfer-serve binary" hint="Absolute path to build/apps/ninfer-serve. Requires a CMake Release build of the engine (RTX 5090 / sm_120a target).">
              <TextField value={form.engineBinary} onChange={(v) => set('engineBinary', v)} className="font-mono text-[12px]" />
            </Field>
            <Field label="ninfer CLI (one-shot)" hint="Reserved for future one-shot prompt tooling.">
              <TextField value={form.engineCli} onChange={(v) => set('engineCli', v)} className="font-mono text-[12px]" />
            </Field>
            <Field label="Models directory" hint="Scanned for .ninfer artifacts; downloads land here.">
              <TextField value={form.modelsDir} onChange={(v) => set('modelsDir', v)} className="font-mono text-[12px]" />
            </Field>
            <Field label="hf CLI" hint="Hugging Face CLI binary used for downloads.">
              <TextField value={form.hfCli} onChange={(v) => set('hfCli', v)} className="font-mono text-[12px]" />
            </Field>
            <Field label="Engine source repo" hint="Git work tree of the NInfer source. The Engine tab's git pull / rebuild run here.">
              <TextField value={form.repoDir ?? ''} onChange={(v) => set('repoDir', v)} placeholder="/path/to/ninfer" className="font-mono text-[12px]" />
            </Field>
            <Field label="Build command" hint="Run inside the repo dir. NInfer default: Ninja configure + Release build, parallelized over all cores (-j$(nproc)).">
              <TextField value={form.buildCommand ?? ''} onChange={(v) => set('buildCommand', v)} placeholder="cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build -j$(nproc)" className="font-mono text-[12px]" />
            </Field>
          </div>
        </SectionCard>

        <SectionCard title="Engine defaults" description="Used when a profile omits a value, and for the port Studio probes for an already-running engine.">
          <div className="space-y-4">
            <Field label="Default engine port" hint="ninfer-serve's default listen port when the profile doesn't set one.">
              <div className="w-32">
                <TextField value={String(form.enginePort)} onChange={(v) => set('enginePort', Number(v) || 0)} className="font-mono" />
              </div>
            </Field>
            <Field label="API key" hint="When set, Studio adds it as Authorization: Bearer on all proxied engine requests. Leave empty for an open local server.">
              <TextField value={form.apiKey} onChange={(v) => set('apiKey', v)} placeholder="unset" className="font-mono" />
            </Field>
          </div>
        </SectionCard>

        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={save}>
            <Save size={14} /> save settings
          </Button>
          {saved && <span className="text-[12.5px] text-ok">saved ✓</span>}
          {error && <span className="text-[12.5px] text-danger">{error}</span>}
        </div>

        <SectionCard title="About">
          <div className="space-y-2 text-[12.5px] leading-relaxed text-mute">
            <p>
              <span className="font-semibold text-ink">NInfer Studio</span> is a from-scratch desktop UI for the{' '}
              NInfer engine: a full configuration surface for every{' '}
              <span className="font-mono text-[12px]">ninfer-serve</span> option, artifact management, and a streaming chat window.
            </p>
            <p>
              Architecture: a zero-dependency Node 22 control plane (the sidecar) supervises the engine process, scans models, reports GPU state, and proxies the
              OpenAI/Anthropic HTTP API. The web app is the UI; in a packaged release the same control plane ships as the Tauri Rust core.
            </p>
            <p className="font-mono text-[11.5px] text-faint">engine: C++/CUDA, sm_120a · ui: React 19 + Vite 7 + Tailwind 4 · control plane: Node 22</p>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
