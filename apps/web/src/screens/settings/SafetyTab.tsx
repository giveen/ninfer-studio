import { useState } from 'react';
import { GitCommit, Shield, ShieldCheck } from 'lucide-react';
import { cn, SectionCard } from '../../components/ui';
import { useCoderSafety } from '../../lib/coderSafety';
import { loadDefaultPerms, saveDefaultPerms } from '../../lib/coderStore';
import { TOOLS, type PermConfig, type PermTier } from '../../lib/coderTools';

function ToggleRow({ on, onToggle, onTitle, offTitle, onLabel = 'ON', offLabel = 'OFF' }: {
  on: boolean; onToggle: (next: boolean) => void; onTitle: string; offTitle: string; onLabel?: string; offLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!on)}
      className={cn('rounded px-2.5 py-1 text-[11px] font-medium', on ? 'bg-ok/20 text-ok' : 'bg-danger/20 text-danger')}
      title={on ? onTitle : offTitle}
    >
      {on ? onLabel : offLabel}
    </button>
  );
}

export function SafetyTab() {
  const { safeMode, setSafeMode, sandbox, setSandbox, bwrapAvailable, commitApproval, setCommitApproval } = useCoderSafety();
  const [perms, setPermsState] = useState<PermConfig>(loadDefaultPerms);

  const setPerms = (next: PermConfig) => {
    setPermsState(next);
    saveDefaultPerms(next);
  };
  const setToolPerm = (name: string, tier: PermTier) => {
    setPerms({ ...perms, tools: { ...perms.tools, [name]: tier } });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-5 py-4">
      <SectionCard title="Safe Mode" icon={<Shield size={15} />} description="Blocks clearly destructive shell commands before they run.">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-faint">Blocks <code className="font-mono">rm -rf /</code>, <code className="font-mono">git push --force</code>, <code className="font-mono">mkfs</code>, piping downloads into a shell, and similar.</p>
          <ToggleRow on={safeMode} onToggle={setSafeMode} onTitle="Destructive commands are blocked" offTitle="Destructive commands are allowed" />
        </div>
      </SectionCard>

      <SectionCard title="Sandbox" icon={<Shield size={15} />} description="Wraps the agent shell in bwrap (workspace read-write, host read-only).">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-[12.5px] text-faint">Wraps <code className="font-mono">bash</code> in <code className="font-mono">bwrap</code> — host filesystem is read-only, only the workspace is writable. Requires <code className="font-mono">bwrap</code> installed.</p>
            {sandbox && !bwrapAvailable && (
              <p className="text-[12.5px] text-warn">bwrap isn&apos;t installed on this host — the agent shell is running unsandboxed despite this being ON.</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSandbox(!sandbox)}
            className={cn(
              'shrink-0 rounded px-2.5 py-1 text-[11px] font-medium',
              sandbox && bwrapAvailable ? 'bg-ok/20 text-ok' : sandbox ? 'bg-warn/20 text-warn' : 'bg-danger/20 text-danger',
            )}
            title={
              sandbox && bwrapAvailable
                ? 'Agent shell is wrapped in bwrap (writes limited to the workspace)'
                : sandbox
                  ? 'Sandbox is enabled but bwrap is not installed — the shell is actually running unsandboxed on the host'
                  : 'Agent shell runs directly on the host'
            }
          >
            {sandbox && bwrapAvailable ? 'ON' : sandbox ? 'ON · bwrap missing' : 'OFF'}
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Commit approval" icon={<GitCommit size={15} />} description="Gate: the agent cannot commit without human sign-off.">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-faint">When ON, the agent cannot commit until you review the working-tree-vs-HEAD diff and approve. Auto-commits on write/edit are paused so only intentional, reviewed commits land.</p>
          <ToggleRow on={commitApproval} onToggle={setCommitApproval} onTitle="Agent commits require your approval of the working-tree diff" offTitle="Agent may commit freely (auto-commits on every write)" />
        </div>
      </SectionCard>

      <SectionCard
        title="Default permissions template"
        icon={<ShieldCheck size={15} />}
        description="Seeds a brand-new workspace's tool tiers and denied paths. Existing workspaces keep their own settings (edit those from the Coder sidebar) — changing this template never touches them."
      >
        <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
          {TOOLS.map((t) => {
            const tier = perms.tools[t.function.name] ?? 'allow';
            return (
              <div key={t.function.name} className="flex items-center gap-1.5 rounded border border-line px-2 py-1">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mute" title={t.function.description}>{t.function.name}</span>
                {(['allow', 'ask', 'deny'] as PermTier[]).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setToolPerm(t.function.name, v)}
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
        <input
          defaultValue={perms.denyPaths.join(' ')}
          placeholder="Denied paths, space-separated (e.g. secrets/ .env)"
          title="Tool calls touching these workspace-relative paths are denied"
          onBlur={(e) => setPerms({ ...perms, denyPaths: e.target.value.split(/\s+/).map((s) => s.trim()).filter(Boolean) })}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          className="mt-3 w-full rounded border border-line bg-inset px-2 py-1.5 font-mono text-[11.5px] outline-none placeholder:text-faint focus:border-accent/50"
        />
      </SectionCard>
    </div>
  );
}
