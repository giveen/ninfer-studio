import { SectionCard } from '../../components/ui';

export function AboutTab() {
  return (
    <div className="mx-auto max-w-5xl px-5 py-4">
      <SectionCard title="About">
        <div className="space-y-2 text-[12.5px] leading-relaxed text-mute">
          <p>
            <span className="font-semibold text-ink">NInfer Studio</span>{' '}
            <span className="font-mono text-[11.5px] text-faint">v{__APP_VERSION__}</span> is a from-scratch desktop control surface for
            the NInfer engine: full configuration for every <span className="font-mono text-[12px]">ninfer-serve</span> option with
            per-GPU presets, the artifact catalog with one-click Hugging Face downloads, a streaming chat window with vision and
            thinking controls, and an agentic Coder mode backed by the same engine.
          </p>
          <p>
            Architecture: a React 19 + Vite + Tailwind UI backed by a Rust (axum) control plane that
            supervises the engine, scans models, reports GPU + VRAM state, and proxies the OpenAI/Anthropic HTTP API —
            the same binary in development and in packaged releases.
          </p>
          <p className="font-mono text-[11.5px] text-faint">
            engine: C++/CUDA, sm_120a · ui: React 19 + Vite 7 + Tailwind 4 · control plane: Rust axum
          </p>
        </div>
      </SectionCard>
    </div>
  );
}
