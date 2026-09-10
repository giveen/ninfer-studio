import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Play, Square, X, BrainCircuit, Terminal, CheckSquare, Plus, Folder, ChevronRight, ChevronDown, FolderPlus, Pencil, Archive, Trash2, RotateCcw, File, Paperclip, Image, GitCommit, RefreshCw } from 'lucide-react';
import { CoderWorkspace, AgentToolCall, ChatMessage, ChatParams, ChatAttachment, FileNode } from '../lib/types';
import { Button, CodeBlock, cn } from '../components/ui';
import { DirBrowser } from '../components/DirBrowser';
import { Markdown } from '../components/Markdown';
import { coderTree, coderRepoMap, coderRead, coderReadBase64, coderWrite, coderEdit, coderExec, coderGrep, coderGlob, coderWebFetch, coderWebSearch, coderGitLog, streamChat, buildChatRequest, getConfig, setCoderWorkspace, getStatus, getEngineContextSize, summarizeConversation, frameCompactedSummary, type CoderCommit } from '../lib/api';

const ATTACH_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
const isImagePath = (p: string) => IMAGE_EXT.has((p.split('.').pop() || '').toLowerCase());
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
6. **Context is managed for you**: this harness automatically compacts the conversation when it nears the model's context limit, replacing earlier turns with a concise summary checkpoint. You do NOT need to summarize manually — keep working normally and rely on the checkpoint to preserve prior context.
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

/* ------------------------------------------------------------------ *
 * Multi-conversation-per-workspace model.
 *
 * Each workspace is a collapsible "folder" (mirrors deepseek-harness's
 * Sessions-per-Workspace tree) that holds an ordered list of independent
 * conversations. Selecting a workspace expands it; clicking a conversation
 * row loads that conversation's messages, ledger, and todos, so you can
 * hop between threads and come back to them later.
 * ------------------------------------------------------------------ */

type LogEntry = { id: string; time: number; type: 'bash' | 'read' | 'write' | 'edit' | 'grep' | 'glob' | 'web' | 'todo' | 'error' | 'compact'; label: string; detail?: string; durationMs?: number };
type TodoItem = { content: string; status: 'pending' | 'in_progress' | 'completed' };

interface ConvMeta {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
  ledger: LogEntry[];
  todos: TodoItem[];
  lastPromptTokens: number;
  archived?: boolean;
}
interface WsData {
  expanded: boolean;
  conversations: Record<string, ConvMeta>;
  order: string[];
  activeConv?: string;
}
interface CoderStore {
  activeWs: string;
  activeConv: string;
  workspaces: Record<string, WsData>;
}

const CONV_KEY = 'ninfier.coder.conversations.v2';
const CONV_V1_KEY = 'ninfier.coder.conversations.v1';

function newConvId(): string {
  return 'conv-' + Math.random().toString(36).slice(2, 10);
}
function emptyConv(id: string): ConvMeta {
  return { id, title: 'New conversation', updatedAt: Date.now(), messages: [], ledger: [], todos: [], lastPromptTokens: 0 };
}
function baseName(p: string): string {
  const t = p.replace(/[/\\]+$/, '');
  const parts = t.split(/[/\\]/);
  return parts[parts.length - 1] || t || p || '(root)';
}
function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
  if (diff < MIN) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}d`;
  if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))}mo`;
  return `${Math.floor(diff / (365 * DAY))}y`;
}
/** A compaction checkpoint message (the engine-side <compacted-summary> block). */
function isCompactedMsg(m: ChatMessage): boolean {
  return m.role === 'user' && typeof m.content === 'string' && m.content.includes('<compacted-summary>');
}
/** Model context for a loaded transcript: from the most recent compaction
 *  checkpoint onward, so reloading a conversation never re-inflates the full
 *  context. */
function compactedContext(msgs: ChatMessage[]): ChatMessage[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (isCompactedMsg(msgs[i])) return msgs.slice(i);
  }
  return msgs;
}
function normalizeStore(s: CoderStore): CoderStore {
  const workspaces = { ...s.workspaces };
  let activeWs = s.activeWs;
  let activeConv = s.activeConv;
  if (!activeWs || !workspaces[activeWs]) {
    activeWs = Object.keys(workspaces)[0] ?? '';
    activeConv = activeWs ? (workspaces[activeWs].activeConv ?? workspaces[activeWs].order[0] ?? '') : '';
  } else {
    const wsd = workspaces[activeWs];
    activeConv = wsd.activeConv ?? wsd.order[0] ?? '';
    if (activeConv && !wsd.conversations[activeConv]) activeConv = wsd.order[0] ?? '';
  }
  return { activeWs, activeConv, workspaces };
}
function loadStore(): CoderStore {
  try {
    const raw = localStorage.getItem(CONV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CoderStore;
      if (parsed && parsed.workspaces) return normalizeStore(parsed);
    }
  } catch { /* ignore */ }
  // Migrate the previous single-conversation-per-workspace format.
  try {
    const raw = localStorage.getItem(CONV_V1_KEY);
    if (raw) {
      const v1 = JSON.parse(raw) as Record<string, { messages: ChatMessage[]; ledger: LogEntry[]; todos: TodoItem[]; lastPromptTokens: number }>;
      const workspaces: Record<string, WsData> = {};
      for (const [ws, conv] of Object.entries(v1)) {
        const id = newConvId();
        workspaces[ws] = {
          expanded: true,
          conversations: { [id]: { id, title: 'Conversation', updatedAt: Date.now(), messages: conv.messages || [], ledger: conv.ledger || [], todos: conv.todos || [], lastPromptTokens: conv.lastPromptTokens || 0 } },
          order: [id],
          activeConv: id,
        };
      }
      const first = Object.keys(workspaces)[0] ?? '';
      const activeConv = first ? workspaces[first].activeConv! : '';
      return { activeWs: first, activeConv, workspaces };
    }
  } catch { /* ignore */ }
  return { activeWs: '', activeConv: '', workspaces: {} };
}

