import type { ReactNode } from 'react';
import { cn } from '../../components/ui';
import type { PermTier } from '../../lib/coderTools';

export function ToggleRow({
  on,
  onToggle,
  onTitle,
  offTitle,
  onLabel = 'ON',
  offLabel = 'OFF',
}: {
  on: boolean;
  onToggle: (next: boolean) => void;
  onTitle: string;
  offTitle: string;
  onLabel?: string;
  offLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!on)}
      className={cn('shrink-0 rounded px-2.5 py-1 text-[11px] font-medium', on ? 'bg-ok/20 text-ok' : 'bg-danger/20 text-danger')}
      title={on ? onTitle : offTitle}
    >
      {on ? onLabel : offLabel}
    </button>
  );
}

export function TierRow({
  label,
  tier,
  onChange,
  title,
}: {
  label: ReactNode;
  tier: PermTier;
  onChange: (v: PermTier) => void;
  title?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded border border-line px-2 py-1">
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mute" title={title || (typeof label === 'string' ? label : undefined)}>
        {label}
      </span>
      {(['allow', 'ask', 'deny'] as PermTier[]).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          title={`${v} ${typeof label === 'string' ? label : ''}`}
          className={cn(
            'rounded px-2 py-0.5 text-[11px] font-medium',
            tier === v
              ? v === 'allow'
                ? 'bg-ok/20 text-ok'
                : v === 'ask'
                  ? 'bg-warn/20 text-warn'
                  : 'bg-danger/20 text-danger'
              : 'text-faint hover:bg-panel2 hover:text-mute',
          )}
        >
          {v}
        </button>
      ))}
    </div>
  );
}
