import { useEffect, useState } from 'react';
import { Check, Copy, GitCommit, Globe, Plus, Plug, RefreshCw, Shield, ShieldCheck, Trash2 } from 'lucide-react';
import { Badge, Button, cn, SectionCard, Segmented, TextField } from '../../components/ui';
import { useCoderSafety } from '../../lib/coderSafety';
import { loadDefaultPerms, saveDefaultPerms } from '../../lib/coderStore';
import { TOOLS, type PermConfig, type PermTier } from '../../lib/coderTools';
import { getRemoteAccessStatus, startRemoteAccess, stopRemoteAccess, type RemoteAccessStatus } from '../../lib/api/remote';
import { mcpServersGet, mcpServersUpsert, mcpServerDelete, mcpServerRestart, type McpServerInfo, type McpServerSpec } from '../../lib/api/mcp';

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

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) servers — external tool servers owned by the
// control plane (desktop/control/src/mcp.rs). Their tools reach the agent
// loops as `mcp__<server>__<tool>` and ride the same allow/ask/deny tiers;
// the per-server row shown under each entry is the `mcp__<server>` fallback
// key (mirrors the control plane's `tier_for`).
// ---------------------------------------------------------------------------

type McpDraft = {
  name: string;
  kind: 'stdio' | 'http';
  command: string;
  args: string;
  cwd: string;
  env: string;
  url: string;
  authorization: string;
  headers: string;
};

const EMPTY_MCP_DRAFT: McpDraft = { name: '', kind: 'stdio', command: '', args: '', cwd: '', env: '', url: '', authorization: '', headers: '' };

/** Split on whitespace, keeping `'single'` / `"double"` quoted spans intact
 *  (so paths and values with spaces survive — e.g. args like
 *  `"C:/My Tools/server.py" --root "/data/my dir"`). Unmatched quotes swallow
 *  the rest of the input rather than dropping it. */
function splitShellWords(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let had = false;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      had = true;
    } else if (/\s/.test(ch)) {
      if (had || cur) { out.push(cur); cur = ''; had = false; }
    } else {
      cur += ch;
      had = true;
    }
  }
  if (had || cur) out.push(cur);
  return out;
}

/** Space-separated `KEY=VALUE` pairs (env, headers) to a record. Values may
 *  be quoted to keep spaces (`KEY="a b"`). */
