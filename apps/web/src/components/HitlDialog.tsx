import { ReactNode } from 'react';
import { cn } from './ui';

export type HitlTone = 'accent' | 'warn' | 'danger';

// Visual treatment per tone. `accent` is used for the neutral ask_user prompt,
// `warn` for permission/risky gates, `danger` reserved for hard-blocks.
const TONE: Record<HitlTone, { border: string; title: string; icon: string }> = {
  accent: { border: 'border-accent/40', title: 'text-accent', icon: 'text-accent' },
  warn: { border: 'border-warn/40', title: 'text-warn', icon: 'text-warn' },
  danger: { border: 'border-danger/40', title: 'text-danger', icon: 'text-danger' },
};

export interface HitlDialogProps {
  /** Visible when true (defaults true; consumers usually guard with `{cond && ...}`). */
  open?: boolean;
  /** Accent = neutral prompt, warn = approval gate, danger = hard block. */
  tone?: HitlTone;
  /** Leading icon (e.g. HelpCircle, Shield). */
  icon?: ReactNode;
  title: string;
  /** Short, one-line context under the title. */
  subtitle?: ReactNode;
  /** Body content (the question, command, diff, etc.). */
  children?: ReactNode;
  /** Right-aligned action row. */
  footer?: ReactNode;
  /** Called when the dimmed backdrop is clicked (omit to disable dismissal). */
  onBackdrop?: () => void;
  /** Card width in px. */
  width?: number;
}

/**
 * Shared human-in-the-loop modal shell. Every approval/confirmation popup in the
 * coder screen renders through this so they look and behave identically.
 */
export function HitlDialog({
  open = true,
  tone = 'warn',
  icon,
  title,
  subtitle,
  children,
  footer,
  onBackdrop,
  width = 520,
}: HitlDialogProps) {
  if (!open) return null;
  const t = TONE[tone];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onBackdrop?.();
      }}
    >
      <div
        className={cn('max-w-[92vw] rounded-xl border bg-panel shadow-xl', t.border)}
        style={{ width }}
      >
        <div className="flex items-start gap-2 border-b border-line p-3">
          {icon && <div className={cn('mt-0.5 shrink-0', t.icon)}>{icon}</div>}
          <div className="min-w-0 flex-1">
            <div className={cn('text-sm font-semibold', t.title)}>{title}</div>
            {subtitle && <div className="mt-0.5 text-[11.5px] text-faint">{subtitle}</div>}
          </div>
        </div>
        {children && (
          <div className="max-h-64 overflow-auto p-3 text-[12px] leading-relaxed text-ink">
            {children}
          </div>
        )}
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-line p-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
