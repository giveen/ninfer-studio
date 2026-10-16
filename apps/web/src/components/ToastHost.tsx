import { useToasts, dismissToast } from '../lib/toast';
import { Button } from './ui';
import { cn } from './ui';

const toneClasses: Record<string, string> = {
  error: 'border-danger/40 bg-danger/10 text-danger',
  info: 'border-line bg-panel text-mute',
  success: 'border-ok/40 bg-ok/10 text-ok',
};

export function ToastHost() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] shadow-lg', toneClasses[t.tone])}
        >
          <span className="flex-1 break-words">{t.message}</span>
          {t.retry && (
            <Button size="sm" variant="subtle" onClick={() => { t.retry?.(); dismissToast(t.id); }}>
              {t.retryLabel ?? 'Retry'}
            </Button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismissToast(t.id)}
            className="text-faint hover:text-ink"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}