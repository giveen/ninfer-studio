import { useState } from 'react';
import { Bot, Cpu, Info, Palette, ShieldCheck } from 'lucide-react';
import { TabNav, cn } from '../components/ui';
import type { StatusPayload } from '../lib/types';
import { EngineTab } from './settings/EngineTab';
import { SafetyTab } from './settings/SafetyTab';
import { AgentTab } from './settings/AgentTab';
import { ThemesTab } from './settings/ThemesTab';
import { AboutTab } from './settings/AboutTab';

type SettingsTab = 'engine' | 'safety' | 'agent' | 'themes' | 'about';

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Cpu }> = [
  { id: 'engine', label: 'Engine', icon: Cpu },
  { id: 'safety', label: 'Safety & Permissions', icon: ShieldCheck },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'themes', label: 'Themes', icon: Palette },
  { id: 'about', label: 'About', icon: Info },
];

export function SettingsScreen({ status }: { status: StatusPayload | null }) {
  const [tab, setTab] = useState<SettingsTab>('engine');
  const [visited, setVisited] = useState<Set<SettingsTab>>(() => new Set(['engine']));

  const handleSelectTab = (nextTab: SettingsTab) => {
    setTab(nextTab);
    setVisited((prev) => (prev.has(nextTab) ? prev : new Set(prev).add(nextTab)));
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TabNav tabs={TABS} activeTab={tab} onTabChange={handleSelectTab} maxWidth="max-w-5xl" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div role="tabpanel" id="panel-engine" aria-labelledby="tab-engine" className={cn(tab !== 'engine' && 'hidden')}>
          {visited.has('engine') && <EngineTab status={status} active={tab === 'engine'} />}
        </div>
        <div role="tabpanel" id="panel-safety" aria-labelledby="tab-safety" className={cn(tab !== 'safety' && 'hidden')}>
          {visited.has('safety') && <SafetyTab active={tab === 'safety'} />}
        </div>
        <div role="tabpanel" id="panel-agent" aria-labelledby="tab-agent" className={cn(tab !== 'agent' && 'hidden')}>
          {visited.has('agent') && <AgentTab status={status} active={tab === 'agent'} />}
        </div>
        <div role="tabpanel" id="panel-themes" aria-labelledby="tab-themes" className={cn(tab !== 'themes' && 'hidden')}>
          {visited.has('themes') && <ThemesTab />}
        </div>
        <div role="tabpanel" id="panel-about" aria-labelledby="tab-about" className={cn(tab !== 'about' && 'hidden')}>
          {visited.has('about') && <AboutTab />}
        </div>
      </div>
    </div>
  );
}