export function CoderScreen({ coderWs }: { coderWs: string }) {
  const [store, setStore] = useState<CoderStore>(loadStore);
  const storeRef = useRef(store);
  storeRef.current = store;

  const activeWs = store.activeWs;
  const activeConv = store.activeConv;

  const initialMeta = store.workspaces[activeWs]?.conversations[activeConv];
  const [messages, setMessages] = useState<ChatMessage[]>(initialMeta?.messages ?? []);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [ledger, setLedger] = useState<LogEntry[]>(initialMeta?.ledger ?? []);
  const [todos, setTodos] = useState<TodoItem[]>(initialMeta?.todos ?? []);
  const [wsBusy, setWsBusy] = useState(false);
  const [showDir, setShowDir] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerNodes, setPickerNodes] = useState<FileNode[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerExpanded, setPickerExpanded] = useState<Record<string, boolean>>({});
  const [pickerSelected, setPickerSelected] = useState<Record<string, boolean>>({});
  const [editingConv, setEditingConv] = useState<{ ws: string; cid: string } | null>(null);
  const [archivedOpen, setArchivedOpen] = useState<Record<string, boolean>>({});

  // Commit history of the active workspace (populated from `git log`).
  const [commits, setCommits] = useState<CoderCommit[]>([]);
  const [commitsOpen, setCommitsOpen] = useState(true);
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [commitsLoading, setCommitsLoading] = useState(false);

  const loadCommits = useCallback(async () => {
    setCommitsLoading(true);
    try {
      setCommits(await coderGitLog(100));
    } catch {
      setCommits([]);
    } finally {
      setCommitsLoading(false);
    }
  }, []);

  // Refresh the commit history whenever the active workspace changes.
  useEffect(() => {
    if (activeWs) loadCommits();
  }, [activeWs, loadCommits]);

  const lastPromptTokensRef = useRef<number>(initialMeta?.lastPromptTokens ?? 0);
  // The system prompt (CODER_SYSTEM + live repo map). Kept in a ref so it can be
  // refreshed mid-run after the agent writes/edits files (P1 #6).
  const dynamicSystemRef = useRef<string>(CODER_SYSTEM);

  /** Load a conversation's live state from the store (always reads the latest). */
  const loadConv = (ws: string, convId: string) => {
    const meta = storeRef.current.workspaces[ws]?.conversations[convId];
    const m = meta ?? emptyConv(convId);
    lastPromptTokensRef.current = m.lastPromptTokens ?? 0;
    const msgs = m.messages ?? [];
    setMessages(msgs);
    setLedger(m.ledger ?? []);
    setTodos(m.todos ?? []);
  };

  // Persist the active conversation's live state back into the store.
  useEffect(() => {
    if (!activeWs || !activeConv) return;
    setStore((prev) => {
      const wsd = prev.workspaces[activeWs];
      if (!wsd) return prev;
      const meta = wsd.conversations[activeConv];
      const firstUser = messages.find((m) => m.role === 'user' && !isCompactedMsg(m));
      const title = firstUser
        ? firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 48) || (meta?.title ?? 'New conversation')
        : (meta?.title ?? 'New conversation');
      const updated: ConvMeta = { id: activeConv, title, updatedAt: Date.now(), messages, ledger, todos, lastPromptTokens: lastPromptTokensRef.current };
      const order = wsd.order.includes(activeConv) ? wsd.order : [...wsd.order, activeConv];
      return {
        ...prev,
        workspaces: { ...prev.workspaces, [activeWs]: { ...wsd, conversations: { ...wsd.conversations, [activeConv]: updated }, order } },
      };
    });
  }, [messages, ledger, todos, activeWs, activeConv]);

  // Keep the sidecar's coder workspace pointed at the active workspace.
  useEffect(() => {
    if (!activeWs) return;
    let cancelled = false;
    setWsBusy(true);
    setCoderWorkspace(activeWs)
      .catch((e) => console.warn('Failed to set coder workspace on sidecar:', e))
      .finally(() => { if (!cancelled) setWsBusy(false); });
    return () => { cancelled = true; };
  }, [activeWs]);

  // Seed the default workspace from the sidecar once its path is known.
  const seeded = useRef(false);
  useEffect(() => {
    if (!coderWs || seeded.current) return;
    seeded.current = true;
    setStore((prev) => {
      if (prev.workspaces[coderWs]) return prev;
      const id = newConvId();
      const ws: WsData = { expanded: true, conversations: { [id]: emptyConv(id) }, order: [id], activeConv: id };
      return { ...prev, activeWs: coderWs, activeConv: id, workspaces: { ...prev.workspaces, [coderWs]: ws } };
    });
    setMessages([]);
    setLedger([]);
    setTodos([]);
    lastPromptTokensRef.current = 0;
  }, [coderWs]);

  /** Create a fresh conversation inside a workspace and make it active. */
  const newChat = (ws: string = activeWs) => {
    if (running) return; // don't start a new conversation mid-run (P0 #2)
    if (!ws) return;
    const id = newConvId();
    setStore((prev) => {
      const wsd = prev.workspaces[ws] ?? { expanded: true, conversations: {}, order: [], activeConv: undefined };
      return {
        ...prev,
        activeWs: ws,
        activeConv: id,
        workspaces: { ...prev.workspaces, [ws]: { ...wsd, conversations: { ...wsd.conversations, [id]: emptyConv(id) }, order: [...wsd.order, id], activeConv: id } },
      };
    });
    setMessages([]);
    setLedger([]);
    setTodos([]);
    lastPromptTokensRef.current = 0;
  };

  const handleSelectConv = (ws: string, convId: string) => {
    if (running) return; // don't switch conversations mid-run (P0 #2: avoids corrupting the in-flight transcript)
    if (ws === activeWs && convId === activeConv) return;
    setStore((prev) => ({ ...prev, activeWs: ws, activeConv: convId }));
    loadConv(ws, convId);
  };
  const handleSelectWorkspace = (ws: string) => {
    const wsd = storeRef.current.workspaces[ws];
    const cid = wsd?.activeConv ?? wsd?.order[0] ?? '';
    handleSelectConv(ws, cid);
  };
  const handleToggleExpand = (ws: string) => {
    setStore((prev) => {
      const wsd = prev.workspaces[ws];
      if (!wsd) return prev;
      return { ...prev, workspaces: { ...prev.workspaces, [ws]: { ...wsd, expanded: !wsd.expanded } } };
    });
  };
  const handleAddWorkspace = (path: string) => {
    const existing = storeRef.current.workspaces[path];
    setStore((prev) => {
      if (existing) return { ...prev, activeWs: path, activeConv: existing.activeConv ?? existing.order[0] ?? '' };
      const id = newConvId();
      const ws: WsData = { expanded: true, conversations: { [id]: emptyConv(id) }, order: [id], activeConv: id };
      return { ...prev, activeWs: path, activeConv: id, workspaces: { ...prev.workspaces, [path]: ws } };
    });
    if (existing) {
      const cid = existing.activeConv ?? existing.order[0] ?? '';
      loadConv(path, cid);
    } else {
      setMessages([]);
      setLedger([]);
      setTodos([]);
      lastPromptTokensRef.current = 0;
    }
  };
  const handleRemoveWorkspace = (path: string) => {
    const workspaces = { ...storeRef.current.workspaces };
    delete workspaces[path];
    const keys = Object.keys(workspaces);
    let aWs = storeRef.current.activeWs;
    let aConv = storeRef.current.activeConv;
    if (storeRef.current.activeWs === path) {
      aWs = keys[0] ?? '';
      aConv = aWs ? (workspaces[aWs].activeConv ?? workspaces[aWs].order[0] ?? '') : '';
    }
    setStore((prev) => ({ ...prev, workspaces, activeWs: aWs, activeConv: aConv }));
    if (aWs && aConv) loadConv(aWs, aConv);
    else {
      setMessages([]);
      setLedger([]);
      setTodos([]);
      lastPromptTokensRef.current = 0;
    }
  };

  const handleRenameConv = (ws: string, cid: string, title: string) => {
    const t = title.trim();
    setEditingConv(null);
    if (!t) return;
    setStore((prev) => {
      const wsd = prev.workspaces[ws];
      const c = wsd?.conversations[cid];
      if (!wsd || !c) return prev;
      return {
        ...prev,
        workspaces: { ...prev.workspaces, [ws]: { ...wsd, conversations: { ...wsd.conversations, [cid]: { ...c, title: t } } } },
      };
    });
  };

  const handleArchiveConv = (ws: string, cid: string, archived: boolean) => {
    const wsd = storeRef.current.workspaces[ws];
    const c = wsd?.conversations[cid];
    if (!wsd || !c) return;
    const isActive = storeRef.current.activeWs === ws && storeRef.current.activeConv === cid;
    let aWs = storeRef.current.activeWs;
    let aConv = storeRef.current.activeConv;
    if (archived && isActive) {
      const other = wsd.order.find((id) => id !== cid && !wsd.conversations[id]?.archived);
      aConv = other ?? '';
    }
    setStore((prev) => {
      const w = prev.workspaces[ws];
      if (!w) return prev;
      const conv = w.conversations[cid];
      if (!conv) return prev;
      return {
        ...prev,
        activeWs: aWs,
        activeConv: aConv,
        workspaces: { ...prev.workspaces, [ws]: { ...w, activeConv: aConv, conversations: { ...w.conversations, [cid]: { ...conv, archived } } } },
      };
    });
    if (archived && isActive) {
      if (aConv) loadConv(aWs, aConv);
      else {
        setMessages([]);
        setLedger([]);
        setTodos([]);
        lastPromptTokensRef.current = 0;
      }
    }
  };

  const handleDeleteConv = (ws: string, cid: string) => {
    if (!window.confirm('Delete this conversation? This cannot be undone.')) return;
    const wsd = storeRef.current.workspaces[ws];
    if (!wsd) return;
    const isActive = storeRef.current.activeWs === ws && storeRef.current.activeConv === cid;
    let aWs = storeRef.current.activeWs;
    let aConv = storeRef.current.activeConv;
    if (isActive) {
      const remaining = wsd.order.filter((id) => id !== cid);
      aConv = remaining.find((id) => !wsd.conversations[id]?.archived) ?? remaining[0] ?? '';
    }
    setStore((prev) => {
      const w = prev.workspaces[ws];
      if (!w) return prev;
      const convs = { ...w.conversations };
      delete convs[cid];
      const order = w.order.filter((id) => id !== cid);
      return {
        ...prev,
        activeWs: aWs,
        activeConv: aConv,
        workspaces: { ...prev.workspaces, [ws]: { ...w, activeConv: aConv, conversations: convs, order } },
      };
    });
    if (isActive) {
      if (aConv) loadConv(aWs, aConv);
      else {
        setMessages([]);
        setLedger([]);
        setTodos([]);
        lastPromptTokensRef.current = 0;
      }
    }
  };

  const abortRef = useRef<AbortController | null>(null);

  const addLog = (entry: Omit<LogEntry, 'id' | 'time'>) => {
    setLedger((prev) => [...prev.slice(-999), { ...entry, id: Math.random().toString(36).slice(2), time: Date.now() }]);
  };

  // Rebuild the system prompt, refreshing the codebase map so the agent sees files
  // it just created/edited (P1 #6). Stored in dynamicSystemRef for use each turn.
  const refreshRepoMap = useCallback(async () => {
    let sys = CODER_SYSTEM;
    try {
      const rMap = await coderRepoMap();
      if (rMap && rMap.map) {
        sys += `\n\n# Codebase Map (Auto-generated AST Signatures)\n\`\`\`\n${rMap.map}\n\`\`\`\n`;
      }
    } catch { /* ignore */ }
    dynamicSystemRef.current = sys;
  }, []);

  const handleToolCalls = async (calls: AgentToolCall[], currentMessages: ChatMessage[], onMutated?: () => void | Promise<void>) => {
    const nextMessages = [...currentMessages];
    let mutated = false;
    
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
          mutated = true;
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
          mutated = true;
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

    if (mutated) {
      try { await onMutated?.(); } catch { /* ignore */ }
    }
    return nextMessages;
  };
  const runAgent = async (initialMessages: ChatMessage[]) => {
    setRunning(true);
    let currentMessages = initialMessages;
    
    // Build the initial system prompt (CODER_SYSTEM + repo map); it is refreshed
    // after file mutations during the run (P1 #6).
    await refreshRepoMap();

    abortRef.current = new AbortController();

    // Resolve the model the engine is actually serving — don't assume 'qwen-coder'
    // (P0 #1). Used for every request, the summarizer, and the context-size lookup.
    let model = 'qwen-coder';
    try {
      const s = await getStatus();
      if (s?.engine?.modelId) model = s.engine.modelId;
    } catch { /* ignore */ }

    // Read the engine's context window so we can auto-compact once usage crosses
    // 80% of max. Prefer the engine's own /v1/models advertisement, falling back
    // to the sidecar-reported maxContext.
    let maxContext = 0;
    try {
      maxContext = (await getEngineContextSize(model)) ?? 0;
    } catch { /* ignore */ }
    if (!maxContext) {
      try {
        const s = await getStatus();
        maxContext = s?.engine?.maxContext ?? 0;
      } catch { /* ignore */ }
    }
    const COMPACT_AT = 0.8;

    // Rough token estimate (~4 chars/token) used as a safety net so a single turn
    // whose tool results push past the window is caught before we send it (P1 #4).
    const sysTokenEstimate = Math.ceil(dynamicSystemRef.current.length / 4);
    const estimateTokens = (msgs: ChatMessage[]): number => {
      let n = sysTokenEstimate;
      for (const m of msgs) {
        n += typeof m.content === 'string' ? m.content.length : 0;
        if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
      }
      return Math.ceil(n / 4);
    };
    
    try {
      while (true) {
        if (abortRef.current?.signal.aborted) break;

        // Auto-compact when the model context is near (>=80%) or past (estimate
        // >=100%) the window limit, so we never silently truncate mid-task.
        const overBudget =
          maxContext > 0 &&
          (lastPromptTokensRef.current >= COMPACT_AT * maxContext ||
            estimateTokens(currentMessages) >= maxContext);
        if (overBudget) {
          addLog({ type: 'compact', label: 'compact', detail: `context ${lastPromptTokensRef.current}/${maxContext} — summarizing` });
          try {
            const summary = await summarizeConversation({
              model,
              systemPrompt: dynamicSystemRef.current,
              history: currentMessages,
              maxTokens: 2048,
            });
            if (!summary) throw new Error('compaction produced no summary');
            currentMessages = [{ role: 'user', content: frameCompactedSummary(summary) }];
            // Keep the full transcript on screen; only the model context is
            // cleared down to the summary checkpoint (re-injected as leading
            // context on the next turn).
            setMessages((prev) => [...prev, ...currentMessages]);
            lastPromptTokensRef.current = 0;
            continue;
          } catch (e) {
            // Compaction is our only guard against context overflow — if it fails
            // we must stop rather than send an oversized payload (P1 #3).
            addLog({ type: 'error', label: 'compact', detail: e instanceof Error ? e.message : String(e) });
            setMessages((prev) => [
              ...prev,
              {
                role: 'system',
                content:
                  '⚠ Auto-compaction failed, so the run was stopped to avoid exceeding the model context window. Start a new conversation or compact manually.',
              },
            ]);
            break;
          }
        }
        
        let content = '';
        let reasoning = '';
        let toolCalls: AgentToolCall[] = [];
        
        const req = buildChatRequest(model, dynamicSystemRef.current, currentMessages, { thinking: true, maxTokens: 8192 } as ChatParams, { tools: TOOLS });
        
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
        setMessages((prev) => [...prev, assistantMsg]);
        
        if (toolCalls.length > 0) {
          const before = currentMessages.length;
          currentMessages = await handleToolCalls(toolCalls, currentMessages, refreshRepoMap);
          // Keep the Commit History panel live as the agent commits changes.
          loadCommits();
          // Append only the new tool results to the visible transcript.
          setMessages((prev) => [...prev, ...currentMessages.slice(before)]);
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
    if ((!input.trim() && attachments.length === 0) || running || !activeWs) return;
    const msg: ChatMessage = { role: 'user', content: input.trim(), attachments: attachments.length ? attachments : undefined };
    const next = [...messages, msg];
    setMessages(next);
    setInput('');
    setAttachments([]);
    // Seed the model context from the most recent compaction checkpoint onward.
    // The visible transcript keeps the full history; only the engine's context is
    // cleared to the summary and re-injected as leading context.
    runAgent(compactedContext(messages).concat(msg));
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  // ---- Workspace file attachments -------------------------------------------
  const openPicker = async () => {
    setPickerSelected({});
    setShowPicker(true);
    setPickerLoading(true);
    try {
      const tree = await coderTree(4, '.');
      setPickerNodes(tree.nodes ?? []);
    } catch {
      setPickerNodes([]);
    } finally {
      setPickerLoading(false);
    }
  };
  const toggleNode = (path: string) =>
    setPickerExpanded((e) => ({ ...e, [path]: !e[path] }));
  const attachSelected = async (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (attachments.some((a) => a.path === node.path)) continue;
      try {
        if (isImagePath(node.path)) {
          const res = await coderReadBase64(node.path);
          setAttachments((cur) => [...cur, { kind: 'image', name: node.name, path: node.path, dataUrl: res.dataUrl }]);
        } else {
          const res = await coderRead(node.path);
          setAttachments((cur) => [...cur, { kind: 'file', name: node.name, path: node.path, content: res.content ?? '' }]);
        }
      } catch {
        /* ignore unreadable file */
      }
    }
    setShowPicker(false);
    setPickerSelected({});
  };
  const removeAttachment = (path?: string) =>
    setAttachments((cur) => cur.filter((a) => a.path !== path));

  const messageGroups = useMemo(() => {
    const groups: { type: 'message' | 'trajectory' | 'compact', items: ChatMessage[] }[] = [];
    let currentTrajectory: ChatMessage[] = [];

    const flushTrajectory = () => {
      if (currentTrajectory.length > 0) {
        groups.push({ type: 'trajectory', items: currentTrajectory });
        currentTrajectory = [];
      }
    };

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      // Compaction checkpoints are shown as a quiet divider, not a chat bubble.
      if (isCompactedMsg(m)) {
        flushTrajectory();
        groups.push({ type: 'compact', items: [m] });
        continue;
      }
      const isBackground = m.role === 'tool' || (m.role === 'assistant' && !!m.tool_calls?.length);

      if (isBackground) {
        currentTrajectory.push(m);
      } else {
        flushTrajectory();
        groups.push({ type: 'message', items: [m] });
      }
    }
    flushTrajectory();
    return groups;
  }, [messages]);

  const activeMeta = store.workspaces[activeWs]?.conversations[activeConv];

  return (
    <div className="flex h-full w-full">
      {/* Left: workspace folders + conversations + ledger */}
      <div className="flex w-72 flex-col border-r border-line bg-panel">
        <div className="flex items-center gap-2 border-b border-line p-2 text-sm font-semibold">
          <Terminal size={14} /> Conversations
          <button
            className="ml-auto flex items-center gap-1 rounded border border-line px-2 py-0.5 text-[11px] font-normal text-mute hover:bg-panel2 hover:text-ink disabled:opacity-40"
            title="Add a workspace folder"
            onClick={() => setShowDir(true)}
            disabled={wsBusy}
          >
            <FolderPlus size={13} /> Add
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {Object.keys(store.workspaces).length === 0 && (
            <div className="p-3 text-[11px] italic text-faint">
              No workspaces yet — click “Add” to point the coder at a folder.
            </div>
          )}
          {Object.entries(store.workspaces).map(([ws, wsd]) => {
            const isActiveWs = ws === activeWs;
            return (
              <div key={ws} className="border-b border-line/60">
                <div className={cn('group flex items-center gap-1 px-1.5 py-1.5', isActiveWs ? 'bg-accent/10' : 'hover:bg-panel2')}>
                  <button
                    className="shrink-0 text-faint hover:text-ink"
                    onClick={() => handleToggleExpand(ws)}
                    title={wsd.expanded ? 'Collapse' : 'Expand'}
                  >
                    {wsd.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => handleSelectWorkspace(ws)} title={ws}>
                    <Folder size={13} className={cn('shrink-0', isActiveWs ? 'text-accent' : 'text-mute')} />
                    <span className={cn('truncate text-[12px] font-medium', isActiveWs ? 'text-ink' : 'text-mute')}>{baseName(ws)}</span>
                    <span className="shrink-0 rounded-full bg-panel2 px-1.5 text-[9.5px] text-faint">{wsd.order.length}</span>
                  </button>
                  <button
                    className="shrink-0 text-faint opacity-0 hover:text-ink group-hover:opacity-100"
                    title="New conversation in this workspace"
                    onClick={() => newChat(ws)}
                  >
                    <Plus size={13} />
                  </button>
                  <button
                    className="shrink-0 text-faint opacity-0 hover:text-danger group-hover:opacity-100"
                    title="Remove workspace"
                    onClick={() => handleRemoveWorkspace(ws)}
                  >
                    <X size={13} />
                  </button>
                </div>

                {wsd.expanded && (
                  <div className="space-y-0.5 pb-1.5 pl-6 pr-1.5">
                    {wsd.order
                      .filter((cid) => {
                        const c = wsd.conversations[cid];
                        return c && !c.archived;
                      })
                      .map((cid) => {
                        const c = wsd.conversations[cid];
                        if (!c) return null;
                        const isActive = ws === activeWs && cid === activeConv;
                        const isEditing = editingConv?.ws === ws && editingConv?.cid === cid;
                        return (
                          <div
                            key={cid}
                            className={cn('group flex items-center gap-1 rounded px-1.5 py-1', isActive ? 'bg-accent/15 text-ink' : 'text-mute hover:bg-panel2')}
                          >
                            {isEditing ? (
                              <input
                                autoFocus
                                defaultValue={c.title}
                                className="min-w-0 flex-1 rounded border border-line bg-inset px-1 py-0.5 text-[11.5px] outline-none focus:border-accent/50"
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleRenameConv(ws, cid, (e.target as HTMLInputElement).value);
                                  if (e.key === 'Escape') setEditingConv(null);
                                }}
                                onBlur={(e) => handleRenameConv(ws, cid, e.target.value)}
                              />
                            ) : (
                              <button
                                onClick={() => handleSelectConv(ws, cid)}
                                className={cn('min-w-0 flex-1 truncate text-left text-[11.5px]', isActive ? 'font-medium' : '')}
                                title={c.title}
                              >
                                {c.title || 'New conversation'}
                              </button>
                            )}
                            {c.updatedAt && !isEditing ? (
                              <span className="shrink-0 text-[9.5px] text-faint">{relTime(c.updatedAt)}</span>
                            ) : null}
                            {!isEditing && (
                              <div className="flex shrink-0 items-center gap-1 rounded bg-panel2/60 px-1 opacity-60 group-hover:opacity-100">
                                <button
                                  className="rounded p-1 text-faint hover:bg-panel hover:text-ink"
                                  title="Rename conversation"
                                  onClick={() => setEditingConv({ ws, cid })}
                                >
                                  <Pencil size={14} />
                                </button>
                                <button
                                  className="rounded p-1 text-faint hover:bg-panel hover:text-ink"
                                  title="Archive conversation"
                                  onClick={() => handleArchiveConv(ws, cid, true)}
                                >
                                  <Archive size={14} />
                                </button>
                                <button
                                  className="rounded p-1 text-faint hover:bg-panel hover:text-danger"
                                  title="Delete conversation"
                                  onClick={() => handleDeleteConv(ws, cid)}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}

                    {wsd.order.some((cid) => wsd.conversations[cid]?.archived) && (
                      <div className="pt-1">
                        <button
                          onClick={() => setArchivedOpen((o) => ({ ...o, [ws]: !o[ws] }))}
                          className="flex w-full items-center gap-1 px-1.5 py-1 text-[10.5px] text-faint hover:text-ink"
                        >
                          {archivedOpen[ws] ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                          Archived ({wsd.order.filter((cid) => wsd.conversations[cid]?.archived).length})
                        </button>
                        {archivedOpen[ws] &&
                          wsd.order
                            .filter((cid) => wsd.conversations[cid]?.archived)
                            .map((cid) => {
                              const c = wsd.conversations[cid];
                              if (!c) return null;
                              const isActive = ws === activeWs && cid === activeConv;
                              return (
                                <div
                                  key={cid}
                                  className={cn('group flex items-center gap-1 rounded px-1.5 py-1', isActive ? 'bg-accent/15 text-ink' : 'text-faint hover:bg-panel2')}
                                >
                                  <button
                                    onClick={() => handleSelectConv(ws, cid)}
                                    className="min-w-0 flex-1 truncate text-left text-[11.5px] line-through"
                                    title={c.title}
                                  >
                                    {c.title || 'New conversation'}
                                  </button>
                                  <div className="flex shrink-0 items-center gap-1 rounded bg-panel2/60 px-1 opacity-60 group-hover:opacity-100">
                                    <button
                                      className="rounded p-1 text-faint hover:bg-panel hover:text-ink"
                                      title="Restore conversation"
                                      onClick={() => handleArchiveConv(ws, cid, false)}
                                    >
                                      <RotateCcw size={14} />
                                    </button>
                                    <button
                                      className="rounded p-1 text-faint hover:bg-panel hover:text-danger"
                                      title="Delete conversation"
                                      onClick={() => handleDeleteConv(ws, cid)}
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Session Ledger */}
        <div className="max-h-44 shrink-0 overflow-auto border-t border-line p-2">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Session Ledger</div>
          <div className="space-y-1.5">
            {ledger.map((l) => (
              <div key={l.id} className="flex flex-col gap-0.5 border-l-2 border-line pl-2 ml-1 text-[10.5px]">
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

        {/* Commit History — git log of the active workspace */}
        <div className="max-h-52 shrink-0 overflow-hidden border-t border-line p-2">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-faint">
            <GitCommit size={13} /> Commit History
            <button
              type="button"
              className="ml-auto rounded p-0.5 text-faint hover:text-ink"
              title="Refresh"
              onClick={() => loadCommits()}
            >
              <RefreshCw size={12} className={commitsLoading ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              className="rounded p-0.5 text-faint hover:text-ink"
              title={commitsOpen ? 'Collapse' : 'Expand'}
              onClick={() => setCommitsOpen((o) => !o)}
            >
              {commitsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          </div>
          {commitsOpen && (
            <div className="max-h-40 space-y-1 overflow-auto">
              {commitsLoading ? (
                <div className="text-faint italic text-[11px]">Loading…</div>
              ) : commits.length === 0 ? (
                <div className="text-faint italic text-[11px]">No commits yet.</div>
              ) : (
                commits.map((c) => (
                  <div key={c.hash} className="rounded border border-line">
                    <button
                      type="button"
                      onClick={() => setExpandedCommit(expandedCommit === c.hash ? null : c.hash)}
                      className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-panel2"
                    >
                      <span className="shrink-0 font-mono text-[10.5px] text-accent">{c.hash.slice(0, 7)}</span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{c.subject}</span>
                      <span className="shrink-0 text-[10px] text-faint">{c.relDate}</span>
                    </button>
                    {expandedCommit === c.hash && (
                      <div className="whitespace-pre-wrap border-t border-line px-2 py-1.5 text-[10.5px] leading-relaxed text-mute">
                        <div className="mb-1 text-faint">{c.author} · {c.date}</div>
                        {c.body || c.subject}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* Center: conversation messages */}
      <div className="flex flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 text-[12px]">
          <Folder size={13} className="text-accent" />
          <span className="font-medium text-ink">{activeWs ? baseName(activeWs) : 'No workspace'}</span>
          <span className="text-faint">/</span>
          <span className="truncate text-mute">{activeMeta?.title || 'New conversation'}</span>
          <button
            className="ml-auto rounded border border-line px-2 py-0.5 text-[11px] text-mute hover:bg-panel2 hover:text-ink disabled:opacity-40"
            onClick={() => newChat(activeWs)}
            disabled={!activeWs}
            title="New conversation in this workspace"
          >
            + chat
          </button>
        </div>

        <div className="flex-1 overflow-auto bg-panel2 space-y-4 p-4">
          {!activeWs ? (
            <div className="flex h-full items-center justify-center text-center text-[13px] text-faint">
              <div>
                <p>No workspace selected.</p>
                <p className="mt-1 text-[12px]">Click “Add” to point the coder at a folder.</p>
              </div>
            </div>
          ) : (
            messageGroups.map((g, i) => (
              <React.Fragment key={i}>
                {g.type === 'compact' ? (
                  <div className="my-1 flex items-center gap-2 text-[10.5px] text-faint">
                    <span className="h-px flex-1 bg-line" />
                    <span className="flex items-center gap-1">✂ Context compacted</span>
                    <span className="h-px flex-1 bg-line" />
                  </div>
                ) : g.type === 'trajectory' ? (
                  <TrajectoryBlock items={g.items} />
                ) : (
                  <div className={cn("p-3 rounded-lg border mb-4", g.items[0].role === 'user' ? 'bg-panel border-line' : 'bg-panel border-accent/30')}>
                    <div className="font-semibold text-xs text-faint mb-1">{g.items[0].role === 'assistant' ? 'Garrulous' : g.items[0].role}</div>
                    {g.items[0].attachments?.length ? (
                      <div className="flex flex-wrap gap-1.5 mb-1.5">
                        {g.items[0].attachments.map((a, i) => (
                          <span key={i} className="inline-flex items-center gap-1 rounded-full border border-line bg-panel2 px-2 py-0.5 text-[11.5px] text-ink">{a.kind === 'image' ? <Image size={11} /> : <File size={11} />} {a.name}</span>
                        ))}
                      </div>
                    ) : null}
                    {g.items[0].content && (
                      g.items[0].role === 'assistant'
                        ? <div className="markdown text-[13.5px] leading-relaxed"><Markdown>{g.items[0].content}</Markdown></div>
                        : <div className="text-sm whitespace-pre-wrap">{g.items[0].content}</div>
                    )}
                  </div>
                )}
              </React.Fragment>
            ))
          )}
        </div>
        <div className="border-t border-line bg-panel p-3">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {attachments.map((a) => (
                <span key={a.path} className="inline-flex items-center gap-1 rounded-full border border-line bg-panel2 px-2 py-0.5 text-[11.5px] text-ink">
                  {a.kind === 'image' ? <Image size={11} /> : <File size={11} />} {a.name}
                  <button type="button" onClick={() => removeAttachment(a.path)} className="text-faint hover:text-danger" title="Remove">
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={openPicker} disabled={running || !activeWs} title="Attach workspace files">
              <Paperclip size={14} />
            </Button>
            <input 
              className="flex-1 bg-inset border border-line rounded px-3 py-1.5 text-sm outline-none focus:border-accent/50" 
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && onSubmit()}
              placeholder={activeWs ? "Instruct the coder agent..." : "Add a workspace to begin"}
              disabled={running || !activeWs}
            />
            {running ? (
               <Button variant="danger" onClick={stop}><Square size={14} /> Stop</Button>
            ) : (
               <Button variant="primary" onClick={onSubmit} disabled={!activeWs && attachments.length === 0}><Play size={14} /> Run</Button>
            )}
          </div>
        </div>
      </div>

      {/* Right: todos */}
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

      {showDir && (
        <DirBrowser
          initialPath={activeWs || '/'}
          onPick={(p) => { handleAddWorkspace(p); setShowDir(false); }}
          onClose={() => setShowDir(false)}
        />
      )}

      {showPicker && (
        <FilePickerModal
          nodes={pickerNodes}
          loading={pickerLoading}
          expanded={pickerExpanded}
          selected={pickerSelected}
          onToggle={toggleNode}
          onToggleSelect={(p) => setPickerSelected((s) => ({ ...s, [p]: !s[p] }))}
          onAttachSelected={attachSelected}
          onClose={() => setShowPicker(false)}
          attached={attachments}
          maxBytes={ATTACH_MAX_BYTES}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace file picker — attach project files to a Coder message.
// ---------------------------------------------------------------------------
function FilePickerModal({
  nodes,
  loading,
  expanded,
  selected,
  onToggle,
  onToggleSelect,
  onAttachSelected,
  onClose,
  attached,
  maxBytes,
}: {
  nodes: FileNode[];
  loading: boolean;
  expanded: Record<string, boolean>;
  selected: Record<string, boolean>;
  onToggle: (path: string) => void;
  onToggleSelect: (path: string) => void;
  onAttachSelected: (nodes: FileNode[]) => void;
  onClose: () => void;
  attached: ChatAttachment[];
  maxBytes: number;
}) {
  const attachedPaths = new Set(attached.map((a) => a.path));
  const collectFiles = (list: FileNode[]): FileNode[] => {
    const out: FileNode[] = [];
    for (const n of list) {
      if (n.kind === 'file') out.push(n);
      if (n.children) out.push(...collectFiles(n.children));
    }
    return out;
  };
  const allFiles = collectFiles(nodes);
  const selectedNodes = allFiles.filter((n) => selected[n.path]);
  const renderNodes = (list: FileNode[], depth: number): React.ReactNode => (
    <div>
      {list.map((n) => (
        <div key={n.path}>
          <div className="flex items-center gap-1 py-0.5 hover:bg-panel2 rounded px-1" style={{ paddingLeft: depth * 12 }}>
            {n.kind === 'dir' ? (
              <button type="button" onClick={() => onToggle(n.path)} className="flex items-center gap-1 text-ink">
                {expanded[n.path] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Folder size={13} className="text-accent" /> {n.name}
              </button>
            ) : (
              <label className={cn('flex items-center gap-1 text-ink', attachedPaths.has(n.path) ? 'opacity-50' : '')}>
                <input
                  type="checkbox"
                  checked={!!selected[n.path]}
                  disabled={attachedPaths.has(n.path) || (n.size ?? 0) > maxBytes}
                  onChange={() => onToggleSelect(n.path)}
                />
                {isImagePath(n.path) ? <Image size={13} /> : <File size={13} />} {n.name}
                {n.size != null &&
                  (n.size > maxBytes ? (
                    <span className="text-danger text-[10px]">over 5 MB</span>
                  ) : (
                    <span className="text-faint text-[10px]">{Math.ceil(n.size / 1024)} KB</span>
                  ))}
              </label>
            )}
          </div>
          {n.kind === 'dir' && expanded[n.path] && n.children && renderNodes(n.children, depth + 1)}
        </div>
      ))}
    </div>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[520px] max-h-[70vh] flex flex-col rounded-xl border border-line bg-panel shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line p-3">
          <div className="text-sm font-semibold flex items-center gap-2"><Paperclip size={14} /> Attach workspace files</div>
          <button type="button" onClick={onClose} className="text-faint hover:text-ink"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-auto p-2 text-[12.5px]">
          {loading ? (
            <div className="p-3 text-faint">Loading tree…</div>
          ) : nodes.length ? (
            renderNodes(nodes, 0)
          ) : (
            <div className="p-3 text-faint">No files.</div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-line p-2">
          <span className="text-[11px] text-faint">Select files (≤5 MB each). Images embed as pictures; others inline as text.</span>
          <Button variant="primary" size="sm" disabled={selectedNodes.length === 0} onClick={() => onAttachSelected(selectedNodes)}>
            Attach {selectedNodes.length || ''} selected
          </Button>
        </div>
      </div>
    </div>
  );
}
