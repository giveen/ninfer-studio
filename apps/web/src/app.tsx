import { useEffect, useState } from 'react';
import { Activity, Code2, Cpu, MessagesSquare, Moon, Settings2, Layers, Sun, Terminal } from 'lucide-react';
import { cn } from './components/ui';
import { getCoderWorkspace, useStatus } from './lib/api';
import type { StatusPayload } from './lib/types';
import { formatBytes, formatPct } from './lib/format';
import { applyTheme, getStoredTheme, type ThemeMode } from './lib/theme';
import { ChatScreen } from './screens/ChatScreen';
import { EngineScreen } from './screens/EngineScreen';
import { ModelsScreen } from './screens/ModelsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { CoderScreen } from './screens/CoderScreen';
import { LogScreen } from './screens/LogScreen';

type Screen = 'chat' | 'code' | 'engine' | 'log' | 'models' | 'settings';

const NAV: Array<{ id: Screen; label: string; icon: typeof MessagesSquare }> = [
  { id: 'chat', label: 'Chat', icon: MessagesSquare },
  { id: 'code', label: 'Code', icon: Code2 },
  { id: 'engine', label: 'Engine', icon: Cpu },
  { id: 'log', label: 'Log', icon: Terminal },
  { id: 'models', label: 'Models', icon: Layers },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];

function EnginePill({ status }: { status: StatusPayload | null }) {
  const e = status?.engine;
  const extra = status ? (status.engines ?? []).filter((x) => x.port !== e?.port && x.pid !== e?.pid).length : 0;
  if (!e) return <span className="h-2.5 w-2.5 rounded-full bg-faint" />;
  const map: Record<string, { dot: string; label: string; pulse?: boolean }> = {
    stopped: { dot: 'bg-faint', label: 'stopped' },
    starting: { dot: 'bg-warn', label: 'starting…', pulse: true },
    running: { dot: 'bg-ok', label: 'running' },
    stopping: { dot: 'bg-warn', label: 'stopping…', pulse: true },
    failed: { dot: 'bg-danger', label: 'failed' },
    external: { dot: 'bg-info', label: e.adopted ? 'external' : 'running' },
  };
  const m = map[e.state] || map.stopped;
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1.5 text-[12px] text-mute"
      title={e.failHint || e.failReason || e.state}
    >
      <span className={cn('h-2 w-2 rounded-full', m.dot, m.pulse && 'pulse-dot')} />
      <span className="font-medium text-ink">{m.label}</span>
      {e.modelId && <span className="font-mono text-[11.5px] text-accent">{e.modelId}</span>}
      {e.state === 'external' && <span className="text-[10.5px] uppercase tracking-wider text-info">not spawned by studio</span>}
      {extra > 0 && <span className="rounded-full bg-panel2 px-1.5 py-0.5 font-mono text-[10.5px] text-info" title={`${extra} other engine(s) discovered on other ports`}>+{extra}</span>}
    </span>
  );
}

function GpuChip({ status }: { status: StatusPayload | null }) {
  const g = status?.gpu;
  if (!g || !g.available || g.memTotalMiB == null) return null;
  const pct = g.memUsedMiB != null ? Math.min(100, Math.round(((g.memUsedMiB || 0) / g.memTotalMiB) * 100)) : 0;
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1.5 text-[12px] text-mute" title={g.name ?? 'GPU'}>
      <Activity size={13} className="text-accent" />
      <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-line">
        <span
          className={cn('absolute inset-y-0 left-0 rounded-full', pct > 90 ? 'bg-danger' : pct > 75 ? 'bg-warn' : 'bg-accent')}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="font-mono text-[11.5px]">
        {formatBytes(g.memUsedMiB! * 1024 * 1024)} / {formatBytes(g.memTotalMiB! * 1024 * 1024)}
      </span>
      <span className="font-mono text-[11.5px] text-faint">{g.utilPct ?? 0}%</span>
      <span className="text-[10.5px] uppercase tracking-wider">{formatPct(g.memUsedMiB, g.memTotalMiB)} vram</span>
    </span>
  );
}

export function App() {
  const [screen, setScreen] = useState<Screen>('chat');
  const [coderWs, setCoderWs] = useState('');
  const [theme, setTheme] = useState<ThemeMode>(getStoredTheme);
  const { status, error } = useStatus(2500);

  useEffect(() => {
    getCoderWorkspace()
      .then((w) => setCoderWs(w.workspace))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <div className="flex h-full overflow-hidden">
      {/* left rail */}
      <nav className="flex w-14 shrink-0 flex-col items-center gap-1.5 border-r border-line bg-panel py-3">
        <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-accent/30 bg-accent/10">
          <span className="font-mono text-[15px] font-bold text-accent">N</span>
        </div>
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => setScreen(n.id)}
            title={n.label}
            aria-label={n.label}
            aria-current={screen === n.id || undefined}
            className={cn(
              'flex h-10 w-10 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium transition-colors',
              screen === n.id ? 'bg-accent/12 text-accent' : 'text-faint hover:bg-panel2 hover:text-ink',
            )}
          >
            <n.icon size={18} strokeWidth={1.8} />
          </button>
        ))}
        <button
          type="button"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          className="mt-auto flex h-10 w-10 items-center justify-center rounded-lg text-faint transition-colors hover:bg-panel2 hover:text-ink"
        >
          {theme === 'dark' ? <Sun size={18} strokeWidth={1.8} /> : <Moon size={18} strokeWidth={1.8} />}
        </button>
      </nav>

      {/* main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold tracking-tight">NInfer Studio</span>
            <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-faint">{__APP_VERSION__}</span>
          </div>
          <div className="ml-2 flex items-center gap-2">
            <EnginePill status={status} />
            <GpuChip status={status} />
          </div>
          <div className="ml-auto flex items-center gap-3 text-[11.5px] text-faint">
            {status?.config && (
              <span className="font-mono">
                engine <span className="text-mute">:{status.config.enginePort}</span>
              </span>
            )}
            {error && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-danger/40 bg-danger/10 px-2.5 py-1 text-danger" title={error}>
                control plane unreachable
              </span>
            )}
          </div>
        </header>

        {/* All screens stay mounted; the inactive ones are hidden via CSS.
            Unmounting on tab switch destroys in-flight work: a running
            chat/coder stream keeps its fetch alive after unmount but its
            state updates are dropped, so the reply never shows (and the turn
            is lost from the debounced save). Hiding keeps streams, drafts,
            params, and scroll positions alive across tabs. */}
        <main className="min-h-0 flex-1 overflow-hidden">
          <div className={cn('h-full', screen !== 'chat' && 'hidden')}>
            <ChatScreen status={status} onNavigate={setScreen} />
          </div>
          <div className={cn('h-full', screen !== 'code' && 'hidden')}>
            <CoderScreen coderWs={coderWs} />
          </div>
          <div className={cn('h-full', screen !== 'engine' && 'hidden')}>
            <EngineScreen status={status} />
          </div>
          <div className={cn('h-full', screen !== 'log' && 'hidden')}>
            <LogScreen status={status} />
          </div>
          <div className={cn('h-full', screen !== 'models' && 'hidden')}>
            <ModelsScreen status={status} />
          </div>
          <div className={cn('h-full', screen !== 'settings' && 'hidden')}>
            <SettingsScreen status={status} />
          </div>
        </main>
      </div>
    </div>
  );
}
