import { Bot } from 'lucide-react';
import { SectionCard } from '../../components/ui';

export function AgentTab() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-4">
      <SectionCard title="Agent" icon={<Bot size={15} />} description="Autonomy and tool-access config for turning Chat into more of an agent.">
        <p className="text-[12.5px] text-faint">Agent settings are coming soon.</p>
      </SectionCard>
    </div>
  );
}
