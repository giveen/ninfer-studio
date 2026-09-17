import { useRef } from 'react';
import type { ChatMessage, AgentToolCall } from '../lib/types';
import type { CoderMemory } from '../lib/api/coder';
import type { LogEntry, TodoItem, CoderStore, ConvMeta } from '../lib/coderStore';
import type { McpToolInfo } from '../lib/api';
import {
  coderExec,
  coderJob,
  coderRead,
  coderWrite,
  coderEdit,
  coderPatch,
  coderSearch,
  coderGrep,
  coderGlob,
  coderWebFetch,
  coderWebSearch,
  coderBrowser,
  coderDiff,
  coderMemoryAddLearning,
  mcpCall,
  coderPermsApprove,
} from '../lib/api';
import { GIT_BRANCH_LIST_CMD, parseBranchList } from '../lib/gitStatus';
import { readRecallChunk, maybeSummarizeTool } from '../lib/observationPack';
import {
  PURE_DEDUP_TOOLS,
  MUTATING_TOOLS,
  READ_STREAK_TOOLS,
  READONLY_TOOL_NAMES,
  WORKER_TOOL_NAMES,
  MCP_NAME_PREFIX,
  hashToolCall,
  withNote,
  detectRisky,
  isApprovedCommand,
  filterToolAllowList,
  type PermTier,
  type PermConfig,
} from '../lib/coderTools';

import { resolveProviderConfig } from '../lib/chatHelpers';
import type { CoderParams } from '../components/coder/CoderComposer';

export interface UseCoderToolDispatcherOptions {
  appConfig?: any;
  coderParams?: CoderParams;
  abortRef: React.RefObject<AbortController | null>;
  activeWsDir: string;
  activeWs: string;
  activeConv: string;
  perms: PermConfig;
  modelRef: React.RefObject<string>;
  toolDedupRef: React.RefObject<Array<{ hash: string; result: string }>>;
  readPathsRef: React.RefObject<Set<string>>;
  unreadWriteWarnedRef: React.RefObject<Set<string>>;
  patchFailuresRef: React.RefObject<Map<string, number>>;
  readStreakRef: React.RefObject<number>;
  askRef: React.RefObject<string | null>;
  askConvRef: React.RefObject<{ ws: string; convId: string } | null>;
  runConvRef: React.RefObject<{ ws: string; convId: string } | null>;
  todosRef: React.RefObject<TodoItem[]>;
  todosRevRef: React.RefObject<number>;
  todosRevAtReqStartRef: React.RefObject<number>;
  memoryRef: React.RefObject<CoderMemory>;
  mcpToolsRef: React.RefObject<McpToolInfo[]>;
  commitApproval: boolean;
  criticMode: boolean;
  jobs: {
    registerJob: (id: string, cmd: string, cwd: string) => void;
    settleJobStatus: (id: string, status: any) => void;
    registerSub: (sub: { id: string; label: string; task: string; ws: string }) => void;
    unregisterSub: (id: string) => void;
  };
  addLog: (log: { type: LogEntry['type']; label: string; detail?: string; durationMs?: number; provider?: 'cloud' | 'local' }) => void;
  createCheckpoint: (opts?: { auto?: boolean }) => Promise<any>;
  requestApproval: (name: string, detail: string) => Promise<boolean>;
  requestRiskyApproval: (cmd: string, reason: string, fromSubagent?: boolean) => Promise<'deny' | 'once' | 'remember'>;
  addApprovedCommand: (cmd: string) => void;
  requestCommitApproval: () => Promise<boolean>;
  setStore: React.Dispatch<React.SetStateAction<CoderStore>>;
  setPendingQuestion: (q: string | null) => void;
  updateRunTodos: (todos: TodoItem[], time: number) => void;
  flashTodosCreated: () => void;
  adoptMemory: (mem: any) => void;
  runPostEditChecks: (result: any, preview: string, signal?: AbortSignal) => Promise<any>;
  getFilePreview: (path: string, signal?: AbortSignal) => Promise<{ preview: string }>;
  trackPatchSpiral: (path: string, success: boolean) => string | null;
  checkPerm: (name: string, args: any) => string | null;
  runSubagent: (label: string, prompt: string, model: string, signal: AbortSignal, maxSteps?: number, allowedTools?: string[], depth?: number) => Promise<string>;
  runWorker: (label: string, prompt: string, model: string, signal: AbortSignal, maxSteps?: number, allowedTools?: string[], depth?: number) => Promise<{ summary: string; diff: string; ok: boolean }>;
  runIdeation: (task: string, model: string, signal: AbortSignal) => Promise<string>;
  runCritic: (diff: string, task: string, signal?: AbortSignal) => Promise<{ approved: boolean; issues: string; learnings: any[] }>;
  persistLearnings: (learnings: any[], provenance: string, task: string) => Promise<void>;
  isGitCommitCommand: (cmd: string) => boolean;
}

