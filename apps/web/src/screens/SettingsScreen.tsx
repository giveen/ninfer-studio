import { useState } from 'react';
import { Bot, Cpu, Info, ShieldCheck } from 'lucide-react';
import { cn } from '../components/ui';
import type { StatusPayload } from '../lib/types';
import { EngineTab } from './settings/EngineTab';
import { SafetyTab } from './settings/SafetyTab';
import { AgentTab } from './settings/AgentTab';
import { AboutTab } from './settings/AboutTab';

type SettingsTab = 'engine' | 'safety' | 'agent' | 'about';

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Cpu }> = [
  { id: 'engine', label: 'Engine', icon: Cpu },
  { id: 'safety', label: 'Safety & Permissions', icon: ShieldCheck },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'about', label: 'About', icon: Info },
];

export function SettingsScreen({ status }: { status: StatusPayload | null }) {
  const [tab, setTab] = useState<SettingsTab>('engine');
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <nav className="sticky top-0 z-20 shrink-0 border-b border-line bg-panel/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl gap-1 px-5 py-1.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                tab === t.id ? 'border-accent/40 bg-accent/12 text-accent' : 'border-line bg-inset text-mute hover:border-line2 hover:text-ink',
              )}
            >
              <t.icon size={13} /> {t.label}
            </button>
          ))}
        </div>
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn(tab !== 'engine' && 'hidden')}><EngineTab status={status} /></div>
        <div className={cn(tab !== 'safety' && 'hidden')}><SafetyTab /></div>
        <div className={cn(tab !== 'agent' && 'hidden')}><AgentTab /></div>
        <div className={cn(tab !== 'about' && 'hidden')}><AboutTab /></div>
      </div>
    </div>
  );
}