function parseKvList(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tok of splitShellWords(raw)) {
    const eq = tok.indexOf('=');
    if (eq <= 0) continue;
    out[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return out;
}

function McpServersCard({ perms, onServerTier }: {
  perms: PermConfig;
  onServerTier: (server: string, tier: PermTier) => void;
}) {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<McpDraft>(EMPTY_MCP_DRAFT);

  const refresh = () => {
    mcpServersGet()
      .then((r) => setServers(r.servers))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  // Connections come up asynchronously after a save/restart, so keep the
  // status column live instead of forcing a manual refresh.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, []);

  const add = async () => {
    const name = draft.name.trim();
    const command = draft.command.trim();
    const url = draft.url.trim();
    if (!name) { setErr('Server name is required.'); return; }
    if (draft.kind === 'stdio' && !command) { setErr('A command is required for a stdio server.'); return; }
    if (draft.kind === 'http' && !url) { setErr('A URL is required for an HTTP server.'); return; }
    setBusy(true);
    setErr('');
    const spec: McpServerSpec =
      draft.kind === 'stdio'
        ? {
            name,
            command,
            args: splitShellWords(draft.args),
            env: parseKvList(draft.env),
            cwd: draft.cwd.trim() || undefined,
          }
        : {
            name,
            url,
            headers: parseKvList(draft.headers),
            authorization: draft.authorization.trim() || undefined,
          };
    try {
      await mcpServersUpsert(spec);
      setDraft(EMPTY_MCP_DRAFT);
      setOpen(false);
      refresh();
    } catch (e) {
      // The spec is persisted server-side even when the connection fails —
      // refetch so the list shows the entry with its error status.
      setErr(e instanceof Error ? e.message : String(e));
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const restart = async (name: string) => {
    setBusyName(name);
    setErr('');
    try {
      await mcpServerRestart(name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyName(null);
      refresh();
    }
  };

  const del = async (name: string) => {
    setBusyName(name);
    setErr('');
    try {
      await mcpServerDelete(name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyName(null);
      setConfirmDel(null);
      refresh();
    }
  };

  return (
    <SectionCard
      title="MCP Servers"
      icon={<Plug size={15} />}
      description="External tool servers (Model Context Protocol) — spawned as child processes (stdio) or addressed over HTTP. Their tools reach the agents as mcp__<server>__<tool> through the same tiers as the built-ins; the per-server row under each entry covers all of its tools until a per-tool row overrides it."
    >
      <div className="space-y-3">
        {servers.length === 0 && !open && (
          <p className="text-[12.5px] text-faint">No servers configured. Add one to extend the agents with external tools (file systems, APIs, databases…).</p>
        )}
        {servers.map((s) => {
          const key = `mcp__${s.name}`;
          const tier = perms.tools[key] ?? 'allow';
          const failed = s.status.startsWith('error:');
          return (
            <div key={s.name} className="space-y-1.5 rounded border border-line px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[12px] text-ink">{s.name}</span>
                <Badge tone="neutral">{s.transport}</Badge>
                <Badge tone={s.status === 'connected' ? 'ok' : failed ? 'danger' : 'warn'}>
                  {s.status === 'connected' ? `connected · ${s.toolCount} tools` : s.status}
                </Badge>
                {s.pid != null && <span className="text-[11px] text-faint">pid {s.pid}</span>}
                <div className="ml-auto flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => restart(s.name)} disabled={busyName !== null}>
                    <RefreshCw size={12} /> {busyName === s.name ? '…' : 'Restart'}
                  </Button>
                  {confirmDel === s.name ? (
                    <Button variant="danger" size="sm" onClick={() => del(s.name)} disabled={busyName !== null}>
                      <Trash2 size={12} /> Confirm
                    </Button>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={() => setConfirmDel(s.name)} disabled={busyName !== null} title={`Delete ${s.name}`}>
                      <Trash2 size={12} />
                    </Button>
                  )}
                </div>
              </div>
              {s.status === 'connected' && s.peer?.name && (
                <p className="text-[11px] text-faint">{s.peer.name}{s.peer.version ? ` ${s.peer.version}` : ''}</p>
              )}
              <div className="flex items-center gap-1.5 rounded border border-line px-2 py-1">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mute" title={`Default tier for every ${key}__* tool — per-tool rows (Coder sidebar) override`}>{key}</span>
                {(['allow', 'ask', 'deny'] as PermTier[]).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => onServerTier(key, v)}
                    title={`${v} every tool on ${s.name}`}
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
            </div>
          );
        })}
        {err && <p className="text-[12px] text-danger">{err}</p>}
        {open ? (
          <div className="space-y-2 rounded border border-line px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <TextField value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} placeholder="server name" className="flex-1 font-mono text-[11.5px]" />
              <Segmented
                value={draft.kind}
                options={[
                  { value: 'stdio', label: 'stdio' },
                  { value: 'http', label: 'http' },
                ]}
                onChange={(v) => setDraft({ ...draft, kind: v })}
              />
            </div>
            {draft.kind === 'stdio' ? (
              <>
                <TextField value={draft.command} onChange={(v) => setDraft({ ...draft, command: v })} placeholder="command (e.g. npx, uvx, python)" className="font-mono text-[11.5px]" />
                <TextField value={draft.args} onChange={(v) => setDraft({ ...draft, args: v })} placeholder="args, space-separated (e.g. -y @modelcontextprotocol/server-filesystem /data)" className="font-mono text-[11.5px]" />
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <TextField value={draft.cwd} onChange={(v) => setDraft({ ...draft, cwd: v })} placeholder="cwd (optional)" className="font-mono text-[11.5px]" />
                  <TextField value={draft.env} onChange={(v) => setDraft({ ...draft, env: v })} placeholder="env KEY=VALUE pairs (optional)" className="font-mono text-[11.5px]" />
                </div>
              </>
            ) : (
              <>
                <TextField value={draft.url} onChange={(v) => setDraft({ ...draft, url: v })} placeholder="https://host/mcp" className="font-mono text-[11.5px]" />
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <TextField value={draft.authorization} onChange={(v) => setDraft({ ...draft, authorization: v })} placeholder="authorization (optional)" className="font-mono text-[11.5px]" />
                  <TextField value={draft.headers} onChange={(v) => setDraft({ ...draft, headers: v })} placeholder="headers KEY=VALUE (optional)" className="font-mono text-[11.5px]" />
                </div>
              </>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" size="sm" onClick={add} disabled={busy}>
                {busy ? 'Connecting…' : 'Save & connect'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setOpen(false); setErr(''); }}>
                Cancel
              </Button>
              <p className="text-[11px] text-faint">Saved even if the first connection fails — it then shows an error status and can be restarted.</p>
            </div>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => { setOpen(true); setErr(''); }}>
            <Plus size={12} /> Add server
          </Button>
        )}
      </div>
    </SectionCard>
  );
}

export function SafetyTab() {
  const { safeMode, setSafeMode, sandbox, setSandbox, sandboxAvailable, sandboxKind, commitApproval, setCommitApproval } = useCoderSafety();
  const sandboxIsWindows = sandboxKind !== 'bwrap';
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

      <SectionCard
        title="Sandbox"
        icon={<Shield size={15} />}
        description={sandboxIsWindows
          ? 'Runs the agent shell at low integrity in a Job Object (workspace writable, host protected by Windows integrity policy).'
          : 'Wraps the agent shell in bwrap (workspace read-write, host read-only).'}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            {sandboxIsWindows ? (
              <p className="text-[12.5px] text-faint">
                Runs the agent shell at <strong>low integrity</strong> inside a Job Object — Windows itself refuses its writes to medium-integrity host files, the registry, and other processes; only the workspace is writable, and the whole process tree is killed on timeout. Note: files created outside the sandbox keep their medium label and can be read, not overwritten, until a sandbox run rewrites them.
              </p>
            ) : (
              <p className="text-[12.5px] text-faint">Wraps <code className="font-mono">bash</code> in <code className="font-mono">bwrap</code> — host filesystem is read-only, only the workspace is writable. Requires <code className="font-mono">bwrap</code> installed.</p>
            )}
            {sandbox && !sandboxAvailable && (
              <p className="text-[12.5px] text-warn">{sandboxIsWindows
                ? 'The Windows sandbox could not start on this host — the agent shell is running unsandboxed despite this being ON.'
                : 'bwrap isn&apos;t usable on this host (not installed, or the kernel refuses its namespaces) — the agent shell is running unsandboxed despite this being ON.'}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSandbox(!sandbox)}
            className={cn(
              'shrink-0 rounded px-2.5 py-1 text-[11px] font-medium',
              sandbox && sandboxAvailable ? 'bg-ok/20 text-ok' : sandbox ? 'bg-warn/20 text-warn' : 'bg-danger/20 text-danger',
            )}
            title={
              sandbox && sandboxAvailable
                ? sandboxIsWindows
                  ? 'Agent shell runs at low integrity in a Job Object (writes limited to the workspace)'
                  : 'Agent shell is wrapped in bwrap (writes limited to the workspace)'
                : sandbox
                  ? 'Sandbox is enabled but the mechanism is not usable on this host — the shell is actually running unsandboxed on the host'
                  : 'Agent shell runs directly on the host'
            }
          >
            {sandbox && sandboxAvailable ? 'ON' : sandbox ? 'ON · unavailable' : 'OFF'}
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Commit approval" icon={<GitCommit size={15} />} description="Gate: the agent cannot commit without human sign-off.">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-faint">When ON, the agent cannot commit until you review the working-tree-vs-HEAD diff and approve. Intentional commits via git_commit require human sign-off.</p>
          <ToggleRow on={commitApproval} onToggle={setCommitApproval} onTitle="Agent commits require your approval of the working-tree diff" offTitle="Agent may commit freely when goals/modules complete" />
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

      <McpServersCard perms={perms} onServerTier={setToolPerm} />

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
