import { useEffect, useState } from 'react';
import { X, Download, Play, ArrowRight } from 'lucide-react';
import { Button } from './ui';

const DISMISS_KEY = 'ninfer_onboarding_dismissed';

export function OnboardingOverlay({
  open,
  onNavigate,
  onDismiss,
}: {
  open: boolean;
  onNavigate: (screen: any) => void;
  onDismiss: () => void;
}) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  if (!open) return null;

  const dismiss = () => {
    if (dontShowAgain) localStorage.setItem(DISMISS_KEY, '1');
    onDismiss();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div role="dialog" aria-modal="true" aria-label="Getting started" className="relative w-full max-w-lg rounded-xl border border-line bg-panel p-6 shadow-2xl">
        <button
          type="button"
          onClick={dismiss}
          aria-label="Close onboarding"
          className="absolute right-3 top-3 rounded p-1 text-faint hover:bg-panel2 hover:text-ink"
        >
          <X size={16} />
        </button>
        <h2 className="text-[16px] font-semibold text-ink">Welcome to NInfer Studio</h2>
        <p className="mt-1 text-[13px] text-mute">Get a local model running in three steps:</p>
        <ol className="mt-4 space-y-3 text-[13px] text-mute">
          <li className="flex items-start gap-2">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-[11px] font-bold text-accent">1</span>
            <span>Open <strong className="text-ink">Models</strong> and download a <code>.ninfer</code> artifact.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-[11px] font-bold text-accent">2</span>
            <span>Open <strong className="text-ink">Engine</strong>, pick the artifact and profile, then start the engine.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-[11px] font-bold text-accent">3</span>
            <span>Return to <strong className="text-ink">Chat</strong> and send your first prompt.</span>
          </li>
        </ol>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => { onNavigate('models'); dismiss(); }}>
            <Download size={13} /> Download a model <ArrowRight size={12} />
          </Button>
          <Button variant="subtle" onClick={() => { onNavigate('engine'); dismiss(); }}>
            <Play size={13} /> Engine setup
          </Button>
          <label className="ml-auto flex items-center gap-1.5 text-[11.5px] text-faint">
            <input type="checkbox" checked={dontShowAgain} onChange={(e) => setDontShowAgain(e.target.checked)} />
            Don't show again
          </label>
        </div>
      </div>
    </div>
  );
}