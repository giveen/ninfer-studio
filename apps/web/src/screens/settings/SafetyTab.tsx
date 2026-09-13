import { useEffect, useState } from 'react';
import { Check, Copy, GitCommit, Globe, Shield, ShieldCheck } from 'lucide-react';
import { cn, SectionCard } from '../../components/ui';
import { useCoderSafety } from '../../lib/coderSafety';
import { loadDefaultPerms, saveDefaultPerms } from '../../lib/coderStore';
import { TOOLS, type PermConfig, type PermTier } from '../../lib/coderTools';
import { getRemoteAccessStatus, startRemoteAccess, stopRemoteAccess, type RemoteAccessStatus } from '../../lib/api/remote';

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

  const [remote, setRemote] = useState<RemoteAccessStatus | null>(null);
  const [remotePort, setRemotePort] = useState(1337);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteError, setRemoteError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    getRemoteAccessStatus().then((s) => { setRemote(s); setRemotePort(s.port); }).catch(() => {});
  }, []);
  const toggleRemote = async () => {
    setRemoteBusy(true);
    setRemoteError('');
    try {
      const s = remote?.running ? await stopRemoteAccess() : await startRemoteAccess(remotePort);
      setRemote(s);
      setRemotePort(s.port);
    } catch (e) {
      setRemoteError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoteBusy(false);
    }
  };
  const remoteUrl = remote?.lanIp ? `http://${remote.lanIp}:${remote.port}` : null;
  const copyRemoteUrl = () => {
    if (!remoteUrl) return;
    navigator.clipboard.writeText(remoteUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
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
        title="Remote Access"
        icon={<Globe size={15} />}
        description="Serve this app on your network so another device (a laptop, a tablet) can open the same live session."
      >
        <div className="space-y-3">
          <p className="rounded border border-danger/40 bg-danger/10 px-2.5 py-2 text-[12px] font-medium text-danger">
            No authentication. Anyone who can reach this address gets full control of this machine through the agent — shell commands, file writes, git, the browser tool. Only enable this on a network you trust, and turn it off when you&apos;re done.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-[12px] text-mute">
              Port
              <input
                type="number"
                min={1}
                max={65535}
                value={remotePort}
                disabled={!!remote?.running}
                onChange={(e) => setRemotePort(Number(e.target.value) || 1337)}
                className="w-20 rounded border border-line bg-inset px-1.5 py-0.5 font-mono text-[12px] outline-none disabled:opacity-50"
              />
            </label>
            <button
              type="button"
              onClick={toggleRemote}
              disabled={remoteBusy || !remote}
              className={cn(
                'rounded px-2.5 py-1 text-[11px] font-medium disabled:opacity-50',
                remote?.running ? 'bg-ok/20 text-ok' : 'bg-danger/20 text-danger',
              )}
              title={remote?.running ? 'Serving on the network — click to stop' : 'Only reachable from this machine'}
            >
              {remoteBusy ? '…' : remote?.running ? 'ON' : 'OFF'}
            </button>
          </div>
          {remoteError && <p className="text-[12px] text-danger">{remoteError}</p>}
          {remote?.running && (
            <div className="space-y-1">
              <p className="text-[12px] text-faint">Open this on the other device:</p>
              {remoteUrl ? (
                <div className="flex items-center gap-1.5">
                  <code className="rounded border border-line bg-inset px-2 py-1 font-mono text-[12.5px] text-ink">{remoteUrl}</code>
                  <button type="button" onClick={copyRemoteUrl} title="Copy" className="rounded p-1 text-faint hover:bg-panel2 hover:text-mute">
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>
              ) : (
                <p className="text-[12.5px] text-warn">Couldn&apos;t detect a LAN address — find this machine&apos;s IP (e.g. <code className="font-mono">ip addr</code>) and open <code className="font-mono">http://&lt;that-ip&gt;:{remote.port}</code> instead.</p>
              )}
            </div>
          )}
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