export function useCoderToolDispatcher(opts: UseCoderToolDispatcherOptions) {
  const handleToolCalls = async (
    calls: AgentToolCall[],
    currentMessages: ChatMessage[],
    onMutated?: () => void | Promise<void>
  ): Promise<ChatMessage[]> => {
    const nextMessages = [...currentMessages];
    let mutated = false;
    let autoCheckpointed = false;
    const toolSignal = opts.abortRef.current?.signal ?? new AbortController().signal;

    if (calls.length > 1 && calls.every((c) => c.name === 'delegate')) {
      const results = await Promise.all(
        calls.map(async (call) => {
          const t0 = performance.now();
          let result = '';
          let logType: LogEntry['type'] = 'error';
          let logDetail = '';
          try {
            const args = JSON.parse(call.arguments);
            const permVerdict = opts.checkPerm(call.name, args);
            if (permVerdict !== null) {
              logDetail = `${call.name} blocked`;
              result = JSON.stringify({
                error:
                  permVerdict === 'ask'
                    ? `'${call.name}' requires interactive approval and can't run inside a parallel batch — call it alone.`
                    : permVerdict,
              });
            } else {
              logType = 'ask';
              logDetail = `delegate: ${String(args.task ?? '').slice(0, 30)}`;
              const res = await opts.runSubagent(
                'delegate',
                `Task: ${args.task}\n\nYou are a read-only subagent. Investigate and reply with a concise summary. Do not write code.`,
                opts.modelRef.current,
                toolSignal,
                6,
                filterToolAllowList(args.tools, READONLY_TOOL_NAMES)
              );
              result = JSON.stringify({ summary: res });
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logDetail = msg;
            result = JSON.stringify({ error: msg });
          }
          const durationMs = Math.round(performance.now() - t0);
          opts.addLog({ type: logType, label: call.name, detail: logDetail, durationMs });
          const primaryConfig = resolveProviderConfig('primary', opts.appConfig ?? null, {
            primaryProvider: opts.coderParams?.primaryProvider,
            primaryCloudModel: opts.coderParams?.primaryCloudModel,
          });
          const maybeSummarized = await maybeSummarizeTool(
            call.name,
            result,
            opts.modelRef.current,
            opts.abortRef.current?.signal,
            primaryConfig
          );
          if (maybeSummarized !== result) {
            opts.addLog({ type: 'compact', label: call.name, detail: 'output AI-summarized (too large to pass through)' });
          }
          return { call, content: maybeSummarized };
        })
      );
      for (const { call, content } of results) {
        nextMessages.push({ role: 'tool', content, tool_call_id: call.id, name: call.name });
      }
      return nextMessages;
    }

    for (const call of calls) {
      let result = '';
      const t0 = performance.now();
      let logType: LogEntry['type'] = 'error';
      let logDetail = '';

      if (PURE_DEDUP_TOOLS.has(call.name)) {
        const hash = hashToolCall(call.name, call.arguments);
        const hit = opts.toolDedupRef.current.find((e) => e.hash === hash);
        if (hit) {
          logType = 'read';
          logDetail = `${call.name} (cached — identical call already executed this run)`;
          const durationMs = Math.round(performance.now() - t0);
          opts.addLog({ type: logType, label: call.name, detail: logDetail, durationMs });
          nextMessages.push({
            role: 'tool',
            content: withNote(hit.result, 'cached — identical call already executed this run'),
            tool_call_id: call.id,
            name: call.name,
          });
          continue;
        }
      }

      try {
        const args = JSON.parse(call.arguments);
        const permVerdict = opts.checkPerm(call.name, args);
        let approvedAfterAsk = false;
        let approvalToken: string | undefined;
        if (permVerdict !== null) {
          logType = 'error';
          logDetail = `${call.name} blocked`;
          if (permVerdict === 'ask') {
            const detail =
              call.name === 'bash'
                ? String(args.command ?? '')
                : call.name.startsWith(MCP_NAME_PREFIX)
                ? JSON.stringify(args).slice(0, 160)
                : String(args.path ?? args.files ?? args.pattern ?? args.query ?? args.url ?? '');
            opts.addLog({ type: 'ask', label: call.name, detail });
            const ok = await opts.requestApproval(call.name, detail);
            opts.addLog({
              type: ok ? 'bash' : 'error',
              label: call.name,
              detail: ok ? `approved: ${detail}` : `denied: ${detail}`,
            });
            if (!ok) {
              result = JSON.stringify({ error: `Denied by the user (${call.name}). Ask for an alternative or proceed without it.` });
            } else {
              approvedAfterAsk = true;
              try {
                approvalToken = (
                  await coderPermsApprove(call.name, typeof args.path === 'string' ? args.path : undefined, opts.activeWsDir)
                ).token;
              } catch {
                /* best-effort */
              }
            }
          } else {
            result = JSON.stringify({ error: permVerdict });
          }
        }
        if (result === '' && (permVerdict === null || approvedAfterAsk)) {
          if (!autoCheckpointed && MUTATING_TOOLS.has(call.name)) {
            autoCheckpointed = true;
            try {
              await opts.createCheckpoint({ auto: true });
            } catch {
              /* best-effort */
            }
          }
          if (call.name === 'bash') {
            logType = 'bash';
            logDetail = args.background ? `bg: ${args.command}` : args.command;
            const command0 = String(args.command || '');
            const riskyReason = detectRisky(command0);
            if (riskyReason && !isApprovedCommand(command0, opts.perms.approvedCommands || [])) {
              opts.addLog({ type: 'ask', label: 'bash', detail: `risky: ${command0}` });
              const v = await opts.requestRiskyApproval(command0, riskyReason);
              opts.addLog({
                type: v === 'deny' ? 'error' : 'bash',
                label: 'bash',
                detail: v === 'deny' ? `denied: ${command0}` : `approved (${v}): ${command0}`,
              });
              if (v === 'deny') {
                result = JSON.stringify({
                  error: `Risky command denied by the user: ${riskyReason}. Use a safer alternative or ask.`,
                });
              } else if (v === 'remember') {
                opts.addApprovedCommand(command0);
              }
            }
            if (result === '') {
              let commitBlocked = false;
              if (opts.commitApproval && opts.isGitCommitCommand(String(args.command || ''))) {
                opts.addLog({ type: 'ask', label: 'bash', detail: 'git commit — awaiting human review' });
                const ok = await opts.requestCommitApproval();
                opts.addLog({ type: ok ? 'bash' : 'error', label: 'bash', detail: ok ? 'approved' : 'denied by user' });
                if (!ok) commitBlocked = true;
              }
              if (commitBlocked) {
                result = JSON.stringify({
                  error:
                    'Commit denied by the user (commit approval gate is ON). Review the working-tree diff and adjust; the commit was not made.',
                });
              } else {
                const res = await coderExec(
                  args.command,
                  undefined,
                  args.timeoutMs,
                  opts.activeWsDir,
                  args.background === true,
                  toolSignal,
                  opts.activeWsDir,
                  approvalToken
                );
                result = JSON.stringify(res);
                if (args.background === true) mutated = true;
                if (res.jobId) {
                  opts.jobs.registerJob(res.jobId, String(args.command || ''), opts.activeWsDir);
                }
              }
            }
          } else if (call.name === 'bash_poll') {
            logType = 'bash';
            logDetail = `poll ${args.jobId}`;
            try {
              const res = await coderJob(String(args.jobId || ''), toolSignal);
              result = JSON.stringify(res);
              opts.jobs.settleJobStatus(res.jobId, res);
            } catch (e) {
              result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
            }
          } else if (call.name === 'obs_recall') {
            const id = String(args.id || '');
            const offset = Number(args.offset) || 0;
            logType = 'read';
            logDetail = `recall ${id} @${offset}`;
            result = JSON.stringify(await readRecallChunk(id, offset));
          } else if (call.name === 'read') {
            logType = 'read';
            logDetail = args.path;
            const res = await coderRead(args.path, args.offset, args.limit, toolSignal, opts.activeWsDir, approvalToken);
            result = JSON.stringify(res);
            opts.readPathsRef.current.add(String(args.path || ''));
          } else if (call.name === 'write') {
            logType = 'write';
            logDetail = args.path;
            const wpath = String(args.path || '');
            let blockedUnread = false;
            if (!opts.readPathsRef.current.has(wpath) && !opts.unreadWriteWarnedRef.current.has(wpath)) {
              const exists = await coderRead(wpath, 0, 1, toolSignal, opts.activeWsDir).then(
                () => true,
                (e: unknown) => !(e instanceof Error && /HTTP 404\b/.test(e.message))
              );
              if (exists) {
                opts.unreadWriteWarnedRef.current.add(wpath);
                result = JSON.stringify({
                  error: `${wpath} already exists and hasn't been read this run. Read it first with \`read\` so this write doesn't blindly overwrite content you haven't seen — or call \`write\` again on ${wpath} if you intend a deliberate full overwrite.`,
                });
                blockedUnread = true;
              }
            }
            if (!blockedUnread) {
              const res = await coderWrite(args.path, args.content, toolSignal, opts.activeWsDir, approvalToken);
              opts.readPathsRef.current.add(wpath);
              mutated = true;
              if (opts.commitApproval) {
                result = JSON.stringify(await opts.runPostEditChecks(res, '', toolSignal));
              } else {
                const { preview } = await opts.getFilePreview(args.path, toolSignal);
                result = JSON.stringify(await opts.runPostEditChecks(res, preview, toolSignal));
              }
            }
          } else if (call.name === 'edit') {
            logType = 'edit';
            logDetail = args.path;
            const epath = String(args.path || '');
            const res = await coderEdit(args.path, args.old, args.new, args.replaceAll, toolSignal, opts.activeWsDir, approvalToken);
            result = JSON.stringify(res);
            mutated = true;
            if (res.replacements > 0) {
              opts.readPathsRef.current.add(epath);
              if (opts.commitApproval) {
                result = JSON.stringify(await opts.runPostEditChecks(res, '', toolSignal));
              } else {
                const { preview } = await opts.getFilePreview(args.path, toolSignal);
                result = JSON.stringify(await opts.runPostEditChecks(res, preview, toolSignal));
              }
            }
            const editSpiralNote = opts.trackPatchSpiral(epath, res.replacements > 0);
            if (editSpiralNote) result = withNote(result, editSpiralNote);
          } else if (call.name === 'apply_patch') {
            logType = 'edit';
            logDetail = `${args.path} (${Array.isArray(args.edits) ? args.edits.length : 0} hunks)`;
            const ppath = String(args.path || '');
            const res = await coderPatch(args.path, Array.isArray(args.edits) ? args.edits : [], toolSignal, opts.activeWsDir, approvalToken);
            result = JSON.stringify(res);
            mutated = true;
            if (res.replacements > 0) {
              opts.readPathsRef.current.add(ppath);
              if (opts.commitApproval) {
                result = JSON.stringify(await opts.runPostEditChecks(res, '', toolSignal));
              } else {
                const { preview } = await opts.getFilePreview(args.path, toolSignal);
                result = JSON.stringify(await opts.runPostEditChecks(res, preview, toolSignal));
              }
            }
            const patchSpiralNote = opts.trackPatchSpiral(ppath, res.replacements > 0);
            if (patchSpiralNote) result = withNote(result, patchSpiralNote);
          } else if (call.name === 'git_branch') {
            const action = String(args.action || 'list');
            logType = 'bash';
            logDetail = `git branch ${action}${args.name ? ` ${args.name}` : ''}`;
            const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
            if (action === 'list') {
              const r = await coderExec(GIT_BRANCH_LIST_CMD, undefined, 15000, undefined, false, toolSignal, opts.activeWsDir);
              const { current, branches } = parseBranchList(r.stdout || '');
              result = JSON.stringify({ current, branches, ...r });
            } else if (action === 'create' || action === 'switch') {
              const name = String(args.name || '').trim();
              if (!name) {
                result = JSON.stringify({ error: `branch name required for action '${action}'` });
              } else if (!/^[A-Za-z0-9._\/-]+$/.test(name)) {
                result = JSON.stringify({ error: `invalid branch name: ${name}` });
              } else {
                const cmd = action === 'create' ? `git checkout -b ${q(name)}` : `git switch ${q(name)}`;
                const r = await coderExec(cmd, undefined, 30000, undefined, false, toolSignal, opts.activeWsDir);
                result = JSON.stringify(r);
                if (r.exitCode === 0) mutated = true;
              }
            } else {
              result = JSON.stringify({ error: `unknown action: ${action} (use list, create, or switch)` });
            }
          } else if (call.name === 'git_worktree') {
            const action = String(args.action || 'list');
            logType = 'bash';
            logDetail = `git worktree ${action}${args.path ? ` ${args.path}` : ''}`;
            const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
            if (action === 'list') {
              const r = await coderExec('git worktree list', undefined, 15000, undefined, false, toolSignal, opts.activeWsDir);
              const lines = (r.stdout || '').split('\n').map((s: string) => s.trim()).filter(Boolean);
              result = JSON.stringify({ worktrees: lines, ...r });
            } else if (action === 'add') {
              const p = String(args.path || '').trim();
              const b = String(args.branch || '').trim();
              if (!p || !b) {
                result = JSON.stringify({ error: "path and branch required for action 'add'" });
              } else if (!/^[A-Za-z0-9._\/-]+$/.test(b) || !/^\.\.\/[A-Za-z0-9._\/-]+$/.test(p)) {
                result = JSON.stringify({
                  error: "invalid branch or path (path must start with '../' to keep it out of the main worktree)",
                });
              } else {
                const cmd = `git worktree add -B ${q(b)} ${q(p)} ${q(b)} || git worktree add -b ${q(b)} ${q(p)}`;
                const r = await coderExec(cmd, undefined, 30000, undefined, false, toolSignal, opts.activeWsDir);
                result = JSON.stringify(r);
                if (r.exitCode === 0) {
                  opts.setStore((prev) => {
                    const wsd = prev.workspaces[opts.activeWs];
                    const meta = wsd?.conversations[opts.activeConv];
                    if (!wsd || !meta) return prev;
                    return {
                      ...prev,
                      workspaces: {
                        ...prev.workspaces,
                        [opts.activeWs]: {
                          ...wsd,
                          conversations: {
                            ...wsd.conversations,
                            [opts.activeConv]: { ...meta, worktree: p },
                          },
                        },
                      },
                    };
                  });
                  mutated = true;
                }
              }
            } else {
              result = JSON.stringify({ error: `unknown action: ${action} (use list or add)` });
            }
          } else if (call.name === 'git_pr') {
            logType = 'bash';
            logDetail = `git pr: ${String(args.title || '').slice(0, 40)}`;
            const q = (s: string) => `'${String(s).replace(/'/g, "'\\''")}'`;
            const gitRemoteToWeb = (url: string, base: string, head: string): string => {
              if (!url) return '';
              let host: string | undefined;
              let repo: string | undefined;
              const ssh = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
              if (ssh) {
                host = ssh[1];
                repo = ssh[2];
              } else {
                try {
                  const u = new URL(url);
                  host = u.host;
                  repo = u.pathname.replace(/^\//, '').replace(/\.git$/, '');
                } catch {
                  return '';
                }
              }
              return host && repo
                ? `https://${host}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
                : '';
            };
            const br = await coderExec('git rev-parse --abbrev-ref HEAD', undefined, 10000, undefined, false, toolSignal, opts.activeWsDir);
            const branch = (br.stdout || '').trim();
            if (!branch || branch === 'HEAD') {
              result = JSON.stringify({
                ok: false,
                error: 'Cannot open a PR from a detached HEAD. Create or check out a branch first.',
              });
            } else {
              const st = await coderExec('git status --porcelain', undefined, 10000, undefined, false, toolSignal, opts.activeWsDir);
              if ((st.stdout || '').trim()) {
                result = JSON.stringify({
                  ok: false,
                  error: 'Working tree is not clean — commit (or stash) your changes before opening a PR.',
                });
              } else {
                const rm = await coderExec('git remote', undefined, 10000, undefined, false, toolSignal, opts.activeWsDir);
                const remote = (rm.stdout || '').trim().split('\n')[0];
                if (!remote) {
                  result = JSON.stringify({
                    ok: false,
                    error: 'No git remote configured. Add one (git remote add origin <url>) before opening a PR.',
                  });
                } else {
                  const base =
                    String(args.base || '').trim() ||
                    (
                      await coderExec(
                        `git rev-parse --abbrev-ref ${q(remote)}/HEAD 2>/dev/null || true`,
                        undefined,
                        10000,
                        undefined,
                        false,
                        toolSignal,
                        opts.activeWsDir
                      )
                    ).stdout.trim() ||
                    'main';
                  const push = await coderExec(`git push -u ${q(remote)} ${q(branch)}`, undefined, 60000, undefined, false, toolSignal, opts.activeWsDir);
                  if (push.exitCode !== 0) {
                    result = JSON.stringify({ ok: false, error: 'push failed', stderr: push.stderr, stdout: push.stdout });
                  } else {
                    const gh = await coderExec('command -v gh >/dev/null 2>&1 && echo yes || echo no', undefined, 10000, undefined, false, toolSignal, opts.activeWsDir);
                    if ((gh.stdout || '').trim() === 'yes') {
                      let cmd = `gh pr create --title ${q(args.title)} --body ${q(args.body || '')}`;
                      if (base) cmd += ` --base ${q(base)}`;
                      const pr = await coderExec(cmd, undefined, 60000, undefined, false, toolSignal, opts.activeWsDir);
                      const url = (pr.stdout || '').match(/https?:\/\/\S+/)?.[0] || '';
                      result = JSON.stringify({ ok: pr.exitCode === 0, url, stdout: pr.stdout, stderr: pr.stderr });
                    } else {
                      const urlOut = await coderExec(`git remote get-url ${q(remote)}`, undefined, 10000, undefined, false, toolSignal, opts.activeWsDir);
                      const compare = gitRemoteToWeb((urlOut.stdout || '').trim(), base, branch);
                      result = JSON.stringify({
                        ok: true,
                        pushed: true,
                        remote,
                        branch,
                        base,
                        compareUrl: compare,
                        note: 'gh CLI not found — open the PR manually at the compare URL (or install gh).',
                      });
                    }
                  }
                }
              }
            }
          } else if (call.name === 'repo_search') {
            logType = 'read';
            logDetail = `search: ${String(args.query ?? '').slice(0, 30)}`;
            const sr = await coderSearch(String(args.query || ''), typeof args.limit === 'number' ? args.limit : 15, toolSignal, opts.activeWsDir);
            result = JSON.stringify(sr);
          } else if (call.name === 'grep') {
            logType = 'grep';
            logDetail = args.pattern;
            const res = await coderGrep(args.pattern, undefined, args.include, args.ignoreCase, args.offset || 0, args.limit || 200, toolSignal, opts.activeWsDir, approvalToken);
            result = JSON.stringify(res);
          } else if (call.name === 'glob') {
            logType = 'glob';
            logDetail = args.pattern;
            const res = await coderGlob(args.pattern, undefined, args.offset || 0, args.limit || 200, toolSignal, opts.activeWsDir, approvalToken);
            result = JSON.stringify(res);
          } else if (call.name === 'ast_grep') {
            logType = 'grep';
            logDetail = `[AST] ${args.pattern}`;
            const res = await coderExec(`sg -p '${args.pattern.replace(/'/g, "'\\''")}' -l ${args.lang}`, undefined, 15000, undefined, false, toolSignal, opts.activeWsDir);
            result = JSON.stringify(res);
          } else if (call.name === 'web_fetch') {
            logType = 'web';
            logDetail = args.url;
            const res = await coderWebFetch(args.url, toolSignal, approvalToken);
            result = JSON.stringify(res);
          } else if (call.name === 'web_search') {
            logType = 'web';
            logDetail = args.query;
            const res = await coderWebSearch(args.query, toolSignal, approvalToken);
            result = JSON.stringify(res);
          } else if (call.name === 'browser') {
            logType = 'web';
            logDetail = `browser ${String(args.action ?? '')}${args.url ? ` ${args.url}` : ''}`;
            const bargs: Record<string, string | number> = {};
            for (const k of ['url', 'selector', 'value', 'key', 'expression', 'wait_until']) {
              if (typeof args[k] === 'string') bargs[k] = String(args[k]);
            }
            if (typeof args.timeout === 'number') bargs.timeout = args.timeout;
            result = JSON.stringify(await coderBrowser(String(args.action ?? 'status'), bargs, toolSignal, approvalToken));
          } else if (call.name === 'git_commit') {
            logType = 'bash';
            logDetail = `git commit ${args.files}`;
            let proceed = true;
            if (opts.commitApproval) {
              opts.addLog({ type: 'ask', label: 'git_commit', detail: 'awaiting human review' });
              proceed = await opts.requestCommitApproval();
              opts.addLog({ type: proceed ? 'bash' : 'error', label: 'git_commit', detail: proceed ? 'approved' : 'denied by user' });
            }
            if (!proceed) {
              result = JSON.stringify({
                error:
                  'Commit denied by the user (commit approval gate is ON). Review the working-tree diff (Diff button) and adjust your changes; the commit was not made.',
              });
              continue;
            }
            const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
            const fileTokens = args.files && String(args.files).trim() ? String(args.files).trim().split(/\s+/) : ['-A'];
            const fileArgs = fileTokens.map((t) => (t.startsWith('-') ? t : q(t))).join(' ');
            const message = args.message || 'Agent commit';
            const commitRes = await coderExec(
              `git add ${fileArgs} && git commit -m ${q(message)} && git rev-parse HEAD`,
              undefined,
              30000,
              undefined,
              false,
              toolSignal,
              opts.activeWsDir
            );
            result = JSON.stringify(commitRes);
          } else if (call.name === 'git_diff') {
            logType = 'bash';
            logDetail = `git diff ${args.ref || ''}`.trim();
            const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
            const ref = (args.ref || '').trim();
            const pathTokens = (args.path || '').trim().split(/\s+/).filter(Boolean);
            const refArg = ref ? q(ref) : '';
            const pathArg = pathTokens.map(q).join(' ');
            const cmd = `git --no-pager diff ${refArg} ${pathArg}`.replace(/\s+/g, ' ').trim();
            const diffRes = await coderExec(cmd, undefined, 30000, undefined, false, toolSignal, opts.activeWsDir);
            result = JSON.stringify(diffRes);
          } else if (call.name === 'ask_user') {
            logType = 'ask';
            logDetail = args.question || '(no question)';
            opts.askRef.current = String(args.question || '');
            result = JSON.stringify({ question: args.question, status: 'awaiting_user' });
          } else if (call.name === 'todo_write') {
            logType = 'todo';
            logDetail = 'Updated task list';
            const raw: unknown = Array.isArray(args.todos) ? args.todos : [];
            const cleaned: TodoItem[] = [];
            for (const t of raw as Array<Record<string, unknown>>) {
              const content = t && typeof t.content === 'string' ? t.content.trim() : '';
              if (!content) continue;
              cleaned.push({
                content,
                status: t.status === 'in_progress' ? 'in_progress' : t.status === 'completed' ? 'completed' : 'pending',
              });
            }
            if (opts.todosRevRef.current > opts.todosRevAtReqStartRef.current) {
              logDetail = 'Task list update discarded (edited mid-run)';
              opts.addLog({ type: 'todo', label: 'todo_write', detail: 'discarded: list edited by the user mid-run' });
              result = JSON.stringify({
                success: false,
                reason:
                  'the task list was edited by the user while this response was being generated, so this update was not applied. The current list is in your system prompt — re-emit todo_write with the full intended list if your plan is still correct.',
              });
            } else {
              const wasEmpty = opts.todosRef.current.length === 0;
              opts.todosRef.current = cleaned;
              opts.updateRunTodos(cleaned, Date.now());
              if (wasEmpty && cleaned.length > 0) opts.flashTodosCreated();
              result = JSON.stringify({ success: true, count: cleaned.length });
            }
          } else if (call.name === 'delegate') {
            logType = 'ask';
            logDetail = `delegate: ${String(args.task ?? '').slice(0, 30)}`;
            const res = await opts.runSubagent(
              `delegate`,
              `Task: ${args.task}\n\nYou are a read-only subagent. Investigate and reply with a concise summary. Do not write code.`,
              opts.modelRef.current,
              toolSignal,
              6,
              filterToolAllowList(args.tools, READONLY_TOOL_NAMES)
            );
            result = JSON.stringify({ summary: res });
          } else if (call.name === 'subagent') {
            logType = 'bash';
            const task = String(args.task || '');
            logDetail = `subagent: ${task.slice(0, 40)}`;
            opts.addLog({ type: 'bash', label: 'subagent', detail: `spawning worker (${task.slice(0, 60)})` });
            const wmodel = (args.model && String(args.model).trim()) || opts.modelRef.current;
            const workerTools = filterToolAllowList(args.tools, WORKER_TOOL_NAMES);
            const subId = `subagent-${crypto.randomUUID().slice(0, 8)}`;
            opts.jobs.registerSub({ id: subId, label: 'subagent', task: task.slice(0, 100), ws: opts.activeWsDir });
            try {
              let preTree = '';
              try {
                preTree = (await coderExec('git write-tree', undefined, 10000, undefined, false, toolSignal, opts.activeWsDir)).stdout.trim();
              } catch {
                /* no git */
              }
              const ideation = await opts.runIdeation(task, wmodel, toolSignal);
              opts.addLog({
                type: 'read',
                label: 'subagent',
                detail: ideation ? `ideation: ${ideation.slice(0, 150)}` : 'ideation pass produced no candidates',
              });
              let res = { summary: '', diff: '', ok: false };
              let critique = '';
              let prevCritique = '';
              let criticApproved: boolean | null = null;
              const MAX_WORKER_CRIT = 2;
              for (let attempt = 0; attempt <= MAX_WORKER_CRIT; attempt++) {
                const p =
                  attempt === 0
                    ? `TASK (implement now):\n${task}${ideation ? `\n\nCandidate approaches to consider (from an ideation pass -- pick one, don't just list them):\n${ideation}` : ''}`
                    : `TASK (revise your previous implementation):\n${task}\n\nA code reviewer rejected your previous attempt with these issues — fix them:\n${critique}`;
                res = await opts.runWorker('subagent', p, wmodel, toolSignal, 12, workerTools);
                if (opts.criticMode && res.diff.trim()) {
                  const c = await opts.runCritic(res.diff, task, toolSignal);
                  criticApproved = c.approved;
                  if (c.learnings.length) {
                    await opts.persistLearnings(c.learnings, c.approved ? 'critic:approve' : 'critic:reject', task);
                  }
                  if (!c.approved) {
                    if (attempt > 0 && c.issues.trim() && c.issues.trim().toLowerCase() === prevCritique.trim().toLowerCase()) {
                      critique = c.issues;
                      opts.addLog({
                        type: 'error',
                        label: 'critic',
                        detail: 'same issues raised again — worker not converging, stopping retries early',
                      });
                      break;
                    }
                    prevCritique = critique = c.issues;
                    opts.addLog({
                      type: 'error',
                      label: 'critic',
                      detail: `subagent changes rejected (${attempt + 1}/${MAX_WORKER_CRIT}) — re-running worker`,
                    });
                    continue;
                  }
                }
                break;
              }
              let diff = res.diff;
              try {
                const postTree = (await coderExec('git write-tree', undefined, 10000, undefined, false, toolSignal, opts.activeWsDir)).stdout.trim();
                if (preTree && postTree && preTree !== postTree) {
                  const d = await coderExec(`git --no-pager diff ${preTree} ${postTree}`, undefined, 60000, undefined, false, toolSignal, opts.activeWsDir);
                  diff = (d.stdout || '').slice(0, 60000);
                }
              } catch {
                /* keep res.diff */
              }
              mutated = true;
              const ok = res.ok && criticApproved !== false;
              result = JSON.stringify({ summary: res.summary, diff, ok, criticApproved });
              opts.addLog({ type: ok ? 'bash' : 'error', label: 'subagent', detail: `done: ${res.summary.slice(0, 60)}` });
            } finally {
              opts.jobs.unregisterSub(subId);
            }
          } else if (call.name === 'memory_update') {
            logType = 'todo';
            const text = String(args.text || '').trim();
            const rawKind = String(args.kind || 'tip');
            const kind = rawKind === 'success' || rawKind === 'avoid' ? rawKind : 'tip';
            logDetail = `memory: ${kind} — ${text.slice(0, 40)}`;
            opts.addLog({ type: 'todo', label: 'memory', detail: `recording ${kind} learning` });
            if (!text) {
              result = JSON.stringify({ error: 'memory_update requires non-empty `text`.' });
            } else {
              try {
                const m = await coderMemoryAddLearning({ text, kind, provenance: 'tool' }, toolSignal);
                opts.adoptMemory(m);
                result = JSON.stringify({ ok: true, kind, learnings: m.learnings.length });
              } catch (e) {
                result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
              }
            }
          } else if (call.name === 'memory_recall') {
            logType = 'read';
            const query = String(args.query || '').trim();
            const kindFilter = String(args.kind || '').trim();
            const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
            logDetail = `memory_recall: "${query.slice(0, 40)}"`;
            if (!query) {
              result = JSON.stringify({ error: 'memory_recall requires non-empty `query`.' });
            } else {
              const q = query.toLowerCase();
              const all = opts.memoryRef.current?.learnings ?? [];
              const filtered = all.filter(
                (l: any) =>
                  (!kindFilter || l.kind === kindFilter) &&
                  (l.text.toLowerCase().includes(q) || (l.task ?? '').toLowerCase().includes(q))
              );
              const learnings = filtered.slice(-limit).reverse();
              result = JSON.stringify({ query, matched: filtered.length, returned: learnings.length, learnings });
            }
          } else if (call.name.startsWith(MCP_NAME_PREFIX)) {
            logType = 'bash';
            logDetail = call.name;
            const res = await mcpCall(
              { name: call.name, arguments: args, scope: opts.activeWsDir, approvalToken },
              toolSignal
            );
            result = res.ok ? res.output : JSON.stringify({ error: res.output });
          } else {
            result = JSON.stringify({ error: 'Unknown tool' });
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logDetail = msg;
        result = JSON.stringify({ error: msg });
      }

      if (READ_STREAK_TOOLS.has(call.name)) {
        opts.readStreakRef.current += 1;
        if (opts.readStreakRef.current === 8) {
          result = withNote(
            result,
            `You have used read-only tools ${opts.readStreakRef.current} times in a row without writing or running anything. If you have enough context, stop investigating and produce your output (edit, write, or a final answer) now.`
          );
          opts.readStreakRef.current = 0;
        }
      } else {
        opts.readStreakRef.current = 0;
      }

      const durationMs = Math.round(performance.now() - t0);
      opts.addLog({ type: logType, label: call.name, detail: logDetail, durationMs });

      const primaryConfig = resolveProviderConfig('primary', opts.appConfig ?? null, {
        primaryProvider: opts.coderParams?.primaryProvider,
        primaryCloudModel: opts.coderParams?.primaryCloudModel,
      });
      const maybeSummarized = await maybeSummarizeTool(
        call.name,
        result,
        opts.modelRef.current,
        opts.abortRef.current?.signal,
        primaryConfig
      );
      if (maybeSummarized !== result) {
        opts.addLog({ type: 'compact', label: call.name, detail: 'output AI-summarized (too large to pass through)' });
      }

      if (PURE_DEDUP_TOOLS.has(call.name)) {
        const hash = hashToolCall(call.name, call.arguments);
        opts.toolDedupRef.current.push({ hash, result: maybeSummarized });
        if (opts.toolDedupRef.current.length > 30) opts.toolDedupRef.current.shift();
      }

      nextMessages.push({ role: 'tool', content: maybeSummarized, tool_call_id: call.id, name: call.name });
    }

    if (mutated && onMutated) {
      try {
        await onMutated();
      } catch {
        /* best-effort */
      }
    }

    return nextMessages;
  };

  return { handleToolCalls };
}
