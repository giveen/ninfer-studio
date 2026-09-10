import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Play, Square, X, BrainCircuit, Terminal, CheckSquare } from 'lucide-react';
import { CoderWorkspace, AgentToolCall, ChatMessage, ChatParams } from '../lib/types';
import { Button, CodeBlock, cn } from '../components/ui';
import { Workspaces } from '../components/Workspaces';
import { Markdown } from '../components/Markdown';
import { coderTree, coderRepoMap, coderRead, coderWrite, coderEdit, coderExec, coderGrep, coderGlob, coderWebFetch, coderWebSearch, streamChat, buildChatRequest, getConfig, setCoderWorkspace, getStatus, getEngineContextSize, summarizeConversation, frameCompactedSummary } from '../lib/api';
const CODER_SYSTEM = `You are an elite, autonomous software engineer with complete access to the user's workspace, file system, and the internet.
Your goal is to relentlessly drive the user's request to completion. Do not stop at planning—execute the plan, write the code, and prove it works.

# Core Directives
1. **Research First**: ALWAYS investigate before writing code. 
   - Use \`web_search\` and \`web_fetch\` to read the latest documentation, GitHub issues, or stackoverflow answers for any library or framework you are working with. Never guess APIs.
   - Use \`glob\`, \`grep\` (powered by blazing-fast ripgrep), \`ast_grep\` (for AST structural search), and \`read\` to understand the codebase's existing architecture and style.
2. **Best Practices**: Write clean, modular, and maintainable code. Match the existing project conventions perfectly.
3. **Verify Everything**: After editing, use \`bash\` to run compilers, linters, or test suites. If an error occurs, do not ask the user for help—use your tools to read the logs, search the web for the error, and fix it yourself.
4. **Track Progress**: Use \`todo_write\` to maintain a structured plan. Mark steps as \`in_progress\` while working, and \`completed\` when done. This helps you and the user stay aligned.
5. **Completion**: Only emit a final conversational response when the ENTIRE task is fully complete, tested, and verified.
`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "todo_write",
      description: "Record and update a structured task list for the current work. Send the ENTIRE list every call — it REPLACES the previous list. Use it to plan multi-step work and show progress.",
      parameters: {
        type: "object",
        properties: {
          todos: { 
            type: "array", 
            items: { 
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] }
              },
              required: ["content", "status"]
            } 
          }
        },
        required: ["todos"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Read file contents. For large files, use offset and limit to read in chunks.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Write content to a file, completely overwriting it or creating it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: "Edit a file using string replacement. Replaces the first exact match of 'old' with 'new'.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old: { type: "string" },
          new: { type: "string" },
          replaceAll: { type: "boolean" }
        },
        required: ["path", "old", "new"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeoutMs: { type: "number" }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search for a regex pattern in files.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          include: { type: "string", description: "Glob pattern to include (e.g. *.ts)" },
          ignoreCase: { type: "boolean" }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files matching a glob pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "ast_grep",
      description: "Search codebase using ast-grep (sg) for structural AST patterns. Useful for precise code search that ignores formatting.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "AST pattern (e.g. `function $A($$$ARGS) { $$$BODY }`)" },
          lang: { type: "string", description: "Language (e.g. ts, js, rust)" }
        },
        required: ["pattern", "lang"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch web content.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" }
        },
        required: ["query"]
      }
    }
  }
];

