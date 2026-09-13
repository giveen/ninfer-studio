import { Bot, Globe, Brain, Sparkles, Users, BookmarkPlus } from 'lucide-react';
import { Button, TextField, cn, SectionCard } from '../../components/ui';
import { MemoryModal } from '../../components/MemoryModal';
import { useChatAgent } from '../../lib/chatAgent';
import { chatMemorySetBank, chatMemoryDropLearning } from '../../lib/api';
import { engineMaxConcurrency } from '../../lib/engineInfo';
import type { PermTier } from '../../lib/coderTools';
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

/** 3-way allow/ask/deny selector for a single Chat tool — same visual
 *  language as Coder's per-tool tier grid in SafetyTab, scoped to
 *  useChatAgent's two Chat-only tiers instead of Coder's PermConfig. */
function TierRow({ label, tier, onChange }: { label: string; tier: PermTier; onChange: (v: PermTier) => void }) {
  return (
    <div className="flex items-center gap-1.5 rounded border border-line px-2 py-1">
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mute">{label}</span>
      {(['allow', 'ask', 'deny'] as PermTier[]).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          title={`${v} ${label}`}
          className={cn(
            'rounded px-2 py-0.5 text-[11px] font-medium',
            tier === v
              ? v === 'allow' ? 'bg-ok/20 text-ok' : v === 'ask' ? 'bg-warn/20 text-warn' : 'bg-danger/20 text-danger'
              : 'text-faint hover:bg-panel2 hover:text-mute',
          )}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

export function AgentTab({ status }: { status: StatusPayload | null }) {
  const {
    agentResearch, setAgentResearch, memoryEnabled, setMemoryEnabled, reflectionEnabled, setReflectionEnabled, deepResearchEnabled, setDeepResearchEnabled,
    memory, loadMemory, adoptMemory, memoryModalOpen, setMemoryModalOpen,
    reflectionModel, setReflectionModel,
    browserTier, setBrowserTier, memoryToolTier, setMemoryToolTier,
  } = useChatAgent();
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
        {agentResearch && (
          <div className="mt-3 border-t border-line pt-3">
            <TierRow label="browser" tier={browserTier} onChange={setBrowserTier} />
          </div>
        )}
      </SectionCard>

      <SectionCard title="Memory" icon={<Brain size={15} />} description="A persistent, cross-conversation bank of facts and preferences the model can write to.">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-faint">The model can proactively remember durable facts about you (name, preferences, ongoing projects) and recall them in every future conversation — separate from Coder's per-workspace memory.</p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void loadMemory();
                setMemoryModalOpen(true);
              }}
            >
              <BookmarkPlus size={13} /> Manage
            </Button>
            <ToggleRow
              on={memoryEnabled}
              onToggle={setMemoryEnabled}
              onTitle="Chat can read/write a persistent memory bank"
              offTitle="Chat has no memory beyond the current conversation"
            />
          </div>
        </div>
        {memoryEnabled && (
          <div className="mt-3 border-t border-line pt-3">
            <TierRow label="memory_update" tier={memoryToolTier} onChange={setMemoryToolTier} />
          </div>
        )}
      </SectionCard>

      <MemoryModal
        open={memoryModalOpen}
        onClose={() => setMemoryModalOpen(false)}
        title="Chat Memory"
        memory={memory}
        onSaveBank={(bank) => chatMemorySetBank(bank).then(adoptMemory)}
        onDropLearning={(id) => chatMemoryDropLearning(id).then(adoptMemory)}
        onChanged={loadMemory}
      />

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
        <div className="mt-3 flex items-center gap-2 border-t border-line pt-3" title="Optional model id the critique/regenerate pass uses instead of the conversation's own model. A stronger model reviewing a weaker one's replies avoids a model being lenient on its own output. Empty = same model.">
          <span className="shrink-0 text-[11.5px] text-faint">Critic model</span>
          <TextField
            value={reflectionModel}
            onChange={setReflectionModel}
            placeholder="same model"
            className="max-w-[220px]"
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
