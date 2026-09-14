import { useEffect, useState } from 'react';
import { Bot, Globe, Brain, Sparkles, Users, BookmarkPlus, Terminal, FolderOpen } from 'lucide-react';
import { Button, TextField, NumberField, cn, SectionCard } from '../../components/ui';
import { MemoryModal } from '../../components/MemoryModal';
import { DirBrowser } from '../../components/DirBrowser';
import { useChatAgent } from '../../lib/chatAgent';
import { chatMemorySetBank, chatMemoryDropLearning, mcpToolsGet, type McpToolInfo } from '../../lib/api';
import { engineMaxConcurrency } from '../../lib/engineInfo';
import { COMPUTER_USE_TOOLS } from '../../lib/chatHelpers';
import { mcpToolTier, type PermTier } from '../../lib/coderTools';
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
    deepResearchMaxAngles, setDeepResearchMaxAngles, deepResearchMaxSteps, setDeepResearchMaxSteps,
    reflectionCritiqueMaxTokens, setReflectionCritiqueMaxTokens,
    computerUseEnabled, setComputerUseEnabled, computerUseDir, setComputerUseDir, computerUsePerms, setComputerUsePerms,
  } = useChatAgent();
  const maxConcurrency = engineMaxConcurrency(status);
  const deepResearchAvailable = maxConcurrency > 1;
  const [showDirBrowser, setShowDirBrowser] = useState(false);
  const setComputerUseToolPerm = (tool: string, tier: PermTier) =>
    setComputerUsePerms({ ...computerUsePerms, tools: { ...computerUsePerms.tools, [tool]: tier } });

  // MCP tools offered to Chat's agent (same scope/directory as the loop in
  // ChatScreen). The catalog can take a while on a cold start — it connects
  // the servers on demand — so fire-and-forget and render when it lands.
  const [mcpTools, setMcpTools] = useState<McpToolInfo[]>([]);
  useEffect(() => {
    if (!computerUseEnabled) {
      setMcpTools([]);
      return;
    }
    let live = true;
    mcpToolsGet(computerUseDir)
      .then((r) => { if (live) setMcpTools(r.tools); })
      .catch(() => { if (live) setMcpTools([]); });
    return () => { live = false; };
  }, [computerUseEnabled, computerUseDir]);

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

      <SectionCard
        title="Computer Use"
        icon={<Terminal size={15} />}
        description="Adds file, shell, search, and basic git tools to Chat, scoped to a directory of your choosing — for general 'use my computer' tasks, not coding specifically (Coder is the tuned harness for that)."
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-faint">Independent of Coder's own workspace and permissions — per-tool tiers below.</p>
          <ToggleRow
            on={computerUseEnabled}
            onToggle={setComputerUseEnabled}
            onTitle="Chat can read/write files, run shell commands, and search within the directory below"
            offTitle="Chat has no filesystem or shell access"
          />
        </div>
        {computerUseEnabled && (
          <div className="mt-3 space-y-3 border-t border-line pt-3">
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-[11.5px] text-faint">Directory</span>
              <TextField value={computerUseDir} onChange={setComputerUseDir} placeholder="defaults to the OS temp dir" className="flex-1 font-mono text-[11.5px]" />
              <Button variant="ghost" size="sm" onClick={() => setShowDirBrowser(true)}>
                <FolderOpen size={13} /> Browse
              </Button>
            </div>
            <p className="text-[12px] text-faint">
              {computerUseDir
                ? 'The model can redirect this itself mid-conversation with set_directory when you ask (e.g. "do that in my home folder instead") — this just sets the starting point.'
                : 'No directory set — Computer Use tools are not offered to the model until one is set (normally the OS temp dir by default).'}
            </p>
            <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
              {COMPUTER_USE_TOOLS.map((t) => {
                const tier = computerUsePerms.tools[t.function.name] ?? 'allow';
                return (
                  <div key={t.function.name} className="flex items-center gap-1.5 rounded border border-line px-2 py-1">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mute" title={t.function.description}>{t.function.name}</span>
                    {(['allow', 'ask', 'deny'] as PermTier[]).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setComputerUseToolPerm(t.function.name, v)}
                        title={`${v} ${t.function.name}`}
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
              })}
            </div>
            {mcpTools.length > 0 && (
              <div className="space-y-1.5 border-t border-line pt-2">
                <p className="text-[11.5px] text-faint">
                  MCP tools — external servers configured in Settings → Safety &amp; Permissions. A row for the whole server
                  (<code className="font-mono">mcp__&lt;server&gt;</code>) applies to every one of its tools; a per-tool row overrides it.
                </p>
                {mcpTools.map((t) => {
                  const tier = mcpToolTier(computerUsePerms, t.name);
                  return (
                    <div key={t.name} className="flex items-center gap-1.5 rounded border border-line px-2 py-1">
                      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mute" title={t.description}>{t.name}</span>
                      {(['allow', 'ask', 'deny'] as PermTier[]).map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setComputerUseToolPerm(t.name, v)}
                          title={`${v} ${t.name}`}
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
                })}
              </div>
            )}
            <input
              defaultValue={computerUsePerms.denyPaths.join(' ')}
              placeholder="Denied paths, space-separated (e.g. secrets/ .env)"
              title="Tool calls touching these directory-relative paths are denied"
              onBlur={(e) => setComputerUsePerms({ ...computerUsePerms, denyPaths: e.target.value.split(/\s+/).map((s) => s.trim()).filter(Boolean) })}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              className="w-full rounded border border-line bg-inset px-2 py-1.5 font-mono text-[11.5px] outline-none placeholder:text-faint focus:border-accent/50"
            />
          </div>
        )}
      </SectionCard>

      {showDirBrowser && (
        <DirBrowser
          initialPath={computerUseDir || '~'}
          onPick={(p) => { setComputerUseDir(p); setShowDirBrowser(false); }}
          onClose={() => setShowDirBrowser(false)}
        />
      )}

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
        <div className="mt-3 flex items-center gap-2 border-t border-line pt-3" title="Token budget for the critique call itself (the verdict/critique text, not the regenerated reply).">
          <span className="shrink-0 text-[11.5px] text-faint">Critique token budget</span>
          <NumberField
            value={reflectionCritiqueMaxTokens}
            onChange={setReflectionCritiqueMaxTokens}
            min={50}
            max={4000}
            placeholder="400"
            className="max-w-[100px]"
          />
        </div>
      </SectionCard>

      <SectionCard title="Deep research" icon={<Users size={15} />} description="Fans a question out into parallel research angles, then synthesizes one answer.">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-faint">
            {deepResearchAvailable
              ? `Breaks a question into up to ${Math.min(maxConcurrency, deepResearchMaxAngles)} independent angles, researches each in parallel, then combines the findings into one answer.`
              : 'Needs an engine profile with max-concurrency > 1 to actually run in parallel — the current profile only has 1 lane.'}
          </p>
          <ToggleRow
            on={deepResearchEnabled}
            onToggle={setDeepResearchEnabled}
            onTitle={deepResearchAvailable ? 'Chat can fan a question out into parallel research angles' : 'Enabled, but inert until the engine runs with max-concurrency > 1'}
            offTitle="Chat researches a question in one pass"
          />
        </div>
        <div className="mt-3 flex items-center gap-4 border-t border-line pt-3">
          <div className="flex items-center gap-2" title="Cap on parallel research angles — still bounded by the engine's max-concurrency at run time.">
            <span className="shrink-0 text-[11.5px] text-faint">Max angles</span>
            <NumberField value={deepResearchMaxAngles} onChange={setDeepResearchMaxAngles} min={1} max={10} placeholder="3" className="max-w-[80px]" />
          </div>
          <div className="flex items-center gap-2" title="Tool-call step budget for each individual research angle.">
            <span className="shrink-0 text-[11.5px] text-faint">Steps per angle</span>
            <NumberField value={deepResearchMaxSteps} onChange={setDeepResearchMaxSteps} min={1} max={30} placeholder="5" className="max-w-[80px]" />
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