function ToolResultBlock({ name, content }: { name: string, content: string }) {
  try {
    const data = JSON.parse(content);
    
    if (name === 'bash') {
      return (
        <div className="rounded-md bg-[#1e1e1e] text-[#d4d4d4] font-mono text-[11px] overflow-hidden mt-1">
          <div className="bg-[#2d2d2d] px-2 py-1 flex justify-between items-center text-[#858585]">
            <span>Terminal {data.exitCode !== null ? `(exit ${data.exitCode})` : ''}</span>
            {data.timedOut && <span className="text-warn">Timeout</span>}
          </div>
          <div className="p-2 overflow-auto max-h-64 whitespace-pre">
            {data.stdout && <div>{data.stdout}</div>}
            {data.stderr && <div className="text-danger">{data.stderr}</div>}
            {!data.stdout && !data.stderr && <div className="text-faint italic">No output</div>}
          </div>
        </div>
      );
    }
    if (name === 'read') {
      return (
        <div className="mt-1">
           <CodeBlock code={data.content || ''} />
        </div>
      );
    }

    if (name === 'web_search') {
      return (
        <div className="mt-1 p-3 bg-panel border border-line rounded-lg flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-mute border-b border-line pb-1.5">
            <span>🔍</span> <span>Search Results for "{data.query}"</span>
          </div>
          <div className="space-y-3 max-h-64 overflow-auto pt-1">
            {data.results?.length === 0 && <div className="text-faint text-xs italic">No results found.</div>}
            {data.results?.map((r: any, i: number) => (
              <div key={i} className="flex flex-col gap-0.5">
                <a href={r.url} target="_blank" rel="noreferrer" className="text-[11px] text-accent hover:underline truncate">{r.url}</a>
                <div className="text-[12px] font-medium text-ink">{r.title}</div>
                <div className="text-[11px] text-mute line-clamp-2">{r.snippet}</div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    if (name === 'web_fetch') {
      return (
        <div className="mt-1 rounded-lg border border-line bg-panel overflow-hidden">
          <div className="bg-panel2 px-3 py-1.5 border-b border-line flex items-center gap-2">
            <span className="text-[10px] bg-inset border border-line rounded px-1.5 py-0.5 text-faint">GET</span>
            <span className="text-[11px] font-mono text-mute truncate flex-1">{data.url}</span>
            {data.status && <span className={cn("text-[10px] font-medium", data.status >= 400 ? 'text-danger' : 'text-ok')}>{data.status}</span>}
          </div>
          <div className="p-3 max-h-64 overflow-auto text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink bg-panel">
            {data.content || <span className="italic text-faint">No content extracted.</span>}
            {data.truncated && <div className="mt-2 text-warn italic border-t border-line pt-1 text-[10px]">Content truncated due to length limits.</div>}
          </div>
        </div>
      );
    }

    if (name === 'edit') {
      return (
        <div className="mt-1 p-2 bg-ok/10 border border-ok/30 rounded-md text-[11px] text-ok font-mono">
           Successfully applied edit.
        </div>
      );
    }
    
    if (name === 'grep' || name === 'glob') {
       return (
         <div className="mt-1 p-2 bg-inset border border-line rounded-md text-[11px] font-mono overflow-auto max-h-48 whitespace-pre">
           {JSON.stringify(data, null, 2)}
         </div>
       )
    }

  } catch {
    // fallback
  }
  return <div className="text-sm whitespace-pre-wrap">{content}</div>;
}

function TrajectoryBlock({ items }: { items: ChatMessage[] }) {
  const [open, setOpen] = useState(false);
  
  return (
    <div className="rounded-lg border border-line bg-panel2 overflow-hidden mb-4">
      <button 
        className="w-full p-2 flex items-center justify-between text-[11.5px] font-medium hover:bg-inset"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-2 text-mute">
          <BrainCircuit size={13} />
          <span>Agent thinking & working ({items.length} steps)</span>
        </div>
        <span className="text-faint">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="p-3 border-t border-line space-y-3 bg-panel">
          {items.map((m, i) => (
            <div key={i} className={cn("p-2 rounded border", m.role === 'tool' ? 'bg-inset border-transparent' : 'bg-panel border-accent/20')}>
              <div className="font-semibold text-[10px] text-faint mb-1 uppercase tracking-wider">{m.role === 'assistant' ? 'Garrulous' : m.role} {m.name ? `· ${m.name}` : ''}</div>
              {m.reasoning && (
                <div className="text-[11px] text-mute border-l-2 border-accent/50 pl-2 mb-2 italic whitespace-pre-wrap">{m.reasoning}</div>
              )}
              {m.content && m.role !== 'tool' && (
                m.role === 'assistant'
                  ? <div className="markdown text-[12px] leading-relaxed"><Markdown>{m.content}</Markdown></div>
                  : <div className="text-[12px] whitespace-pre-wrap">{m.content}</div>
              )}
              {m.role === 'tool' && m.content && (
                 <ToolResultBlock name={m.name!} content={m.content} />
              )}
              {m.tool_calls && (
                <div className="mt-2 space-y-1">
                  {m.tool_calls.map((tc, j) => (
                    <div key={j} className="text-[11px] font-mono text-accent bg-accent/10 p-1.5 rounded flex items-start gap-1">
                      <span className="mt-0.5">⚡</span> 
                      <span className="break-all">{tc.name}({tc.arguments})</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CoderScreen({ coderWs }: { coderWs: string }) {
  type LogEntry = { id: string; time: number; type: 'bash' | 'read' | 'write' | 'edit' | 'grep' | 'glob' | 'web' | 'todo' | 'error' | 'compact'; label: string; detail?: string; durationMs?: number };
  type TodoItem = { content: string; status: 'pending' | 'in_progress' | 'completed' };
  type CoderConv = { messages: ChatMessage[]; ledger: LogEntry[]; todos: TodoItem[]; lastPromptTokens: number };

  const WS_STORAGE_KEY = 'ninfier.coder.workspaces.v1';
  const CONV_KEY = 'ninfier.coder.conversations.v1';
  const EMPTY_CONV: CoderConv = { messages: [], ledger: [], todos: [], lastPromptTokens: 0 };

  // Every workspace keeps its own conversation (mirrors deepseek-harness's
  // Sessions-per-Workspace model), keyed by absolute workspace path.
  const [conversations, setConversations] = useState<Record<string, CoderConv>>(() => {
    try {
      const raw = localStorage.getItem(CONV_KEY);
      if (raw) return JSON.parse(raw) as Record<string, CoderConv>;
    } catch { /* ignore */ }
    return {};
  });
  const [activeWs, setActiveWs] = useState<string>(() => {
    try {
      const raw = localStorage.getItem(WS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { list?: string[]; active?: string };
        if (parsed.active) return parsed.active;
      }
    } catch { /* ignore */ }
    return coderWs;
  });
  const [workspaces, setWorkspaces] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(WS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { list?: string[]; active?: string };
        if (Array.isArray(parsed.list)) return parsed.list;
      }
    } catch { /* ignore */ }
    return coderWs ? [coderWs] : [];
  });

  // Live state for the active workspace's conversation.
  const [messages, setMessages] = useState<ChatMessage[]>(() => conversations[activeWs]?.messages ?? []);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [ledger, setLedger] = useState<LogEntry[]>(() => conversations[activeWs]?.ledger ?? []);
  const [todos, setTodos] = useState<TodoItem[]>(() => conversations[activeWs]?.todos ?? []);
  const [wsBusy, setWsBusy] = useState(false);

  // Tracks the latest turn's prompt-token count for the active workspace so we
  // can decide when to auto-compact (persisted alongside the conversation).
  const lastPromptTokensRef = useRef<number>(conversations[activeWs]?.lastPromptTokens ?? 0);

  // Persist the active workspace's conversation whenever it (or the active
  // workspace) changes.
  useEffect(() => {
    setConversations((c) => {
      const next = { ...c, [activeWs]: { messages, ledger, todos, lastPromptTokens: lastPromptTokensRef.current } };
      try { localStorage.setItem(CONV_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, [messages, ledger, todos, activeWs]);

  const loadConv = (ws: string) => {
    const c = conversations[ws] ?? EMPTY_CONV;
    lastPromptTokensRef.current = c.lastPromptTokens ?? 0;
    setMessages(c.messages);
    setLedger(c.ledger);
    setTodos(c.todos);
  };
  const persistWs = (list: string[], active: string) => {
    try { localStorage.setItem(WS_STORAGE_KEY, JSON.stringify({ list, active })); } catch { /* ignore */ }
  };
  const syncActiveWs = async (path: string) => {
    setWsBusy(true);
    try { await setCoderWorkspace(path); } catch (e) { console.warn('Failed to set coder workspace on sidecar:', e); }
    finally { setWsBusy(false); }
  };
  const handleSelectWorkspace = (path: string) => {
    if (path === activeWs) return;
    setActiveWs(path);
    loadConv(path);
    persistWs(workspaces, path);
    void syncActiveWs(path);
  };
  const handleAddWorkspace = (path: string) => {
    const next = workspaces.includes(path) ? workspaces : [...workspaces, path];
    setWorkspaces(next);
    setActiveWs(path);
    loadConv(path);
    persistWs(next, path);
    void syncActiveWs(path);
  };
  const handleRemoveWorkspace = (path: string) => {
    const next = workspaces.filter((w) => w !== path);
    setWorkspaces(next);
    setConversations((c) => {
      const copy = { ...c };
      delete copy[path];
      try { localStorage.setItem(CONV_KEY, JSON.stringify(copy)); } catch { /* ignore */ }
      return copy;
    });
    let nextActive = activeWs;
    if (activeWs === path) {
      nextActive = next[0] ?? '';
      setActiveWs(nextActive);
      loadConv(nextActive);
      void syncActiveWs(nextActive);
    }
    persistWs(next, nextActive);
  };
  const newChat = () => {
    setMessages([]);
    setLedger([]);
    setTodos([]);
    lastPromptTokensRef.current = 0;
  };

  const abortRef = useRef<AbortController | null>(null);

  const addLog = (entry: Omit<LogEntry, 'id' | 'time'>) => {
    setLedger(prev => [...prev.slice(-999), { ...entry, id: Math.random().toString(36).slice(2), time: Date.now() }]);
  };

  const handleToolCalls = async (calls: AgentToolCall[], currentMessages: ChatMessage[]) => {
    const nextMessages = [...currentMessages];
    
    for (const call of calls) {
      let result = '';
      const t0 = performance.now();
      let logType: LogEntry['type'] = 'error';
      let logDetail = '';
      
      try {
        const args = JSON.parse(call.arguments);
        if (call.name === 'bash') {
          logType = 'bash'; logDetail = args.command;
          const res = await coderExec(args.command, undefined, args.timeoutMs);
          result = JSON.stringify(res);
        } else if (call.name === 'read') {
          logType = 'read'; logDetail = args.path;
          const res = await coderRead(args.path, args.offset, args.limit);
          result = JSON.stringify(res);
        } else if (call.name === 'write') {
          logType = 'write'; logDetail = args.path;
          const res = await coderWrite(args.path, args.content);
          result = JSON.stringify(res);
          await coderExec(`git add "${args.path}" && git commit -m "Agent auto-commit: wrote ${args.path}"`, undefined, 10000);
          const cfg = await getConfig();
          if (cfg.buildCommand) {
            const check = await coderExec(cfg.buildCommand, undefined, 30000);
            if (check.exitCode !== 0) result = JSON.stringify({ ...res, linter_error: check.stderr || check.stdout });
          }
        } else if (call.name === 'edit') {
          logType = 'edit'; logDetail = args.path;
          const res = await coderEdit(args.path, args.old, args.new, args.replaceAll);
          result = JSON.stringify(res);
          if (res.replacements > 0) {
             await coderExec(`git add "${args.path}" && git commit -m "Agent auto-commit: edited ${args.path}"`, undefined, 10000);
             const cfg = await getConfig();
             if (cfg.buildCommand) {
               const check = await coderExec(cfg.buildCommand, undefined, 30000);
               if (check.exitCode !== 0) result = JSON.stringify({ ...res, linter_error: check.stderr || check.stdout });
             }
          }
        } else if (call.name === 'grep') {
          logType = 'grep'; logDetail = args.pattern;
          const res = await coderGrep(args.pattern, undefined, args.include, args.ignoreCase);
          result = JSON.stringify(res);
        } else if (call.name === 'glob') {
          logType = 'glob'; logDetail = args.pattern;
          const res = await coderGlob(args.pattern);
          result = JSON.stringify(res);
        } else if (call.name === 'ast_grep') {
          logType = 'grep'; logDetail = `[AST] ${args.pattern}`;
          const res = await coderExec(`sg -p '${args.pattern.replace(/'/g, "'\\''")}' -l ${args.lang}`, undefined, 15000);
          result = JSON.stringify(res);
        } else if (call.name === 'web_fetch') {
          logType = 'web'; logDetail = args.url;
          const res = await coderWebFetch(args.url);
          result = JSON.stringify(res);
        } else if (call.name === 'web_search') {
          logType = 'web'; logDetail = args.query;
          const res = await coderWebSearch(args.query);
          result = JSON.stringify(res);
        } else if (call.name === 'todo_write') {
          logType = 'todo'; logDetail = 'Updated task list';
          setTodos(args.todos || []);
          result = JSON.stringify({ success: true });
        } else {
          result = JSON.stringify({ error: 'Unknown tool' });
        }
      } catch (err: unknown) {
        logType = 'error';
        const msg = err instanceof Error ? err.message : String(err);
        logDetail = msg;
        result = JSON.stringify({ error: msg });
      }
      
      const durationMs = Math.round(performance.now() - t0);
      addLog({ type: logType, label: call.name, detail: logDetail, durationMs });
      
      nextMessages.push({
        role: 'tool',
        content: result,
        tool_call_id: call.id,
        name: call.name
      });
    }
    
    setMessages(nextMessages);
    return nextMessages;
  };
  const runAgent = async (initialMessages: ChatMessage[]) => {
    setRunning(true);
    let currentMessages = initialMessages;
    
    let dynamicSystem = CODER_SYSTEM;
    try {
      const rMap = await coderRepoMap();
      if (rMap && rMap.map) {
         dynamicSystem += `\n\n# Codebase Map (Auto-generated AST Signatures)\n\`\`\`\n${rMap.map}\n\`\`\`\n`;
      }
    } catch (e) {}

    abortRef.current = new AbortController();

    // Read the engine's context window so we can auto-compact once usage crosses
    // 80% of max. Prefer the engine's own /v1/models advertisement, falling back
    // to the sidecar-reported maxContext.
    let maxContext = 0;
    try {
      maxContext = (await getEngineContextSize('qwen-coder')) ?? 0;
    } catch { /* ignore */ }
    if (!maxContext) {
      try {
        const s = await getStatus();
        maxContext = s?.engine?.maxContext ?? 0;
      } catch { /* ignore */ }
    }
    const COMPACT_AT = 0.8;
    
    try {
      while (true) {
        if (abortRef.current?.signal.aborted) break;

        // Auto-compact: if the last turn already consumed >= 80% of the engine
        // context window, summarize the conversation into a checkpoint before
        // continuing so we never silently truncate mid-task.
        if (maxContext > 0 && lastPromptTokensRef.current >= COMPACT_AT * maxContext) {
          addLog({ type: 'compact', label: 'compact', detail: `context ${lastPromptTokensRef.current}/${maxContext} ≥ 80% — summarizing` });
          try {
            const summary = await summarizeConversation({
              model: 'qwen-coder',
              systemPrompt: dynamicSystem,
              history: currentMessages,
              maxTokens: 2048,
            });
            if (summary) {
              currentMessages = [{ role: 'user', content: frameCompactedSummary(summary) }];
              setMessages(currentMessages);
              lastPromptTokensRef.current = 0;
              continue;
            }
          } catch (e) {
            addLog({ type: 'error', label: 'compact', detail: e instanceof Error ? e.message : String(e) });
          }
        }
        
        let content = '';
        let reasoning = '';
        let toolCalls: AgentToolCall[] = [];
        
        const req = buildChatRequest('qwen-coder', dynamicSystem, currentMessages, { thinking: true, maxTokens: 8192 } as ChatParams, { tools: TOOLS });
        
        await streamChat(req, abortRef.current.signal, {
          onContentDelta: (text) => { content += text; },
          onReasoningDelta: (text) => { reasoning += text; },
          onToolCalls: (calls) => { toolCalls = calls; },
          onDone: (meta) => { if (meta?.promptTokens) lastPromptTokensRef.current = meta.promptTokens; },
        });
        
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content,
          reasoning: reasoning || undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined
        };
        
        currentMessages = [...currentMessages, assistantMsg];
        setMessages(currentMessages);
        
        if (toolCalls.length > 0) {
          currentMessages = await handleToolCalls(toolCalls, currentMessages);
        } else {
          break; // Done!
        }
      }
    } catch (err: unknown) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (!isAbort) {
        addLog({ type: 'error', label: 'System Error', detail: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const onSubmit = () => {
    if (!input.trim() || running) return;
    const msg: ChatMessage = { role: 'user', content: input.trim() };
    const next = [...messages, msg];
    setMessages(next);
    setInput('');
    runAgent(next);
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const messageGroups = useMemo(() => {
    const groups: { type: 'message' | 'trajectory', items: ChatMessage[] }[] = [];
    let currentTrajectory: ChatMessage[] = [];
    
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const isBackground = m.role === 'tool' || (m.role === 'assistant' && !!m.tool_calls?.length);
      
      if (isBackground) {
        currentTrajectory.push(m);
      } else {
        if (currentTrajectory.length > 0) {
          groups.push({ type: 'trajectory', items: currentTrajectory });
          currentTrajectory = [];
        }
        groups.push({ type: 'message', items: [m] });
      }
    }
    if (currentTrajectory.length > 0) {
      groups.push({ type: 'trajectory', items: currentTrajectory });
    }
    return groups;
  }, [messages]);

  return (
    <div className="flex h-full w-full">
      <div className="flex w-64 flex-col border-r border-line bg-panel">
        <div className="p-2 border-b border-line text-sm font-semibold flex items-center gap-2">
          <Terminal size={14} /> File Tree & Ledger
          <button
            className="ml-auto rounded border border-line px-2 py-0.5 text-[11px] font-normal text-mute hover:bg-panel2 hover:text-ink"
            title="Start a new chat in this workspace"
            onClick={newChat}
          >
            + chat
          </button>
        </div>
        <div className="flex-1 flex flex-col min-h-0">
          <Workspaces
            workspaces={workspaces}
            active={activeWs}
            onSelect={handleSelectWorkspace}
            onAdd={handleAddWorkspace}
            onRemove={handleRemoveWorkspace}
            busy={wsBusy}
          />
          <div className="flex-1 overflow-auto p-2">
            <div className="text-[11px] font-semibold text-faint mb-2 uppercase tracking-wider">Session Ledger</div>
            <div className="space-y-1.5">
              {ledger.map((l) => (
                <div key={l.id} className="flex flex-col gap-0.5 text-[10.5px] border-l-2 border-line pl-2 ml-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-faint">{new Date(l.time).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                    <span className={cn(
                      "font-semibold",
                      l.type === 'error' ? 'text-danger' : 
                      l.type === 'bash' ? 'text-[#e5c07b]' : 
                      l.type === 'compact' ? 'text-accent' : 
                      l.type === 'todo' ? 'text-ok' : 'text-accent'
                    )}>{l.label}</span>
                    {l.durationMs !== undefined && <span className="text-faint ml-auto">{l.durationMs}ms</span>}
                  </div>
                  {l.detail && <div className="text-mute truncate font-mono" title={l.detail}>{l.detail}</div>}
                </div>
              ))}
              {ledger.length === 0 && <div className="text-faint italic text-[11px]">No activity yet.</div>}
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-1 flex-col">
        <div className="flex-1 p-4 overflow-auto bg-panel2 space-y-4">
          {messageGroups.map((g, i) => (
            <React.Fragment key={i}>
              {g.type === 'trajectory' ? (
                <TrajectoryBlock items={g.items} />
              ) : (
                <div className={cn("p-3 rounded-lg border mb-4", g.items[0].role === 'user' ? 'bg-panel border-line' : 'bg-panel border-accent/30')}>
                  <div className="font-semibold text-xs text-faint mb-1">{g.items[0].role === 'assistant' ? 'Garrulous' : g.items[0].role}</div>
                  {g.items[0].content && (
                    g.items[0].role === 'assistant'
                      ? <div className="markdown text-[13.5px] leading-relaxed"><Markdown>{g.items[0].content}</Markdown></div>
                      : <div className="text-sm whitespace-pre-wrap">{g.items[0].content}</div>
                  )}
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
        <div className="p-3 bg-panel border-t border-line flex gap-2">
          <input 
            className="flex-1 bg-inset border border-line rounded px-3 py-1.5 text-sm outline-none focus:border-accent/50" 
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && onSubmit()}
            placeholder="Instruct the coder agent..."
            disabled={running}
          />
          {running ? (
             <Button variant="danger" onClick={stop}><Square size={14} /> Stop</Button>
          ) : (
             <Button variant="primary" onClick={onSubmit}><Play size={14} /> Run</Button>
          )}
        </div>
      </div>
      <div className="flex w-64 flex-col border-l border-line bg-panel">
        <div className="p-2 border-b border-line text-sm font-semibold flex items-center gap-2">
          <CheckSquare size={14} /> Todos
        </div>
        <div className="flex-1 p-2 text-[11.5px] text-mute overflow-auto">
          {todos.length === 0 ? 'No pending tasks.' : (
            <div className="space-y-1.5">
              {todos.map((t, i) => (
                <div key={i} className={cn("flex items-start gap-2", t.status === 'completed' ? 'opacity-50 line-through' : '')}>
                  <span className="mt-0.5 shrink-0">
                    {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '⏳' : '☐'}
                  </span>
                  <span className={t.status === 'in_progress' ? 'text-accent font-medium' : ''}>{t.content}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
