import { forwardRef, type ReactNode, useEffect, useRef, useState } from 'react';
import * as Switch from '@radix-ui/react-switch';
import * as Popover from '@radix-ui/react-popover';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, ChevronDown, ChevronRight, Copy, Info } from 'lucide-react';

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- Buttons
export function Button({
  children,
  onClick,
  variant = 'ghost',
  size = 'md',
  disabled,
  title,
  className,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  title?: string;
  className?: string;
  type?: 'button' | 'submit';
}) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors select-none focus-visible:outline-2 focus-visible:outline-accent/60 disabled:opacity-40 disabled:pointer-events-none';
  const sizes = {
    sm: 'h-7 px-2.5 text-[12.5px]',
    md: 'h-8.5 px-3.5 text-[13px]',
    lg: 'h-10 px-5 text-sm',
  };
  const variants = {
    primary: 'bg-accent text-[#101408] hover:bg-[#c8f75e] active:bg-accent-deep',
    ghost: 'border border-line bg-transparent text-ink hover:bg-panel2 hover:border-line2',
    subtle: 'bg-panel2 text-ink hover:bg-inset',
    danger: 'border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20',
  };
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(base, sizes[size], variants[variant], className)}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- Toggle
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  hint?: string;
}) {
  return (
    <label className={cn('flex items-center gap-2.5 min-w-0', disabled && 'opacity-40 pointer-events-none')}>
      <Switch.Root
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="relative h-[18px] w-[34px] rounded-full bg-line2 data-[state=checked]:bg-accent transition-colors after:absolute after:left-[2px] after:top-[2px] after:h-[14px] after:w-[14px] after:rounded-full after:bg-white after:transition-transform data-[state=checked]:after:translate-x-[16px] data-[state=checked]:after:bg-[#101408] focus-visible:outline-2 focus-visible:outline-accent/60"
      />
      {label && (
        <span className="group/tip relative flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] text-ink">{label}</span>
          {hint && (
            <span aria-hidden="true" className="pointer-events-none absolute left-0 top-full z-50 mt-1.5 w-max max-w-[300px] rounded-lg border border-line bg-panel2 px-2.5 py-1.5 text-left text-[11.5px] font-normal leading-snug text-ink opacity-0 shadow-xl transition-opacity duration-100 group-hover/tip:opacity-100">
              {hint}
            </span>
          )}
        </span>
      )}
    </label>
  );
}

// ---------------------------------------------------------------- Fields
export function Field({
  label,
  hint,
  children,
  inline,
}: {
  label: ReactNode;
  hint?: string;
  children: ReactNode;
  inline?: boolean;
}) {
  return (
    <div className={cn('min-w-0', inline ? 'flex items-center gap-3' : 'flex flex-col gap-1.5')}>
      <span className="flex items-center gap-1.5 text-[12px] font-medium text-mute uppercase tracking-wider">
        {label}
        {hint && <HintTip text={hint} />}
      </span>
      {children}
    </div>
  );
}

export function HintTip({ text }: { text: string }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Info size={12} className="text-faint hover:text-mute cursor-help" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align="start"
          className="z-50 max-w-[340px] rounded-lg border border-line bg-panel2 px-3 py-2 text-[12.5px] leading-relaxed text-ink shadow-xl"
        >
          {text}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const inputCls =
  'h-8.5 w-full rounded-lg border border-line bg-inset px-2.5 text-[13px] text-ink placeholder:text-faint focus:border-accent/50 focus:outline-none';

export const TextField = forwardRef<HTMLInputElement, { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; spellCheck?: boolean }>(
  function TextField({ value, onChange, placeholder, className, spellCheck = false }, ref) {
    return (
      <input
        ref={ref}
        type="text"
        value={value}
        spellCheck={spellCheck}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(inputCls, className)}
      />
    );
  },
);

