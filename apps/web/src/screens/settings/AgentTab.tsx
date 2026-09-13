import { Bot, Globe, Brain, Sparkles, Users } from 'lucide-react';
import { cn, SectionCard } from '../../components/ui';
import { useChatAgent } from '../../lib/chatAgent';
import { engineMaxConcurrency } from '../../lib/engineInfo';
import type { StatusPayload } from '../../lib/types';

function ToggleRow({ on, onToggle, onTitle, offTitle }: {
  on: boolean; onToggle: (next: boolean) => void; onTitle: string; offTitle: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!on)}
      className={cn('shrink-0 rounded px-2.5 py-1 text-[11px] font-medium', on ? 'bg-ok/20 text-ok' : 'bg-danger/20 text-danger')}
      title={on ? onTitle : offTitle}
    >
      {on ? 'ON' : 'OFF'}
    </button>
  );
}

export function AgentTab({ status }: { status: StatusPayload | null }) {
  const { agentResearch, setAgentResearch, memoryEnabled, setMemoryEnabled, reflectionEnabled, setReflectionEnabled, deepResearchEnabled, setDeepResearchEnabled } = useChatAgent();
  const maxConcurrency = engineMaxConcurrency(status);
  const deepResearchAvailable = maxConcurrency > 1;

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-5 py-4">
      <SectionCard
        title="Agent Mode"
        icon={<Bot size={15} />}
        description="Autonomy and tool-access for Chat. Off is today's exact behavior — just web_fetch and web_search."
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[12.5px] text-faint">
            <Globe size={13} className="shrink-0" />
            <p>Adds the built-in headless <span className="font-mono">browser</span> tool for JS-rendered pages — sandboxed to its own browser session, never touches your filesystem.</p>
          </div>
          <ToggleRow
            on={agentResearch}
            onToggle={setAgentResearch}
            onTitle="Chat can use the headless browser tool alongside web_fetch/web_search"
            offTitle="Chat has only web_fetch/web_search — today's default"
          />
        </div>
      </SectionCard>

      <SectionCard title="Memory" icon={<Brain size={15} />} description="A persistent, cross-conversation bank of facts and preferences the model can write to.">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-faint">The model can proactively remember durable facts about you (name, preferences, ongoing projects) and recall them in every future conversation — separate from Coder's per-workspace memory.</p>
          <ToggleRow
            on={memoryEnabled}
            onToggle={setMemoryEnabled}
            onTitle="Chat can read/write a persistent memory bank"
            offTitle="Chat has no memory beyond the current conversation"
          />
        </div>
      </SectionCard>

      <SectionCard title="Reflection" icon={<Sparkles size={15} />} description="An extra self-review pass before a reply is shown.">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-faint">After a reply completes, one extra pass checks it against your question and regenerates once if it finds a real issue. Roughly doubles latency and cost per reply — off by default.</p>
          <ToggleRow
            on={reflectionEnabled}
            onToggle={setReflectionEnabled}
            onTitle="Replies get one self-review pass before showing"
            offTitle="Replies show as soon as generation finishes"
          />
        </div>
      </SectionCard>

      <SectionCard title="Deep research" icon={<Users size={15} />} description="Fans a question out into parallel research angles, then synthesizes one answer.">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-faint">
            {deepResearchAvailable
              ? `Breaks a question into up to ${Math.min(maxConcurrency, 3)} independent angles, researches each in parallel, then combines the findings into one answer.`
              : 'Needs an engine profile with max-concurrency > 1 to actually run in parallel — the current profile only has 1 lane.'}
          </p>
          <ToggleRow
            on={deepResearchEnabled}
            onToggle={setDeepResearchEnabled}
            onTitle={deepResearchAvailable ? 'Chat can fan a question out into parallel research angles' : 'Enabled, but inert until the engine runs with max-concurrency > 1'}
            offTitle="Chat researches a question in one pass"
          />
        </div>
      </SectionCard>
    </div>
  );
}