export function NumberField({
  value,
  onChange,
  empty,
  onEmpty,
  min,
  max,
  step,
  suffix,
  disabled,
  className,
  placeholder,
}: {
  value: number | null;
  onChange: (v: number) => void;
  empty?: boolean;
  onEmpty?: () => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState<string>(value === null || value === undefined ? '' : String(value));
  useEffect(() => {
    const cur = value === null || value === undefined ? '' : String(value);
    if (text !== cur && document.activeElement?.getAttribute?.('data-nf') !== '1') setText(cur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className={cn('relative', className)}>
      <input
        data-nf="1"
        type="number"
        inputMode="decimal"
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        value={text}
        placeholder={text === '' ? (placeholder ?? 'default') : undefined}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value === '') {
            onEmpty?.();
            return;
          }
          const v = Number(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
        onBlur={() => {
          if (text === '') onEmpty?.();
          else {
            let v = Number(text);
            if (Number.isNaN(v)) v = value ?? (0 as number);
            if (min !== undefined) v = Math.max(min, v);
            if (max !== undefined) v = Math.min(max, v);
            onChange(v);
            setText(String(v));
          }
        }}
        className={cn(inputCls, 'font-mono', disabled && 'opacity-40', suffix && 'pr-14')}
      />
      {suffix && (
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-faint">{suffix}</span>
      )}
    </div>
  );
}

export function SelectField({
  value,
  onChange,
  options,
  className,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        inputCls,
        'cursor-pointer appearance-none bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\'%3E%3Cpath d=\'M1 1l4 4 4-4\' stroke=\'%238b94a7\' fill=\'none\' stroke-width=\'1.5\'/%3E%3C/svg%3E")] bg-no-repeat bg-[right_10px_center] pr-7',
        disabled && 'opacity-40',
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-panel text-ink">
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  disabled,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; hint?: string; disabled?: boolean }>;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('inline-flex rounded-lg border border-line bg-inset p-0.5', disabled && 'opacity-40 pointer-events-none', className)}>
      {options.map((o) => (
        <div key={o.value} className="group relative">
          <button
            type="button"
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors',
              o.disabled
                ? 'cursor-not-allowed text-faint/60'
                : value === o.value
                  ? 'bg-panel2 text-accent shadow-sm'
                  : 'text-mute hover:text-ink',
            )}
          >
            {o.label}
          </button>
          {o.hint && (
            <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 w-max max-w-[300px] -translate-x-1/2 rounded-lg border border-line bg-panel2 px-2.5 py-1.5 text-left text-[11.5px] font-normal leading-snug text-ink opacity-0 shadow-xl transition-opacity duration-100 group-hover:opacity-100">
              {o.hint}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Cards
export function SectionCard({
  title,
  description,
  icon,
  actions,
  children,
  className,
  anchor,
  collapsible = false,
  defaultCollapsed = false,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  anchor?: string;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
}) {
  const key = `ninfier.collapsed.${title}`;
  const [open, setOpen] = useState(() => {
    if (!collapsible) return true;
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? !defaultCollapsed : saved === '1';
    } catch {
      return !defaultCollapsed;
    }
  });
  useEffect(() => {
    if (!collapsible) return;
    try {
      localStorage.setItem(key, open ? '0' : '1');
    } catch {
      /* noop */
    }
  }, [open, key, collapsible]);
  return (
    <section id={anchor} className={cn('rounded-xl border border-line bg-panel scroll-mt-14', className)}>
      <header className={cn('flex items-center gap-2.5 border-b border-line px-4 py-3', !open && 'border-transparent')}>
        {collapsible && (
          <button
            className="shrink-0 rounded p-0.5 text-faint hover:text-ink"
            onClick={() => setOpen((o) => !o)}
            title={open ? 'collapse section' : 'expand section'}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
        {icon && <span className="text-accent">{icon}</span>}
        <div className="min-w-0 flex-1">
          <h3 className="text-[13.5px] font-semibold text-ink">{title}</h3>
          {description && <p className="mt-0.5 text-[12px] leading-snug text-mute">{description}</p>}
        </div>
        {actions}
      </header>
      {open && <div className="p-4">{children}</div>}
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'accent' }) {
  const toneCls = { ok: 'text-ok', warn: 'text-warn', danger: 'text-danger', accent: 'text-accent' }[tone || 'accent'];
  return (
    <div className="rounded-lg border border-line bg-inset px-3.5 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className={cn('mt-1 font-mono text-lg leading-none', toneCls)}>{value}</div>
      {sub && <div className="mt-1.5 text-[11.5px] text-mute">{sub}</div>}
    </div>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' | 'info' }) {
  const tones = {
    neutral: 'border-line bg-panel2 text-mute',
    ok: 'border-ok/30 bg-ok/10 text-ok',
    warn: 'border-warn/30 bg-warn/10 text-warn',
    danger: 'border-danger/30 bg-danger/10 text-danger',
    accent: 'border-accent/30 bg-accent/10 text-accent',
    info: 'border-info/30 bg-info/10 text-info',
  };
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] font-medium', tones[tone])}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------- Code
export function CodeBlock({ code, onCopy, singleLine }: { code: string; onCopy?: () => void; singleLine?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1400);
    onCopy?.();
  };
  return (
    <div className="group relative rounded-lg border border-line bg-inset">
      <pre className={cn('overflow-x-auto whitespace-pre-wrap break-words px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-ink/90', singleLine && 'whitespace-pre')}>
        {code}
      </pre>
      <button
        type="button"
        onClick={() => copy(code)}
        className="absolute right-2 top-2 rounded-md border border-line bg-panel2 p-1.5 text-mute opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
        title="Copy"
      >
        {copied ? <Check size={13} className="text-accent" /> : <Copy size={13} />}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- Modal
export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-panel shadow-2xl',
            wide ? 'w-[720px] max-w-[94vw]' : 'w-[460px] max-w-[92vw]',
          )}
        >
          <header className="flex items-center justify-between border-b border-line px-4 py-3">
            <Dialog.Title className="text-sm font-semibold text-ink">{title}</Dialog.Title>
            <Dialog.Close className="rounded-md p-1 text-mute hover:text-ink">✕</Dialog.Close>
          </header>
          <div className="max-h-[76vh] overflow-y-auto p-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------- Log pane
export function LogPane({ lines, autoScroll = true }: { lines: string[]; autoScroll?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (autoScroll && stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, autoScroll]);
  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="h-full overflow-y-auto rounded-lg border border-line bg-inset px-3 py-2 font-mono text-[11.5px] leading-[1.7] text-mute"
    >
      {lines.length === 0 && <span className="text-faint">no output yet</span>}
      {lines.map((l, i) => (
        <div
          key={i}
          className={cn(
            'whitespace-pre-wrap break-all',
            /ERROR|FATAL/i.test(l) && 'text-danger',
            /WARN/i.test(l) && 'text-warn',
            /ready|ready to serve|listening/i.test(l) && 'text-ok',
          )}
        >
          {l || '\u00a0'}
        </div>
      ))}
    </div>
  );
}
