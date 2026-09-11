import React, { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react';
import { Play, Square, X, BrainCircuit, Terminal, CheckSquare, Plus, Folder, ChevronRight, ChevronDown, ChevronLeft, FolderPlus, Pencil, Archive, Trash2, RotateCcw, File, Paperclip, Image, GitCommit, RefreshCw, Shield, HelpCircle, Undo2, SlidersHorizontal, GitFork, Download, BookmarkPlus, MessageSquare } from 'lucide-react';
import { CoderWorkspace, AgentToolCall, ChatMessage, ChatParams, ChatAttachment, FileNode, CoderJob } from '../lib/types';
import { Button, CodeBlock, NumberField, Toggle, SelectField, cn } from '../components/ui';
import { DirBrowser } from '../components/DirBrowser';
import { Markdown } from '../components/Markdown';
import { DiffReviewModal } from '../components/DiffReviewModal';
import { MemoryModal } from '../components/MemoryModal';
import { HitlDialog } from '../components/HitlDialog';
import { isImagePath } from '../lib/fileKind';
import { parseDiagnostics } from '../lib/diagnostics';
import { fetchFileDiff } from '../lib/gitStatus';
import { useFileTabs, GIT_BADGE_CLASS } from '../components/editor/tabModel';
import { coderTree, coderRepoMap, coderRead, coderReadBase64, coderWrite, coderEdit, coderPatch, coderExec, coderJob, coderJobKill, coderGrep, coderGlob, coderSearch, coderWebFetch, coderWebSearch, coderGitLog, streamChat, buildChatRequest, getConfig, setCoderWorkspace, getStatus, getEngineContextSize, summarizeConversation, frameCompactedSummary, coderSafeModeGet, coderSafeModeSet, coderSandboxGet, coderSandboxSet, coderDiff, coderMemoryGet, coderMemorySetBank, coderMemoryAddLearning, coderMemoryDropLearning, summarizeOutput, type CoderCommit, type CoderDiffResult, type CoderMemory, type CoderLearning, type CoderLearningKind, type ChatStreamCallbacks } from '../lib/api';
import { NOT_AI_CONTRACT, voiceSnippet, effectiveVoice, evaluate, needsHumanize, humanizeRewriteText, VOICE_PROFILES, type VoiceProfile } from '../lib/notai';
import { coderLensBlock, CODING_LENSES, LINUS_LENS } from '../lib/coderLens';
import { formatTokens } from '../lib/format';

const ATTACH_MAX_BYTES = 50 * 1024 * 1024;
const LazyEditorPane = lazy(() => import('../components/editor/EditorPane'));
/** Cheap guard used by the commit-approval gate: does this shell command commit? */
const isGitCommitCommand = (cmd: string): boolean => {
  const c = cmd.replace(/^\s*(sudo|env|time|setsid|nice)\s+/, '').trim();
  return /^git\b/.test(c) && /\bcommit\b/.test(c);
};
const CODER_SYSTEM = `You are an elite, autonomous software engineer with complete access to the user's workspace, file system, and the internet.
Your goal is to relentlessly drive the user's request to completion. Do not stop at planning—execute the plan, write the code, and prove it works.

# Core Directives
1. **Research First**: ALWAYS investigate before writing code. 
   - Use \`web_search\` and \`web_fetch\` to read the latest documentation, GitHub issues, or stackoverflow answers for any library or framework you are working with. Never guess APIs.
   - Use \`glob\`, \`grep\` (powered by blazing-fast ripgrep), \`ast_grep\` (for AST structural search), and \`read\` to understand the codebase's existing architecture and style.
   - Use \`git_commit\` to save your work in logical commits and \`git_diff\` to review changes before committing. The harness also auto-commits writes/edits, but you should make intentional, well-messaged commits too.
    - Delegate independent, well-scoped implementation tasks to the subagent tool to fan work out to focused workers that edit the shared workspace and return a diff + summary. Keep the supervisor in control of commits and final integration; use subagents for genuinely parallelizable work, not trivial single edits.
    - Trivial lookups (current git branch, a version number, whether a file exists, a config value) deserve ONE direct tool call and an immediate answer. Never delegate them to a subagent and never chain extra tool calls once you have the answer — reply at once.
2. **Best Practices**: Write clean, modular, and maintainable code. Match the existing project conventions perfectly.
3. **Verify Everything**: After editing, use \`bash\` to run compilers, linters, or test suites. If an error occurs, do not ask the user for help—use your tools to read the logs, search the web for the error, and fix it yourself. For long-running commands (builds, test suites), pass \`background:true\` to \`bash\` and poll the returned job with \`bash_poll\` until \`done:true\` instead of blocking.
4. **Track Progress**: Use \`todo_write\` to maintain a structured plan. Mark steps as \`in_progress\` while working, and \`completed\` when done. This helps you and the user stay aligned.
5. **Completion**: Only emit a final conversational response when the ENTIRE task is fully complete, tested, and verified.
6. **Context is managed for you**: this harness automatically compacts the conversation when it nears the model's context limit, replacing earlier turns with a concise summary checkpoint. You do NOT need to summarize manually — keep working normally and rely on the checkpoint to preserve prior context.
 7. **You have a memory that persists across sessions**. The system prompt above injects the repository's *Memory Bank* (a curated markdown file the user maintains) and *Learnings* extracted from prior runs. Consult them before acting — they encode hard-won conventions, gotchas, and working commands. When you discover something non-obvious mid-work (a working build/test command, a project convention, a fix that worked, or a mistake to avoid), record it with the \`memory_update\` tool so future runs start smarter. Pass kind='success' for a working approach, 'tip' for a convention/fact/command, and 'avoid' for a mistake or anti-pattern.
`;

// Worker subagent (implementation): a focused agent that shares the workspace and
// writes real code but leaves version control + human interaction to the supervisor.
const WORKER_SYSTEM = `You are a focused implementation subagent inside a coding harness. You are given ONE self-contained task and must implement it in the shared workspace.
- Read, search, and edit files with your tools. You MAY run shell commands (bash) to build, test, and verify.
- Do NOT call: ask_user (never pause for the human), git_commit / git_branch / git_worktree (the supervisor owns version control), subagent (no nested implementation subagents), or todo_write.
- Make reasonable decisions and proceed; never ask the user for input. If the task is ambiguous, pick the most sensible interpretation and note it in your summary.
- When the task is complete, STOP calling tools and reply with a concise summary: what you changed, the files touched, and any build/test commands you ran.
- Stay strictly scoped to the assigned task.`;

// Critic: reviews a working-tree-vs-HEAD diff against the task and decides approve / reject.
const CRITIC_SYSTEM = `You are a meticulous senior code reviewer. You are given a task and a unified diff (working tree vs HEAD). Decide whether the changes are acceptable.
Respond with EXACTLY one verdict line, then (only when rejecting) a short prioritized list of issues:
VERDICT: APPROVED
or
VERDICT: CHANGES_REQUESTED
<issue 1 — file:line, suggested fix>
<issue 2 — ...>
Do not rewrite code. Be precise and concise, and prefer specific file:line references.

After the verdict, you MAY append reusable learnings, one per line, to make future runs smarter. Only include learnings that are genuinely reusable and non-obvious; none is fine:
LEARNING: <a working approach, command, or convention worth repeating — something to DO>
AVOID: <a mistake or anti-pattern to steer future runs away from — something NOT to do>`;

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
      name: "apply_patch",
      description: "Apply multiple string replacements to one file in a single atomic operation — all edits must match or nothing is written. Prefer over several edit calls for multi-hunk changes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            description: "Ordered replacements applied top-to-bottom against the evolving file.",
            items: {
              type: "object",
              properties: {
                old: { type: "string" },
                new: { type: "string" },
                replaceAll: { type: "boolean" }
              },
              required: ["old", "new"]
            }
          }
        },
        required: ["path", "edits"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the workspace. Pass background:true for long builds/tests — returns a jobId immediately; poll it with bash_poll until done.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeoutMs: { type: "number" },
          background: { type: "boolean", description: "Run detached; returns {jobId} instead of blocking." }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bash_poll",
      description: "Poll a background bash job started with background:true. Returns done, exitCode, and tail-capped output. Keep polling until done:true.",
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string" }
        },
        required: ["jobId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search for a regex pattern in files. Results are paginated — if the result's `more` is true, pass `offset` to fetch the next page (the `total` field shows the true count).",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          include: { type: "string", description: "Glob pattern to include (e.g. *.ts)" },
          ignoreCase: { type: "boolean" },
          offset: { type: "number", description: "Page offset for large result sets (default 0)." },
          limit: { type: "number", description: "Max matches to return per page (default 200, max 2000)." }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files matching a glob pattern. Paginated — if `more` is true, pass `offset` for the next page.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          offset: { type: "number", description: "Page offset for large result sets (default 0)." },
          limit: { type: "number", description: "Max files to return per page (default 200)." }
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
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description: "Stage files and create a git commit in the workspace. Commit only the files you intend to save. Use '-A' to stage all changes, or list specific paths.",
      parameters: {
        type: "object",
        properties: {
          files: { type: "string", description: "Files to stage. Use '-A' for all changes, or a space-separated list of paths." },
          message: { type: "string", description: "Commit message." }
        },
        required: ["files", "message"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show a git diff. Use with no ref for unstaged+staged changes, a single revision for changes vs it, or two revisions. Add a path filter to limit scope.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Revision(s): empty for working tree, a single ref, or 'a..b'." },
          path: { type: "string", description: "Optional path filter(s): a single path or several space-separated paths (e.g. 'src/ lib/')." }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delegate",
      description: "Spawn a subagent to investigate a focused sub-task and return a summary. Perfect for fanning out research or mapping distant files without bloating your context. The subagent runs in parallel and cannot write files (read-only tools only).",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Clear, standalone instructions for the subagent." },
          tools: { type: "array", items: { type: "string" }, description: "List of read-only tools it may use (e.g. ['read', 'grep', 'glob']). Omit for all read-only tools." }
        },
        required: ["task"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "subagent",
      description: "Spawn an IMPLEMENTATION subagent to complete a focused coding task in the shared workspace. It can read, search, edit, and run commands, but cannot commit, branch, or ask the user. Use it to fan out independent implementation work; the harness captures the subagent's diff and returns a summary. Each call runs sequentially to avoid clobbering the working tree.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "A clear, self-contained implementation task for the subagent." },
          tools: { type: "array", items: { type: "string" }, description: "Optional allow-list of tools it may use (e.g. ['read','grep','write','edit','bash']). Omit for the default implementation set." },
          model: { type: "string", description: "Optional model id for the subagent (defaults to the supervisor's model)." }
        },
        required: ["task"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_branch",
      description: "List, create, or switch git branches in the workspace. Creating switches to the new branch.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "create", "switch"] },
          name: { type: "string", description: "Branch name for create/switch." }
        },
        required: ["action"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_pr",
      description: "Open a pull request for the CURRENT branch. Requires a clean, committed working tree. Uses the `gh` CLI when available (and a remote is configured); otherwise it pushes the branch and returns a compare URL so you can open the PR manually. Never force-pushes.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "PR title." },
          body: { type: "string", description: "PR description / summary (markdown ok)." },
          base: { type: "string", description: "Base branch to target (default: the repo's default branch)." }
        },
        required: ["title"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_worktree",
      description: "List or create git worktrees to isolate parallel tasks. A worktree checks out a branch into a separate directory without affecting the main working tree.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "add"] },
          path: { type: "string", description: "Relative path for the new worktree (e.g. '../task-foo')." },
          branch: { type: "string", description: "Branch to create/checkout in the new worktree (e.g. 'task-foo')." }
        },
        required: ["action"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "repo_search",
      description: "Ranked retrieval over the workspace: returns the most relevant files/symbols for a query, ranked by symbol and content match. Prefer this over blind grep when hunting for 'where X is implemented', 'the auth handler', or similar — it surfaces the right places to read first.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language or keyword query, e.g. 'parse config' or 'AuthProvider'." },
          limit: { type: "number", description: "Max results to return (default 15, max 50)." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description: "Pause and ask the user a clarifying question or request approval before proceeding (e.g. which approach to take, confirmation for an irreversible action). Use sparingly — only when you genuinely cannot continue without the user's input. The run will pause until they answer.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question or request to show the user." }
        },
        required: ["question"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "memory_update",
      description: "Record a durable learning to this repo's memory bank so future sessions start smarter. Use it proactively when you discover something non-obvious: a build/test command, a project convention, a gotcha to avoid, or a fix that worked. The harness also auto-captures learnings from the critic, so only record things that surfaced mid-work. Pass kind='avoid' for mistakes/anti-patterns to steer future runs away from them.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "One concise, self-contained learning (imperative, e.g. 'Run `pnpm test` (not npm) — this repo uses pnpm.')." },
          kind: { type: "string", enum: ["success", "tip", "avoid"], description: "success = a working approach/fix; tip = a convention/fact/command; avoid = a mistake or anti-pattern." }
        },
        required: ["text", "kind"]
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
            <span>Terminal {data.jobId ? `(background job ${data.jobId} — poll with bash_poll)` : data.exitCode !== null && data.exitCode !== undefined ? `(exit ${data.exitCode})` : ''}</span>
            <span className="flex items-center gap-2">
              {data.blocked && <span className="text-danger font-semibold">Blocked by safe mode</span>}
              {data.timedOut && <span className="text-warn">Timeout</span>}
            </span>
          </div>
          <div className="p-2 overflow-auto max-h-64 whitespace-pre">
            {data.stdout && <div>{redactSecrets(data.stdout)}</div>}
            {data.stderr && <div className="text-danger">{redactSecrets(data.stderr)}</div>}
            {!data.stdout && !data.stderr && <div className="text-faint italic">No output</div>}
            {data.blocked && <div className="mt-1 border-t border-[#3a3a3a] pt-1 text-[#858585]">The model can ask for one-off approval via ask_user — approve only for trusted workspaces (Safe Mode toggle in the sidebar).</div>}
          </div>
        </div>
      );
    }
    if (name === 'read') {
      return (
        <div className="mt-1">
           <CodeBlock code={redactSecrets(data.content || '')} />
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
            {data.content ? redactSecrets(data.content) : <span className="italic text-faint">No content extracted.</span>}
            {data.truncated && <div className="mt-2 text-warn italic border-t border-line pt-1 text-[10px]">Content truncated due to length limits.</div>}
          </div>
        </div>
      );
    }

    if (name === 'write') {
      return (
      <div className="mt-1 p-2 bg-ok/10 border border-ok/30 rounded-md text-[11px] text-ok font-mono">
         Wrote {typeof data.bytes === 'number' ? `${data.bytes} bytes` : 'file'}{data.created ? ' (new file)' : ''}.
         {data.preview_diff && <div className="mt-1.5"><CodeBlock code={data.preview_diff} /></div>}
         {data.linter_error && <div className="mt-1.5 whitespace-pre-wrap text-danger">Lint failed:{'\n'}{redactSecrets(String(data.linter_error)).slice(0, 2000)}</div>}
         {data.test_error && <div className="mt-1.5 whitespace-pre-wrap text-danger">Tests failed:{'\n'}{redactSecrets(String(data.test_error)).slice(0, 2000)}</div>}
      </div>
      );
    }

    if (name === 'edit' || name === 'apply_patch') {
      return (
      <div className="mt-1 p-2 bg-ok/10 border border-ok/30 rounded-md text-[11px] text-ok font-mono">
         Applied edit ({typeof data.replacements === 'number' ? `${data.replacements} replacement${data.replacements === 1 ? '' : 's'}` : 'done'}).
         {data.preview_diff && <div className="mt-1.5"><CodeBlock code={redactSecrets(data.preview_diff)} /></div>}
         {data.linter_error && <div className="mt-1.5 whitespace-pre-wrap text-danger">Lint failed:{'\n'}{redactSecrets(String(data.linter_error)).slice(0, 2000)}</div>}
         {data.test_error && <div className="mt-1.5 whitespace-pre-wrap text-danger">Tests failed:{'\n'}{redactSecrets(String(data.test_error)).slice(0, 2000)}</div>}
      </div>
      );
    }
    
    if (name === 'grep' || name === 'glob' || name === 'git_branch' || name === 'bash_poll') {
       return (
         <div className="mt-1 p-2 bg-inset border border-line rounded-md text-[11px] font-mono overflow-auto max-h-48 whitespace-pre">
           {redactSecrets(JSON.stringify(data, null, 2))}
         </div>
       )
    }

    if (name === 'ask_user') {
      return (
        <div className="mt-1 p-2 bg-accent/10 border border-accent/30 rounded-md text-[11px] text-ink">
          <div className="font-semibold text-accent mb-0.5 flex items-center gap-1">
            <HelpCircle size={12} /> Agent asked:
          </div>
          <div className="whitespace-pre-wrap">{data?.question || content}</div>
        </div>
      );
    }

  } catch {
    // fallback
  }
  return <div className="text-sm whitespace-pre-wrap">{content}</div>;
}

/** Collapsed-by-default harness report (Scout / Verify / Critic). These are
 *  model-written markdown documents injected into the transcript — they get a
 *  proper source label and render as markdown when expanded, instead of
 *  showing up as a plain "user" wall of text. */
function ReportBlock({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(!message.collapsed);
  const preview = (message.content.replace(/^#+\s*/, '').split('\n')[0] || '').slice(0, 90);
  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-line bg-panel">
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen((o) => !o)}>
        <ChevronDown size={13} className={`shrink-0 text-faint transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="font-semibold text-xs text-faint">{message.displayName}</span>
        {!open && preview && <span className="truncate text-[11.5px] text-faint">{preview}</span>}
        <span className="ml-auto shrink-0 text-[11px] text-faint">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && message.content && (
        <div className="markdown border-t border-line px-3 py-2 text-[13.5px] leading-relaxed">
          <Markdown>{message.content}</Markdown>
        </div>
      )}
    </div>
  );
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
                <div className="break-words text-[11px] text-mute border-l-2 border-accent/50 pl-2 mb-2 italic whitespace-pre-wrap">{m.reasoning}</div>
              )}
              {m.content && m.role !== 'tool' && (
                m.role === 'assistant'
                  ? <div className="markdown text-[12px] leading-relaxed"><Markdown>{m.content}</Markdown></div>
                  : <div className="break-words text-[12px] whitespace-pre-wrap">{m.content}</div>
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
/** High-precision secret shapes redacted from displayed tool output + ledger.
 *  Display-layer only: model context is untouched so code still executes. */
const SECRET_RES: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[bpas]-[A-Za-z0-9-]{10,}/g,
  /sk-ant-[A-Za-z0-9-_]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /eyJ[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{10,}/g,
];
const redactSecrets = (s: string): string => {
  let o = s ?? '';
  for (const re of SECRET_RES) {
    re.lastIndex = 0;
    o = o.replace(re, '[redacted]');
  }
  return o;
};

type LogEntry = { id: string; time: number; type: 'bash' | 'read' | 'write' | 'edit' | 'grep' | 'glob' | 'web' | 'todo' | 'error' | 'compact' | 'ask'; label: string; detail?: string; durationMs?: number };
type TodoItem = { content: string; status: 'pending' | 'in_progress' | 'completed' };
type PermTier = 'allow' | 'ask' | 'deny';
interface PermConfig { tools: Record<string, PermTier>; denyPaths: string[]; approvedCommands?: string[]; }
const DEFAULT_PERMS: PermConfig = { tools: {}, denyPaths: [] };
/** Tools that mutate the workspace or run code — gated by plan mode + permissions. */
const MUTATING_TOOLS = new Set(['write', 'edit', 'apply_patch', 'bash', 'git_commit', 'git_branch', 'git_worktree', 'subagent']);
/** Tool names the read-only scout and plan mode may use. */
const READONLY_TOOL_NAMES = new Set(['todo_write', 'read', 'grep', 'glob', 'ast_grep', 'web_fetch', 'web_search', 'git_diff', 'ask_user', 'bash_poll', 'delegate', 'repo_search']);

/** Binaries bash may run in plan mode (inspection only). */
const READONLY_BASH = new Set(['find', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'fd', 'file', 'stat', 'du', 'df', 'tree', 'pwd', 'which', 'uname', 'date', 'sort', 'uniq', 'diff', 'nl', 'basename', 'dirname', 'realpath', 'readlink', 'md5sum', 'sha256sum']);
/** Read-only git subcommands allowed in plan mode. */
const READONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'branch', 'tag', 'remote', 'blame', 'shortlog', 'describe', 'ls-files', 'rev-parse']);

/** True when a bash command is pure inspection (plan mode). Conservative:
 *  rejects shell composition (redirection, pipes, chaining, substitution)
 *  outright, then allow-lists the first word — and for git, the subcommand. */
function isReadOnlyCommand(cmd: string): boolean {
  if (!cmd) return false;
  if (/[>|;&`]|\$\(/.test(cmd)) return false;
  const words = cmd.split(/\s+/).filter(Boolean);
  const first = words[0].replace(/^.*\//, '');
  if (first === 'git') return words.length >= 2 && READONLY_GIT.has(words[1]);
  return READONLY_BASH.has(first);
}

/** Recover tool calls a model emitted as <tool_call> markup in plain text
 *  (the engine returns markup naming an undeclared tool instead of parsing
 *  it into native tool_calls). Handles both the JSON form and the
 *  <function=name><parameter=k>v</parameter> form. */
function parseMarkupToolCalls(text: string): AgentToolCall[] {
  const calls: AgentToolCall[] = [];
  for (const m of text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)) {
    const body = m[1].trim();
    let name = '';
    let args: Record<string, unknown> = {};
    if (/^\s*\{/.test(body)) {
      try {
        const j = JSON.parse(body);
        name = String(j.name ?? '');
        if (j.arguments && typeof j.arguments === 'object') args = j.arguments;
      } catch { /* fall through to the XML-ish form */ }
    }
    if (!name) {
      const fn = body.match(/<function=([\w.-]+)>/);
      if (!fn) continue;
      name = fn[1];
      for (const p of body.matchAll(/<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g)) args[p[1]] = p[2];
    }
    if (name) calls.push({ id: 'markup-' + crypto.randomUUID(), name, arguments: JSON.stringify(args) });
  }
  return calls;
}

/** Strip tool-call markup from reply text so it doesn't pollute the transcript. */
function stripToolMarkup(text: string): string {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
}
interface ConvMeta {
  /** Linked worktree path for this conversation, relative to the main workspace. */
  worktree?: string;
  /** Files/folders pinned from the Tree panel so the system prompt "follows" them. */
  boundPaths?: string[];
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
  ledger: LogEntry[];
  todos: TodoItem[];
  /** When this conversation's task list last changed (tool call or user
   *  edit) — persisted per conversation so switching never shows another
   *  conversation's "last updated" time. */
  todosUpdatedAt?: number;
  lastPromptTokens: number;
  archived?: boolean;
  checkpoints?: Checkpoint[];
}
/** A restore point: transcript/todo snapshot + the workspace commit to reset to. */
interface Checkpoint {
  id: string;
  time: number;
  label: string;
  commit: string;
  messages: number;
  ledger: number;
  todos: TodoItem[];
}
interface WsData {
  expanded: boolean;
  conversations: Record<string, ConvMeta>;
  order: string[];
  activeConv?: string;
  /** Per-workspace tool permission tiers + denied path prefixes. */
  perms?: PermConfig;
}
interface CoderStore {
  activeWs: string;
  activeConv: string;
  workspaces: Record<string, WsData>;
}

const CONV_KEY = 'ninfier.coder.conversations.v2';
const CONV_V1_KEY = 'ninfier.coder.conversations.v1';

function newConvId(): string {
  return 'conv-' + crypto.randomUUID();
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
function stripExtPrefix(p: string): string {
  let rest: string | null = null;
  for (const pre of ['\\\\?\\', '\\\\?/', '//?/']) {
    if (p.startsWith(pre)) { rest = p.slice(pre.length); break; }
  }
  if (rest === null) return p;
  for (const unc of ['UNC\\', 'UNC/']) {
    if (rest.startsWith(unc)) return '\\\\' + rest.slice(unc.length).replace(/\//g, '\\');
  }
  return rest;
}

/** Render the live task list as a system-prompt block. Injected into the
 *  supervisor's system prompt every turn so the plan (a) survives
 *  auto-compaction of the conversation and (b) reflects user edits made
 *  mid-run (added/removed/retasked items) on the very next LLM call. */
function todoSystemBlock(todos: TodoItem[]): string {
  const mark = (s: string) => (s === 'completed' ? 'x' : s === 'in_progress' ? '~' : ' ');
  // An empty list still gets a block, with an explicit marker: the
  // conversation (and any compaction summary) may still contain an older
  // non-empty list, so without this the next turn has no system-level
  // signal the plan is now empty and could resume stale work.
  const lines = todos.length
    ? todos.map((t, i) => `${i + 1}. [${mark(t.status)}] ${t.content}`)
    : ['(no active tasks — the task list was cleared; do not resume work from an earlier plan unless the user asks or re-adds a task)'];
  return `\n\n# Current task list (live — maintained by todo_write, editable by the user; keep it in sync with your actual progress)\n${lines.join('\n')}\n`;
}
function normalizeStore(s: CoderStore): CoderStore {
  const workspaces = { ...s.workspaces };
  // Windows migration: older builds stored the workspace key with Rust's
  // extended-length prefix (`\\?\\C:\tmp` from canonicalize) while the
  // picker produces the plain form — the mismatch made every start seed a
  // duplicate workspace with a fresh conversation. Merge prefixed entries
  // into their plain twin (deduped by conversation id).
  for (const [key, ws] of Object.entries(workspaces)) {
    const plain = stripExtPrefix(key);
    if (plain === key) continue;
    delete workspaces[key];
    const twin = workspaces[plain];
    if (!twin) {
      workspaces[plain] = ws;
      continue;
    }
    const merged: WsData = { ...twin, conversations: { ...twin.conversations }, order: [...twin.order], expanded: twin.expanded || ws.expanded };
    for (const [cid, conv] of Object.entries(ws.conversations)) {
      if (!merged.conversations[cid]) {
        merged.conversations[cid] = conv;
        merged.order.push(cid);
      }
    }
    merged.activeConv = twin.activeConv && merged.conversations[twin.activeConv] ? twin.activeConv : merged.order[0] ?? '';
    workspaces[plain] = merged;
  }
  let activeWs = stripExtPrefix(s.activeWs);
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

// ---- Verification gate helpers ------------------------------------------------
/** Detect lint/test/build commands: explicit config first, else infer from manifests. */
async function detectCommands(): Promise<{ lint?: string; test?: string; build?: string }> {
  try {
    const cfg = await getConfig();
    if (cfg.lintCommand || cfg.testCommand || cfg.buildCommand) {
      return { lint: cfg.lintCommand, test: cfg.testCommand, build: cfg.buildCommand };
    }
  } catch { /* ignore */ }
  const read = async (p: string): Promise<string | null> => {
    try { const r = await coderRead(p, 0, 200); return r.binary ? null : (r.content || null); } catch { return null; }
  };
  const pkg = await read('package.json');
  if (pkg) { try { const s = (JSON.parse(pkg).scripts) || {}; return { lint: s.lint, test: s.test, build: s.build }; } catch { /* not json */ } }
  const cargo = await read('Cargo.toml');
  if (cargo) return { build: 'cargo build', test: 'cargo test', lint: 'cargo clippy -- -D warnings' };
  const mk = await read('Makefile');
  if (mk) {
    const has = (t: string) => new RegExp(`^${t}:`, 'm').test(mk);
    return { lint: has('lint') ? 'make lint' : undefined, test: has('test') ? 'make test' : undefined, build: has('build') ? 'make build' : undefined };
  }
  const py = await read('pyproject.toml');
  if (py) return { test: 'pytest', lint: 'ruff check .' };
  return {};
}

/** Collapsible sidebar section: chevron toggles a bounded region so no single
 *  panel can push the rest of the sidebar out of view. */
function SidebarSection({
  title, icon, defaultOpen = false, children,
}: { title: string; icon?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-3">
      <button
        type="button"
        className="mb-1.5 flex w-full items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-faint hover:text-ink"
        onClick={() => setOpen((o) => !o)}
      >
        {icon}
        {title}
        <ChevronDown size={12} className={`ml-auto shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && children}
    </div>
  );
}

export function CoderScreen({ coderWs }: { coderWs: string }) {
  const [store, setStore] = useState<CoderStore>(loadStore);
  const storeRef = useRef(store);
  storeRef.current = store;

  const activeWs = store.activeWs;
  const activeConv = store.activeConv;
  const activeMeta = store.workspaces[activeWs]?.conversations[activeConv];
  /** Effective workspace directory: worktree if set, otherwise the main workspace root. */
  const activeWsDir = activeMeta?.worktree ? `${activeWs}/${activeMeta.worktree}` : activeWs;

  const initialMeta = activeMeta;
  const [messages, setMessages] = useState<ChatMessage[]>(initialMeta?.messages ?? []);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  // When the agent pauses via ask_user, this holds the question and the run halts
  // until the user answers (release blocker #5 — human-in-the-loop).
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const askRef = useRef<string | null>(null);
  const [ledger, setLedger] = useState<LogEntry[]>(initialMeta?.ledger ?? []);
  const [todos, setTodos] = useState<TodoItem[]>(initialMeta?.todos ?? []);
  /** When the task list last changed (tool call or user edit) — shown in the
   *  panel header. Per conversation (ConvMeta.todosUpdatedAt), so switching
   *  conversations can't leak another conversation's time into the header. */
  const [todosUpdatedAt, setTodosUpdatedAt] = useState<number | null>(initialMeta?.todosUpdatedAt ?? null);
  /** Mirror of `todos` for the run loop: the loop's closure sees stale state,
   *  so the per-turn system-prompt injection reads this ref instead. Kept in
   *  sync synchronously (applyTodos) — a useEffect sync alone lands one tick
   *  late, and handleToolCalls → runAgent can build the next request before
   *  effects run, which would send the previous list to the LLM. */
  const todosRef = useRef<TodoItem[]>(todos);
  useEffect(() => { todosRef.current = todos; }, [todos]);
  /** Bumped on every user edit of the list (add / cycle / remove / restore)
   *  — lets an in-flight todo_write tell its snapshot was generated from a
   *  stale list. */
  const todosRevRef = useRef(0);
  /** The revision captured when the current LLM request was built — its
   *  system prompt carried the list as of that moment. */
  const todosRevAtReqStartRef = useRef(0);
  /** Apply a new task list in the same tick: run-loop ref + state (+ optional
   *  header timestamp). */
  const applyTodos = (next: TodoItem[], ts?: number | null) => {
    todosRef.current = next;
    setTodos(next);
    if (ts !== undefined) setTodosUpdatedAt(ts);
  };
  /** User-side mutation: functional edit + revision bump + timestamp, all
   *  synchronous, so the next LLM call (even before a re-render) sees it. */
  const mutateTodos = (fn: (prev: TodoItem[]) => TodoItem[]) => {
    const next = fn(todosRef.current);
    todosRevRef.current += 1;
    todosRef.current = next;
    setTodos(next);
    setTodosUpdatedAt(Date.now());
  };
  const [todoDraft, setTodoDraft] = useState('');
  const [wsBusy, setWsBusy] = useState(false);
  // Re-pointed sidecar workspace + flush counter (see the workspace effect below);
  // declared early because the panel-reload effects depend on wsFlushed.
  const wsAppliedDirRef = useRef<string | null>(null);
  const [wsFlushed, setWsFlushed] = useState(0);
  // Serialized re-point queue (see the workspace effect below): a run awaits
  // this before its first sidecar tool call.
  const wsApplyQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [showDir, setShowDir] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerNodes, setPickerNodes] = useState<FileNode[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerExpanded, setPickerExpanded] = useState<Record<string, boolean>>({});
  const [pickerSelected, setPickerSelected] = useState<Record<string, boolean>>({});
  const [editingConv, setEditingConv] = useState<{ ws: string; cid: string } | null>(null);
  const [archivedOpen, setArchivedOpen] = useState<Record<string, boolean>>({});

  // File Tree panel — browse the workspace and pin files/folders so the system
  // prompt "follows" them (system-prompt follow binding).
  const [treeOpen, setTreeOpen] = useState(true);
  const [treeNodes, setTreeNodes] = useState<FileNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeExpanded, setTreeExpanded] = useState<Record<string, boolean>>({});
  const [treeChildren, setTreeChildren] = useState<Record<string, FileNode[]>>({});

  // Commit history of the active workspace (populated from `git log`).
  const [commits, setCommits] = useState<CoderCommit[]>([]);
  // Sampling params for the coder runs (persisted globally, not per workspace).
  interface CoderParams { thinking: boolean; thinkLevel?: 'low' | 'medium' | 'high' | 'xhigh'; temperature?: number; topP?: number; topK?: number; seed?: number; criticModel?: string; promptCache?: boolean; humanize?: boolean; voiceProfile?: string; reviewLens?: string; }
  const CODER_PARAMS_KEY = 'ninfier.coder.params';
  const DEFAULT_CODER_PARAMS: CoderParams = { thinking: true };
  const [coderParams, setCoderParams] = useState<CoderParams>(() => {
    try {
      const raw = localStorage.getItem(CODER_PARAMS_KEY);
      if (raw) return { ...DEFAULT_CODER_PARAMS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return { ...DEFAULT_CODER_PARAMS };
  });
  // Mirror of coderParams for closures with empty deps (e.g. refreshRepoMap) so
  // they read the latest humanize/voice setting without being recreated.
  const coderParamsRef = useRef(coderParams);
  coderParamsRef.current = coderParams;
  const [showCoderParams, setShowCoderParams] = useState(false);
  // Live LLM phase indicator: 'prefill' = request sent, no tokens back yet
  // (the long silent stretch on big contexts); 'decode' = tokens streaming.
  const [llmPhase, setLlmPhase] = useState<{ stage: 'prefill' | 'decode'; label: string; since: number; chars: number } | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    if (!llmPhase) return;
    const t = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(t);
  }, [llmPhase ? 1 : 0]);
  const [commitsOpen, setCommitsOpen] = useState(true);
  const [permsOpen, setPermsOpen] = useState(true);

  /** streamChat wrapper that drives the prefill/decode phase indicator. */
  const trackedStream = async (
    req: Record<string, unknown>,
    signal: AbortSignal,
    label: string,
    cb: ChatStreamCallbacks,
  ) => {
    setLlmPhase({ stage: 'prefill', label, since: Date.now(), chars: 0 });
    try {
      return await streamChat(req, signal, {
        ...cb,
        onContentDelta: (t) => {
          setLlmPhase((p) => (p ? { ...p, stage: 'decode', chars: p.chars + t.length } : p));
          cb.onContentDelta?.(t);
        },
        onReasoningDelta: (t) => {
          setLlmPhase((p) => (p ? { ...p, stage: 'decode', chars: p.chars + t.length } : p));
          cb.onReasoningDelta?.(t);
        },
        onDone: (m) => {
          setLlmPhase(null);
          cb.onDone?.(m);
        },
      });
    } catch (e) {
      setLlmPhase(null);
      throw e;
    }
  };
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [commitsLoading, setCommitsLoading] = useState(false);
  // Background shell jobs started by the agent (tracked per workspace so the
  // sidebar panel can poll + kill them without digging through the transcript).
  const [bgJobs, setBgJobs] = useState<{ id: string; command: string; ws: string }[]>([]);
  /** Live subagent runs (delegate / subagent / scout) for the Jobs panel. */
  const [activeSubs, setActiveSubs] = useState<{ id: string; label: string; task: string; since: number }[]>([]);
  const [subTick, setSubTick] = useState(Date.now());
  useEffect(() => {
    if (activeSubs.length === 0) return;
    const t = setInterval(() => setSubTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [activeSubs.length]);
  const [jobStatus, setJobStatus] = useState<Record<string, CoderJob>>({});
  const [jobsOpen, setJobsOpen] = useState(true);
  /** Poll unfinished jobs while the panel is open (3s cadence, stops when all done). */
  useEffect(() => {
    if (!jobsOpen) return;
    const pending = bgJobs.filter((j) => !(jobStatus[j.id]?.done ?? false));
    if (pending.length === 0) return;
    let cancelled = false;
    const poll = async () => {
      for (const j of pending) {
        try {
          const s = await coderJob(j.id);
          if (!cancelled) setJobStatus((prev) => ({ ...prev, [j.id]: s }));
        } catch { /* job expired server-side; leave last status */ }
      }
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [jobsOpen, bgJobs, activeWs, jobStatus]);

  // Coder "safe mode": the sidecar refuses clearly destructive shell commands
  // (release blocker #2). Surfaced as a toggle + warning banner.
  const [coderSafeMode, setCoderSafeMode] = useState(true);
  const toggleSafeMode = useCallback(async (next: boolean) => {
    setCoderSafeMode(next);
    try { await coderSafeModeSet(next); } catch { /* keep UI state as-is */ }
  }, []);
  const [coderSandbox, setCoderSandbox] = useState(false);
  const toggleSandbox = useCallback(async (next: boolean) => {
    setCoderSandbox(next);
    try { await coderSandboxSet(next); } catch { /* keep UI state as-is */ }
  }, []);
  // Commit approval gate: when ON, the agent may not commit without an explicit
  // human sign-off on the working-tree-vs-HEAD diff. Auto-commits on write/edit
  // are suppressed so the only commits are intentional, reviewed ones.
  const [commitApproval, setCommitApproval] = useState(false);
  // Diff-review viewer (opened from the toolbar "Diff" button).
  const [diffViewOpen, setDiffViewOpen] = useState(false);
  /** Per-file diff (opened from a file tab's Diff button). */
  const [fileDiffPath, setFileDiffPath] = useState<string | null>(null);
  // Commit-approval pending dialog (the agent asked to commit while the gate is ON).
  const [commitReviewOpen, setCommitReviewOpen] = useState(false);
  const commitResolveRef = useRef<((ok: boolean) => void) | null>(null);
  /** Pause the agent loop and show the diff for human sign-off. Resolves true=approve. */
  const requestCommitApproval = (): Promise<boolean> => {
    setCommitReviewOpen(true);
    return new Promise<boolean>((resolve) => {
      commitResolveRef.current = (ok: boolean) => {
        commitResolveRef.current = null;
        setCommitReviewOpen(false);
        resolve(ok);
      };
    });
  };
  // Plan mode: read-only agent (no mutating tools), toggled per run.
  const [planMode, setPlanMode] = useState(false);
  // Read-only scout pre-pass (auto, concurrency-gated — see runAgent). Opt-in:
  // no harness mode runs unless the user turns it on.
  const [scoutOn, setScoutOn] = useState(false);
  const [verifyMode, setVerifyMode] = useState(false);
  // Critic gate: after edits, a (possibly different) model reviews the working-tree
  // diff and can bounce it back for fixes before the run is allowed to finish.
  const [criticMode, setCriticMode] = useState(false);
  // A tool call awaiting the user's approve/deny decision (permission tier `ask`).
  const [pendingApproval, setPendingApproval] = useState<{ name: string; detail: string } | null>(null);
  const approvalResolveRef = useRef<((ok: boolean) => void) | null>(null);
  // Optional free-form note the human can attach to an ask_user decision.
  const [askNote, setAskNote] = useState('');
  // Cached AGENTS.md conventions for the active workspace (refreshed by refreshRepoMap).
  const conventionsRef = useRef<string>('');

  // Workspace-switch synchronization (shared by the Tree panel and the memory
  // panel): both fetch RELATIVE to the control plane's *configured* workspace,
  // which setCoderWorkspace() re-points asynchronously. A response that lands
  // before the switch is confirmed belongs to the PREVIOUS workspace — so each
  // panel applies a response only if (a) it is the newest fetch (seq refs) and
  // (b) the control was confirmed at that workspace by then (wsAppliedDirRef.current,
  // set in the setCoderWorkspace success handler below, which also bumps
  // wsFlushed to trigger the confirmed reload).
  const treeSeqRef = useRef(0);
  const memSeqRef = useRef(0);

  // Self-improving memory (Hybrid A+B). Persisted OUTSIDE the repo by the sidecar
  // under its data dir, so it is never committed by accident. The agent sees it
  // only via system-prompt injection (memoryRef) — it can't read it as a file.
  const [memory, setMemory] = useState<CoderMemory>({ bank: '', learnings: [] });
  const memoryRef = useRef<CoderMemory>({ bank: '', learnings: [] });
  // Memory modal open state.
  const [memOpen, setMemOpen] = useState(false);
  // Generation counters for the sidecar-relative panel fetches (commits panel —
  // the tree/memory seq refs live in the shared block above).
  const commitsSeqRef = useRef(0);
  // Pull the bank + learnings for the active workspace; called on workspace change
  // and after the critic / memory_update writes new learnings.
  const loadMemory = useCallback(async () => {
    if (!activeWsDir) return;
    const seq = ++memSeqRef.current;
    try {
      const m = await coderMemoryGet();
      // Same switch race as the tree: only adopt the newest response, and
      // only once the control is confirmed at this workspace — otherwise a
      // pre-switch response would land in memoryRef and leak the OTHER
      // workspace's bank into this workspace's system prompt.
      if (seq === memSeqRef.current && wsAppliedDirRef.current === activeWsDir) {
        setMemory(m);
        memoryRef.current = m;
      }
    } catch {
      // memory is best-effort; keep the last good value rather than wiping UI.
    }
  }, [activeWsDir]);

  const loadCommits = useCallback(async () => {
    const seq = ++commitsSeqRef.current;
    setCommitsLoading(true);
    try {
      const commits = await coderGitLog(100);
      if (seq !== commitsSeqRef.current) return; // a newer workspace/flush generation won
      setCommits(commits);
    } catch {
      // Keep the last good list rather than wiping it on a transient sidecar
      // blip (M2). An empty workspace simply shows no commits.
    } finally {
      if (seq === commitsSeqRef.current) setCommitsLoading(false);
    }
  }, []);
  /** One-click revert: creates a new commit undoing `hash` (safe — itself revertable). */
  const revertCommit = useCallback(async (hash: string) => {
    if (running || !activeWsDir) return;
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) return;
    addLog({ type: 'bash', label: 'revert', detail: hash.slice(0, 7) });
    try {
      const r = await coderExec(`git revert --no-edit ${hash}`, undefined, 30000, activeWsDir);
      if (r.exitCode !== 0) {
        addLog({ type: 'error', label: 'revert', detail: (r.stderr || r.stdout || 'revert failed').slice(0, 300) });
      }
    } catch (e) {
      addLog({ type: 'error', label: 'revert', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      loadCommits();
    }
  }, [running, activeWs, loadCommits]);

  // Refresh the commit history whenever the active workspace changes (or the
  // sidecar re-point is flushed after a held mid-run switch — wsFlushed).
  useEffect(() => {
    if (activeWsDir) loadCommits();
  }, [activeWsDir, wsFlushed, loadCommits]);

  // Refresh the self-improving memory whenever the active workspace changes —
  // and again once the control is confirmed at it (wsFlushed), the only point
  // at which the relative fetch is guaranteed to hit this workspace's store.
  useEffect(() => {
    if (activeWsDir) void loadMemory();
  }, [activeWsDir, wsFlushed, loadMemory]);

  // Sync the safe-mode toggle with the sidecar's current state on mount.
  useEffect(() => {
    coderSafeModeGet()
      .then((r) => setCoderSafeMode(r.enabled))
      .catch(() => { /* leave default true */ });
  }, []);

  // The conversation an in-flight run is pinned to. Set at run start so that
  // switching conversations/workspaces mid-run is a pure VIEW change: the run
  // keeps appending to ITS conversation (in the store), and the visible
  // transcript only mirrors the update while that conversation is on screen.
  // Without this, a mid-run switch would write the live transcript into the
  // conversation the user switched to — the corruption P0 #2 guarded against.
  const runConvRef = useRef<{ ws: string; convId: string } | null>(null);
  // State mirror of the ref for the UI (drives the "running" marker below).
  const [runConv, setRunConvState] = useState<{ ws: string; convId: string } | null>(null);
  /** Pin/unpin the in-flight run's transcript target. */
  const setRunConv = (pin: { ws: string; convId: string } | null) => {
    runConvRef.current = pin;
    setRunConvState(pin);
  };
  // Where a paused run (ask_user) was pinned, so the answer resumes the right
  // conversation even if the user has since switched elsewhere.
  const askConvRef = useRef<{ ws: string; convId: string } | null>(null);

  const lastPromptTokensRef = useRef<number>(initialMeta?.lastPromptTokens ?? 0);
  // The IN-FLIGHT RUN's token accounting, pinned separately from the visible
  // meter (lastPromptTokensRef): switching to another conversation mid-run
  // overwrites the meter with that conversation's count, which must not feed
  // the run's compaction threshold. The meter only mirrors the run's count
  // while the run's conversation is on screen.
  const runTokensRef = useRef<number>(initialMeta?.lastPromptTokens ?? 0);
  /** Record the run's prompt-token count; mirrors to the visible meter only while the run's conversation is on screen. */
  const noteRunTokens = (t: number) => {
    runTokensRef.current = t;
    const pin = runConvRef.current;
    if (pin && pin.ws === storeRef.current.activeWs && pin.convId === storeRef.current.activeConv) {
      lastPromptTokensRef.current = t;
    }
  };
  // Visible mirrors of the ref above + the engine context window + the agent
  // step counter, so the header can show live context usage (release #3).
  const [ctxTokens, setCtxTokens] = useState<number>(initialMeta?.lastPromptTokens ?? 0);
  const [ctxLimit, setCtxLimit] = useState<number | null>(null);
  const [agentSteps, setAgentSteps] = useState(0);
  // The ref updates inside stream callbacks (no re-render); mirror it into
  // state whenever the transcript changes so the meter stays live.
  useEffect(() => { setCtxTokens(lastPromptTokensRef.current); }, [messages]);
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
    applyTodos(m.todos ?? [], m.todosUpdatedAt ?? null);
  };

  /** Apply a transcript update to the conversation the in-flight run is pinned
   *  to. Persists to the store even when that conversation is NOT on screen
   *  (so switching back shows the live transcript); mirrors to the visible
   *  transcript only while it is on screen. */
  const updateRunMessages = (fn: (prev: ChatMessage[]) => ChatMessage[]) => {
    const pin = runConvRef.current;
    if (!pin) return;
    setStore((prev) => {
      const wsd = prev.workspaces[pin.ws];
      const meta = wsd?.conversations[pin.convId];
      if (!wsd || !meta) return prev;
      return {
        ...prev,
        workspaces: { ...prev.workspaces, [pin.ws]: { ...wsd, conversations: { ...wsd.conversations, [pin.convId]: { ...meta, messages: fn(meta.messages ?? []), lastPromptTokens: runTokensRef.current, updatedAt: Date.now() } } } },
      };
    });
    if (pin.ws === storeRef.current.activeWs && pin.convId === storeRef.current.activeConv) setMessages(fn);
  };
  /** Same pinning for todo_write: the run's todos stay in the run's conversation. */
  /** `ts` (from #5's todosUpdatedAt): persisted into the run conversation's
   *  meta (so switching back shows the right "last updated"), mirrored to the
   *  header only while that conversation is on screen. */
  const updateRunTodos = (next: TodoItem[], ts?: number) => {
    const pin = runConvRef.current;
    if (!pin) { setTodos(next); if (ts != null) setTodosUpdatedAt(ts); return; }
    setStore((prev) => {
      const wsd = prev.workspaces[pin.ws];
      const meta = wsd?.conversations[pin.convId];
      if (!wsd || !meta) return prev;
      return {
        ...prev,
        workspaces: { ...prev.workspaces, [pin.ws]: { ...wsd, conversations: { ...wsd.conversations, [pin.convId]: { ...meta, todos: next, todosUpdatedAt: ts, updatedAt: Date.now() } } } },
      };
    });
    if (pin.ws === storeRef.current.activeWs && pin.convId === storeRef.current.activeConv) { setTodos(next); if (ts != null) setTodosUpdatedAt(ts); }
  };

  // Persist the active conversation's live state back into the store.
  useEffect(() => {
    if (!activeWs || !activeConv) return;
    // Don't clobber a loaded conversation with a transient empty transcript
    // (e.g. the initial [] before loadConv populates messages) — L1.
    const existing = storeRef.current.workspaces[activeWs]?.conversations[activeConv];
    if (messages.length === 0 && existing && (existing.messages?.length ?? 0) > 0) return;
    setStore((prev) => {
      const wsd = prev.workspaces[activeWs];
      if (!wsd) return prev;
      const meta = wsd.conversations[activeConv];
      const firstUser = messages.find((m) => m.role === 'user' && !isCompactedMsg(m));
      const title = firstUser
        ? firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 48) || (meta?.title ?? 'New conversation')
        : (meta?.title ?? 'New conversation');
      const base = meta ?? { id: activeConv, title: 'New conversation', updatedAt: Date.now(), messages: [], ledger: [], todos: [], lastPromptTokens: 0 };
      const updated: ConvMeta = { ...base, id: activeConv, title, updatedAt: Date.now(), messages, ledger, todos, todosUpdatedAt: todosUpdatedAt ?? undefined, lastPromptTokens: lastPromptTokensRef.current, checkpoints: meta?.checkpoints ?? [] };
      const order = wsd.order.includes(activeConv) ? wsd.order : [...wsd.order, activeConv];
      return {
        ...prev,
        workspaces: { ...prev.workspaces, [activeWs]: { ...wsd, conversations: { ...wsd.conversations, [activeConv]: updated }, order } },
      };
    });
  }, [messages, ledger, todos, todosUpdatedAt, activeWs, activeConv]);

  // Keep the sidecar's coder workspace pointed at the active workspace — but
  // HOLD the re-point while a run is in flight: every agent tool call resolves
  // against the sidecar's configured workspace, so re-pointing mid-run would
  // send the running agent's edits/commits to the repo the user just switched
  // to. When the run ends the re-point fires (running flips in the deps) and
  // the panel reloads below pick it up via wsFlushed.
  //
  // Re-points are SERIALIZED (each chained after the previous) so rapid
  // A→B→A switches can't interleave, and only the LATEST request commits
  // wsAppliedDirRef/wsFlushed — a stale response from an older switch can't
  // clobber the applied workspace. runAgent awaits this queue before its
  // first sidecar tool call, so an in-flight re-point settles before the run
  // starts rather than landing mid-run.
  const wsApplySeqRef = useRef(0);
  const wsApplyPendingRef = useRef(false);
  /** Enqueue a sidecar re-point (serialized; only the latest request commits
   *  wsAppliedDirRef/wsFlushed). Called by the effect below AND directly by
   *  the ask-resume paths — their setStore-driven effect would otherwise
   *  enqueue the re-point only after runAgent already passed its queue await,
   *  i.e. mid-run. */
  const queueWorkspaceApply = (dir: string) => {
    if (wsAppliedDirRef.current === dir && !wsApplyPendingRef.current) return;
    const seq = ++wsApplySeqRef.current;
    wsApplyPendingRef.current = true;
    setWsBusy(true);
    const task = wsApplyQueueRef.current
      .catch(() => undefined) // a previous failure must not clog the queue
      .then(() => setCoderWorkspace(dir))
      .catch((e) => console.warn('Failed to set coder workspace on sidecar:', e))
      .then(() => {
        // Only the LATEST request may commit — a stale response from an older
        // workspace switch would otherwise leave wsAppliedDirRef pointing at
        // a workspace the sidecar is no longer on.
        if (seq === wsApplySeqRef.current) {
          wsAppliedDirRef.current = dir;
          setWsFlushed((n) => n + 1);
        }
      })
      .finally(() => { wsApplyPendingRef.current = false; setWsBusy(false); });
    wsApplyQueueRef.current = task;
  };
  useEffect(() => {
    if (!activeWsDir) return;
    // Held until the run finishes — wsBusy stays false so the user can still
    // switch/add workspaces (those re-points just queue behind the run).
    if (running) { setWsBusy(false); return; }
    queueWorkspaceApply(activeWsDir);
  }, [activeWsDir, running]);
  // True while the view is on a different workspace than the one the sidecar
  // is still pointed at (a re-point held by an in-flight run).
  const wsHeld = running && wsAppliedDirRef.current !== null && wsAppliedDirRef.current !== activeWsDir;

  // Seed the default workspace from the sidecar once its path is known.
  const seeded = useRef(false);
  useEffect(() => {
    if (!coderWs || seeded.current) return;
    seeded.current = true;
    // Remount (screen switch or app restart) with a persisted workspace:
    // restore the last active conversation instead of presenting an empty
    // transcript — the store survives, so the visible state must too.
    const existing = storeRef.current.workspaces[coderWs];
    if (existing) {
      const convId = existing.activeConv ?? existing.order[existing.order.length - 1];
      if (convId && existing.conversations[convId]) {
        setStore((prev) => ({ ...prev, activeWs: coderWs, activeConv: convId }));
        loadConv(coderWs, convId);
      } else {
        setMessages([]);
        setLedger([]);
        applyTodos([], null);
        lastPromptTokensRef.current = 0;
      }
      return;
    }
    setStore((prev) => {
      if (prev.workspaces[coderWs]) return prev;
      const id = newConvId();
      const ws: WsData = { expanded: true, conversations: { [id]: emptyConv(id) }, order: [id], activeConv: id };
      return { ...prev, activeWs: coderWs, activeConv: id, workspaces: { ...prev.workspaces, [coderWs]: ws } };
    });
    setMessages([]);
    setLedger([]);
    applyTodos([], null);
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
    applyTodos([], null);
    lastPromptTokensRef.current = 0;
  };
  /** Fork the active conversation: duplicate its transcript into a new thread. */
  const forkConversation = () => {
    if (running || !activeWs || !activeConv) return;
    const src = storeRef.current.workspaces[activeWs]?.conversations[activeConv];
    if (!src) return;
    const id = newConvId();
    const copy: ConvMeta = {
      ...src,
      id,
      title: `${src.title || 'Conversation'} (fork)`,
      updatedAt: Date.now(),
      messages: src.messages.map((m) => ({ ...m })),
      ledger: src.ledger.map((l) => ({ ...l })),
      todos: src.todos.map((t) => ({ ...t })),
    };
    setStore((prev) => {
      const wsd = prev.workspaces[activeWs];
      if (!wsd) return prev;
      const at = wsd.order.indexOf(activeConv);
      const order = [...wsd.order];
      order.splice(at < 0 ? order.length : at + 1, 0, id);
      return {
        ...prev,
        activeConv: id,
        workspaces: { ...prev.workspaces, [activeWs]: { ...wsd, conversations: { ...wsd.conversations, [id]: copy }, order, activeConv: id } },
      };
    });
    loadConv(activeWs, id);
  };
  /** Export the active transcript as Markdown (download). Secrets stay redacted. */
  const exportTranscript = () => {
    const meta = storeRef.current.workspaces[activeWs]?.conversations[activeConv];
    if (!meta || meta.messages.length === 0) return;
    const parts: string[] = [`# ${meta.title || 'Conversation'}`, '', `_Workspace: ${activeWs}_`, ''];
    for (const m of meta.messages) {
      if (m.role === 'user' && !isCompactedMsg(m)) parts.push(`## user\n\n${m.content}`);
      else if (m.role === 'assistant') {
        parts.push(`## assistant${m.model ? ` (${m.model})` : ''}\n`);
        if (m.reasoning) parts.push(`<details><summary>thinking</summary>\n\n${m.reasoning}\n\n</details>`);
        if (m.content) parts.push(m.content);
        for (const tc of m.tool_calls ?? []) parts.push(`- tool \`${tc.name}\` \`${tc.arguments.slice(0, 300)}\``);
      } else if (m.role === 'tool') parts.push(`- result \`${m.name ?? ''}\`:\n\n\`\`\`\n${redactSecrets(m.content).slice(0, 4000)}\n\`\`\``);
      parts.push('');
    }
    const blob = new Blob([parts.join('\n')], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(meta.title || 'conversation').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'conversation'}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  const handleSelectConv = (ws: string, convId: string) => {
    // Switching is a pure view change even mid-run: the in-flight run is pinned
    // to its own conversation (runConvRef) and keeps persisting there, so the
    // visible transcript can follow the user without corruption (P0 #2).
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
      applyTodos([], null);
      lastPromptTokensRef.current = 0;
    }
  };
  const handleRemoveWorkspace = (path: string) => {
    // A workspace hosting the in-flight (or paused, ask_user) run's
    // conversation can't go away while its transcript is being written into it.
    if ((runConvRef.current ?? askConvRef.current)?.ws === path) return;
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
      applyTodos([], null);
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
    // Hiding the conversation an in-flight (or paused, ask_user) run is pinned
    // to would strand its live transcript; restoring it is always fine.
    if (archived && (runConvRef.current ?? askConvRef.current)?.ws === ws && (runConvRef.current ?? askConvRef.current)?.convId === cid) return;
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
        applyTodos([], null);
        lastPromptTokensRef.current = 0;
      }
    }
  };

  const handleDeleteConv = (ws: string, cid: string) => {
    if ((runConvRef.current ?? askConvRef.current)?.ws === ws && (runConvRef.current ?? askConvRef.current)?.convId === cid) return; // pinned by the in-flight / paused run
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
        applyTodos([], null);
        lastPromptTokensRef.current = 0;
      }
    }
  };
  const abortRef = useRef<AbortController | null>(null);
  const modelRef = useRef<string>('qwen-coder');
  /** Lint/test/build commands resolved once per run (config, else manifest
   *  detection) — cached PER WORKSPACE: the cache is neither keyed nor reset
   *  by activeWsDir, so a save-lint in workspace B must not execute the
   *  relative lint/build command detected in workspace A. */
  const detectedCmdsByWsRef = useRef(new Map<string, { lint?: string; test?: string; build?: string }>());

  const addLog = (entry: Omit<LogEntry, 'id' | 'time'>) => {
    const safe = entry.detail ? { ...entry, detail: redactSecrets(entry.detail) } : entry;
    // Run logs belong to the conversation the run is pinned to, not whatever
    // the user is currently viewing; the ledger only mirrors the view. The
    // fallback reads storeRef (not the captured activeWs/activeConv) because
    // long-lived closures (e.g. refreshRepoMap) hold an old render's values.
    const target = runConvRef.current ?? { ws: storeRef.current.activeWs, convId: storeRef.current.activeConv };
    const rec: LogEntry = { ...safe, id: crypto.randomUUID(), time: Date.now() };
    setStore((prev) => {
      const wsd = prev.workspaces[target.ws];
      const meta = wsd?.conversations[target.convId];
      if (!wsd || !meta) return prev;
      return {
        ...prev,
        workspaces: { ...prev.workspaces, [target.ws]: { ...wsd, conversations: { ...wsd.conversations, [target.convId]: { ...meta, ledger: [...(meta.ledger ?? []).slice(-999), rec], updatedAt: Date.now() } } } },
      };
    });
    if (target.ws === storeRef.current.activeWs && target.convId === storeRef.current.activeConv) setLedger((prev) => [...prev.slice(-999), rec]);
  };

  // ---- Todos: user actions (the panel is no longer read-only). Edits take
  // effect on the agent's next LLM call via the per-turn system-prompt
  // injection (todoSystemBlock + todosRef), so the human can retask, drop a
  // spinning step, or add work mid-run without waiting for the next agent
  // todo_write. User edits persist with the conversation (todos in ConvMeta).
  const addTodo = (raw: string) => {
    const content = raw.trim();
    if (!content) return;
    mutateTodos((prev) => [...prev, { content, status: 'pending' }]);
    addLog({ type: 'todo', label: 'manual', detail: `added task: ${content.slice(0, 60)}` });
  };
  const cycleTodo = (i: number) => {
    mutateTodos((prev) => prev.map((t, j) => (j === i ? { ...t, status: t.status === 'pending' ? 'in_progress' : t.status === 'in_progress' ? 'completed' : 'pending' } : t)));
  };
  const removeTodo = (i: number) => {
    mutateTodos((prev) => prev.filter((_, j) => j !== i));
    addLog({ type: 'todo', label: 'manual', detail: 'removed a task' });
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
    // Project conventions: AGENTS.md preferred, CLAUDE.md fallback — refreshed
    let convName = '';
    try {
      let name = 'AGENTS.md';
      let conv = await coderRead(name);
      if (conv.binary || !conv.content?.trim()) { name = 'CLAUDE.md'; conv = await coderRead(name); }
      const txt = (!conv.binary && conv.content ? conv.content : '').slice(0, 8000);
      if (txt.trim() && txt !== conventionsRef.current) {
        conventionsRef.current = txt;
        addLog({ type: 'read', label: 'conventions', detail: `${name} (${txt.length} chars)` });
      } else if (!txt.trim()) {
        conventionsRef.current = '';
      }
      if (conventionsRef.current.trim()) convName = name;
    } catch {
      conventionsRef.current = '';
    }
    if (conventionsRef.current.trim()) {
      sys += `\n\n# Project Conventions (from ${convName || 'workspace memory file'} — follow these)\n${conventionsRef.current}\n`;
    }
    // Skills-lite: workspace `skills/*/SKILL.md` index. Only names + first-line
    // descriptions are injected; the model reads a skill file via `read` when
    // relevant. Refreshed each run, capped to bound context usage.
    try {
      const g = await coderGlob('skills/*/SKILL.md');
      const files = (g.files ?? []).slice(0, 20);
      const lines: string[] = [];
      for (const f of files) {
        try {
          const s = await coderRead(f, 0, 30);
          if (s.binary || !s.content) continue;
          const ls = s.content.split('\n').map((x) => x.trim()).filter(Boolean);
          const title = (ls[0] ?? f).replace(/^#\s*/, '').slice(0, 80);
          const desc = (ls[1] ?? '').slice(0, 160);
          lines.push(`- ${f}: ${title}${desc ? ` — ${desc}` : ''}`);
        } catch { /* skip unreadable skill */ }
      }
      if (lines.length > 0) {
        sys += `\n\n# Skills (read the SKILL.md with the read tool when its trigger matches)\n${lines.join('\n').slice(0, 4000)}\n`;
        addLog({ type: 'read', label: 'skills', detail: `${lines.length} skill(s)` });
      }
    } catch { /* no skills dir */ }
    // System-prompt "follow" bindings: files/folders pinned from the Tree panel.
    // The system prompt follows the user's selection, re-read fresh each run so
    // edits to followed files surface in the agent's context automatically.
    try {
      // Followed paths belong to the conversation the run is pinned to, not
      // the one on screen (a mid-run switch is a view change only) — otherwise
      // a mutation in the still-running conversation could inject ANOTHER
      // conversation's bound paths into its next prompt.
      const pin = runConvRef.current;
      const tWs = pin?.ws ?? storeRef.current.activeWs;
      const tConv = pin?.convId ?? storeRef.current.activeConv;
      const bps = storeRef.current.workspaces[tWs]?.conversations[tConv]?.boundPaths ?? [];
      if (bps.length) {
        const followed: string[] = [
          '\n\n# Followed files (system prompt follows these — pinned context for every turn)',
        ];
        const seen = new Set<string>();
        let used = 0;
        const CAP = 20000;
        for (const p of bps) {
          if (used > CAP || seen.has(p)) continue;
          seen.add(p);
          try {
            const r = await coderRead(p, 0, 300);
            if (!r.binary && r.content && r.content.length) {
              const body = r.content.length > 4000 ? r.content.slice(0, 4000) + '\n…(truncated to 4000 chars)' : r.content;
              followed.push(`## ${p}\n\`\`\`\n${body}\n\`\`\``);
              used += body.length;
            } else if (r.binary) {
              followed.push(`- ${p} (binary — omitted)`);
            } else {
              // No readable file content → treat as a directory and list its files (bounded).
              let files: string[] = [];
              try { files = (await coderGlob(`${p}/**`)).files ?? []; } catch { /* ignore */ }
              files = files.slice(0, 200);
              followed.push(`## ${p}/ (directory — ${files.length} file(s) listed)\n${files.map((f) => `- ${f}`).join('\n')}`);
              used += files.join('\n').length;
            }
          } catch {
            followed.push(`- ${p} (unreadable)`);
          }
        }
        if (followed.length > 1) sys += followed.join('\n');
      }
    } catch { /* never break system-prompt assembly over follow-bindings */ }

    // Self-improving memory (Hybrid A+B): inject the per-repo bank + the most
    // recent learnings so the agent starts each run informed by past sessions.
    // The bank is authored/edited by the user (Memory modal) and the learnings
    // are extracted by the critic and the memory_update tool — the model never
    // sees these as ordinary files, only as injected context here.
    try {
      const mem = memoryRef.current;
      const blocks: string[] = [];
      if (mem.bank && mem.bank.trim()) {
        blocks.push(`# Repository Memory Bank\n${mem.bank.trim()}`);
      }
      const recent = (mem.learnings ?? []).slice(-15);
      if (recent.length) {
        const tagged = recent
          .map((l) => `- [${l.kind}${l.task ? ` · ${l.task}` : ''}] ${l.text}`)
          .join('\n');
        blocks.push(`# Learnings from prior runs (most recent first)\n${tagged}`);
      }
      if (blocks.length) {
        sys += `\n\n${blocks.join('\n\n')}\n`;
      }
    } catch { /* memory injection must never break system-prompt assembly */ }

    // Not-Ai humanize: when enabled, append the editorial contract (plus the
    // chosen voice profile) so the agent's user-facing prose avoids em dashes,
    // buzzwords, and empty framing. The deterministic gate is applied separately
    // to content-only assistant replies.
    if (coderParamsRef.current.humanize) {
      const voice = voiceSnippet(coderParamsRef.current.voiceProfile || 'technical');
      sys += `\n\n# Humanize replies (Not-Ai)\n${NOT_AI_CONTRACT}${voice ? `\n\n${voice}` : ''}\n`;
    }

    // Not-Ai humanize: when enabled, append the editorial contract (plus the
    // chosen voice profile) so the agent's user-facing prose avoids em dashes,
    // buzzwords, and empty framing. The deterministic gate is applied separately
    // to content-only assistant replies.
    if (coderParamsRef.current.humanize) {
      const voice = voiceSnippet(coderParamsRef.current.voiceProfile || 'technical');
      sys += `\n\n# Humanize replies (Not-Ai)\n${NOT_AI_CONTRACT}${voice ? `\n\n${voice}` : ''}\n`;
    }

    // Review lens: inject a distilled coding-review discipline (e.g. the Linus
    // Torvalds method) into the system prompt. The full method is too large to
    // inline every turn, so only the compact distillation is injected here; the
    // complete catalog can live in the workspace `skills/` dir (auto-indexed).
    const lensBlock = coderLensBlock(coderParamsRef.current.reviewLens);
    if (lensBlock) sys += `\n\n# Review lens\n${lensBlock}\n`;

    dynamicSystemRef.current = sys;
  }, []);

  // ---- File Tree panel: browse + system-prompt follow bindings ----
  // See the wsAppliedDirRef/treeSeqRef note above — a tree response only applies
  // if it is the newest fetch and the control is confirmed at this workspace.
  const loadTree = useCallback(async () => {
    if (!activeWsDir) return;
    const seq = ++treeSeqRef.current;
    setTreeLoading(true);
    try {
      const t = await coderTree(6, '.');
      if (seq === treeSeqRef.current && wsAppliedDirRef.current === activeWsDir) {
        setTreeNodes(t.nodes ?? []);
      }
    } catch { if (seq === treeSeqRef.current) setTreeNodes([]); }
    finally { if (seq === treeSeqRef.current) setTreeLoading(false); }
  }, [activeWsDir]);

  const onExpandDir = useCallback(async (node: FileNode) => {
    const willOpen = !treeExpanded[node.path];
    setTreeExpanded((e) => ({ ...e, [node.path]: willOpen }));
    if (willOpen && !(treeChildren[node.path] ?? node.children)) {
      try {
        const t = await coderTree(6, node.path);
        setTreeChildren((prev) => ({ ...prev, [node.path]: t.nodes ?? [] }));
      } catch { /* ignore — leave unexpanded */ }
    }
  }, [treeExpanded, treeChildren]);

  const toggleBind = useCallback((path: string) => {
    if (!activeWs || !activeConv) return;
    setStore((prev) => {
      const wsd = prev.workspaces[activeWs];
      const c = wsd?.conversations[activeConv];
      if (!wsd || !c) return prev;
      const cur = c.boundPaths ?? [];
      const next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path];
      return { ...prev, workspaces: { ...prev.workspaces, [activeWs]: { ...wsd, conversations: { ...wsd.conversations, [activeConv]: { ...c, boundPaths: next } } } } };
    });
    void refreshRepoMap();
  }, [activeWs, activeConv, refreshRepoMap]);

  const clearBinds = useCallback(() => {
    if (!activeWs || !activeConv) return;
    setStore((prev) => {
      const wsd = prev.workspaces[activeWs];
      const c = wsd?.conversations[activeConv];
      if (!wsd || !c) return prev;
      return { ...prev, workspaces: { ...prev.workspaces, [activeWs]: { ...wsd, conversations: { ...wsd.conversations, [activeConv]: { ...c, boundPaths: [] } } } } };
    });
    void refreshRepoMap();
  }, [activeWs, activeConv, refreshRepoMap]);

  // Load/refresh the tree whenever the active (possibly worktree-bound) directory
  // changes, or the sidecar re-point is flushed after a held mid-run switch
  // (#11's wsFlushed — the merged successor of #8's wsSynced counter).
  useEffect(() => { if (treeOpen) void loadTree(); }, [activeWsDir, wsFlushed, treeOpen, loadTree]);
  /** Undo the last commit (soft reset — changes stay in the worktree). Recoverable via reflog. */
  const undoLastCommit = useCallback(async () => {
    if (running || !activeWsDir || commits.length === 0) return;
    const top = commits[0];
    if (!window.confirm(`Undo commit ${top.hash.slice(0, 7)} "${top.subject}"?\n\nChanges stay in the worktree (git reset --soft).`)) return;
    addLog({ type: 'bash', label: 'undo', detail: top.hash.slice(0, 7) });
    try {
      const r = await coderExec('git reset --soft HEAD~1', undefined, 30000, activeWsDir);
      if (r.exitCode !== 0) {
        addLog({ type: 'error', label: 'undo', detail: (r.stderr || r.stdout || 'undo failed').slice(0, 300) });
      }
    } catch (e) {
      addLog({ type: 'error', label: 'undo', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      loadCommits();
      refreshRepoMap();
    }
  }, [running, activeWsDir, commits, loadCommits, refreshRepoMap]);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const checkpoints: Checkpoint[] = store.workspaces[activeWs]?.conversations[activeConv]?.checkpoints ?? [];
  /** Snapshot the transcript/todos plus the workspace HEAD (transcript-only outside git). */
  const createCheckpoint = async () => {
    if (!activeWs || !activeConv) return;
    let commit = '';
    try {
      const r = await coderExec('git rev-parse HEAD', undefined, 10000, activeWsDir);
      if (r.exitCode === 0 && /^[0-9a-f]{5,40}$/i.test((r.stdout || '').trim())) commit = (r.stdout || '').trim();
    } catch { /* not a git repo — transcript-only checkpoint */ }
    const cp: Checkpoint = {
      id: 'cp-' + crypto.randomUUID(),
      time: Date.now(), label: commit ? commit.slice(0, 7) : 'transcript',
      commit, messages: messages.length, ledger: ledger.length, todos,
    };
    setStore((prev) => {
      const wsd = prev.workspaces[activeWs];
      const meta = wsd?.conversations[activeConv];
      if (!wsd || !meta) return prev;
      const next = { ...meta, checkpoints: [...(meta.checkpoints ?? []), cp] };
      return { ...prev, workspaces: { ...prev.workspaces, [activeWs]: { ...wsd, conversations: { ...wsd.conversations, [activeConv]: next } } } };
    });
    addLog({ type: 'compact', label: 'checkpoint', detail: `saved (${cp.messages} msgs${commit ? ` @ ${cp.label}` : ', no git repo'})` });
    setShowCheckpoints(true);
  };
  /** Restore a checkpoint: hard-reset the workspace, then truncate transcript + todos. */
  const restoreCheckpoint = async (cp: Checkpoint) => {
    if (running || !activeWs || !activeConv) return;
    const wsFiles = cp.commit
      ? `Workspace files reset to ${cp.label} (git reset --hard). Uncommitted changes will be lost.`
      : 'No git commit recorded — only the transcript will be truncated.';
    if (!window.confirm(`Restore checkpoint from ${new Date(cp.time).toLocaleString()}?\n\n${wsFiles}\nTranscript truncated to ${cp.messages} messages.`)) return;
    if (cp.commit) {
      if (!/^[0-9a-f]{5,40}$/i.test(cp.commit)) return;
      const r = await coderExec(`git reset --hard ${cp.commit}`, undefined, 30000, activeWsDir);
      if (r.exitCode !== 0) {
        addLog({ type: 'error', label: 'restore', detail: (r.stderr || r.stdout || 'reset failed').slice(0, 300) });
      }
      loadCommits();
      refreshRepoMap();
    }
    const keptMessages = messages.slice(0, cp.messages);
    const keptLedger = ledger.slice(0, cp.ledger);
    setMessages(keptMessages);
    applyTodos(cp.todos, null);
    setLedger([...keptLedger, { id: crypto.randomUUID(), time: Date.now(), type: 'compact', label: 'restore', detail: `restored checkpoint ${cp.label}` }]);
    // Write the store explicitly: restoring to an empty transcript would trip
    // the L1 anti-clobber guard in the persist effect and lose the restore.
    setStore((prev) => {
      const wsd = prev.workspaces[activeWs];
      const meta = wsd?.conversations[activeConv];
      if (!wsd || !meta) return prev;
      return { ...prev, workspaces: { ...prev.workspaces, [activeWs]: { ...wsd, conversations: { ...wsd.conversations, [activeConv]: { ...meta, messages: keptMessages, todos: cp.todos, todosUpdatedAt: undefined, updatedAt: Date.now() } } } } };
    });
  };
  const deleteCheckpoint = (id: string) => {
    if (!activeWs || !activeConv) return;
    setStore((prev) => {
      const wsd = prev.workspaces[activeWs];
      const meta = wsd?.conversations[activeConv];
      if (!wsd || !meta) return prev;
      return { ...prev, workspaces: { ...prev.workspaces, [activeWs]: { ...wsd, conversations: { ...wsd.conversations, [activeConv]: { ...meta, checkpoints: (meta.checkpoints ?? []).filter((c) => c.id !== id) } } } } };
    });
  };
  /** undoFileEdit is defined before the tabs hook (which needs it as its
   *  onUndoEdit); this ref keeps the refresh path one-way (no cyclic dep). */
  const tabsRefreshRef = useRef<() => void>(() => {});

  /** File-grained undo: revert the active file to its state before the most recent
   * commit that touched it (creating a recoverable undo commit). If the file has
   * only uncommitted changes, they're discarded; if it was created in that
   * commit, it's removed. */
  const undoFileEdit = useCallback(async (path: string) => {
    if (running || !activeWsDir) return;
    const q = (s: string) => `'${String(s).replace(/'/g, "'\\''")}'`;
    const p = q(path);
    const refresh = async () => {
      loadCommits();
      refreshRepoMap();
      // Re-fetch open tabs (adopt the new disk content or flag a conflict).
      tabsRefreshRef.current();
    };
    if (!window.confirm(`Undo the last edit to ${path}?\n\nReverts this file to its previous committed state (a new undo commit is created).`)) return;
    addLog({ type: 'bash', label: 'undo-file', detail: path });
    // Find the most recent commit that touched this file.
    const last = await coderExec(`git log -1 --format=%H -- ${p}`, undefined, 15000, activeWsDir);
    const hash = (last.stdout || '').trim();
    if (!hash) {
      // No commit touched it — discard uncommitted working changes (if any).
      const dis = await coderExec(`git checkout -- ${p}`, undefined, 15000, activeWsDir);
      if (dis.exitCode !== 0) {
        addLog({ type: 'error', label: 'undo-file', detail: `no commit and cannot discard changes for ${path}` });
        return;
      }
      addLog({ type: 'bash', label: 'undo-file', detail: `discarded working changes to ${path}` });
      await refresh();
      return;
    }
    // Root commit has no parent → no prior version to revert to.
    const parentOk = await coderExec(`git rev-parse ${hash}^`, undefined, 15000, activeWsDir);
    if (parentOk.exitCode !== 0) {
      addLog({ type: 'error', label: 'undo-file', detail: `cannot undo root-commit change to ${path} (no prior version)` });
      return;
    }
    // Did the file exist before this commit? If not, it was created here → delete it.
    const existed = await coderExec(`git cat-file -e ${hash}^:${p}`, undefined, 15000, activeWsDir);
    const res = existed.exitCode === 0
      ? await coderExec(`git checkout ${hash}^ -- ${p}`, undefined, 15000, activeWsDir)
      : await coderExec(`git rm -f -- ${p}`, undefined, 15000, activeWsDir);
    if (res.exitCode !== 0) {
      addLog({ type: 'error', label: 'undo-file', detail: (res.stderr || res.stdout || 'undo failed').slice(0, 300) });
      return;
    }
    const c = await coderExec(`git add -A -- ${p} && git commit -m ${q(`undo: revert ${path}`)}`, undefined, 30000, activeWsDir);
    if (c.exitCode !== 0) {
      addLog({ type: 'error', label: 'undo-file', detail: (c.stderr || c.stdout || 'commit failed').slice(0, 300) });
    } else {
      addLog({ type: 'bash', label: 'undo-file', detail: `reverted last edit to ${path}` });
    }
    await refresh();
  }, [running, activeWsDir, loadCommits, refreshRepoMap]);

  // ---- File tabs (VS Code-style center column: Chat + open file tabs) ----
  const tabs = useFileTabs({
    activeWsDir,
    running,
    // Mid-run sidecar-hold gate: while a run pins the sidecar to another
    // workspace, every sidecar-touching tab op no-ops (the wsHeld chip explains).
    sidecarReady: () => wsAppliedDirRef.current === activeWsDir,
    getLintCommand: () => {
      const c = activeWsDir ? detectedCmdsByWsRef.current.get(activeWsDir) : undefined;
      return c?.lint || c?.build || null;
    },
    onUndoEdit: (p) => { void undoFileEdit(p); },
  });
  tabsRefreshRef.current = () => { void tabs.refreshOpenTabs(); void tabs.refreshGitStatus(); };
  // Refresh git badges once a new workspace's sidecar re-point is flushed.
  useEffect(() => {
    void tabs.refreshGitStatus();
  }, [tabs.refreshGitStatus, wsFlushed, activeWsDir]);
  // Content refresh only when the flush actually lands (wsFlushed bumped):
  // a held mid-run switch — and even a plain switch's in-flight POST — skips
  // the restore re-reads (sidecarReady is false until the confirmed
  // workspace), so this is the point at which rereading open tabs (code AND
  // image — the snapshot drops image payloads) is guaranteed to hit the
  // right workspace. Gated on the delta so a plain activeWsDir change (no
  // flush) doesn't double-read the tabs the flush will cover anyway.
  const wsFlushedPrevRef = useRef(wsFlushed);
  useEffect(() => {
    const flushed = wsFlushed !== wsFlushedPrevRef.current;
    wsFlushedPrevRef.current = wsFlushed;
    if (!flushed) return;
    void tabs.refreshOpenTabs();
  }, [tabs.refreshOpenTabs, wsFlushed]);

  // ---- Permissions (per-workspace tiers + denied path prefixes) ----
  const perms: PermConfig = store.workspaces[activeWs]?.perms ?? DEFAULT_PERMS;
  const setPerms = (next: PermConfig) => {
    if (!activeWs) return;
    setStore((prev) => {
      const wsd = prev.workspaces[activeWs];
      if (!wsd) return prev;
      return { ...prev, workspaces: { ...prev.workspaces, [activeWs]: { ...wsd, perms: next } } };
    });
  };
  const setToolPerm = (tool: string, tier: PermTier) =>
    setPerms({ ...perms, tools: { ...perms.tools, [tool]: tier } });
  /** Human-readable denial reason, or `'ask'` when the user must decide, or null. */
  const checkPerm = (name: string, args: Record<string, unknown>): string | 'ask' | null => {
    if (planMode && MUTATING_TOOLS.has(name)) {
      if (name === 'bash') {
        // Plan mode keeps bash for investigation, locked to inspection commands.
        const cmd = typeof args.command === 'string' ? args.command.trim() : '';
        if (!isReadOnlyCommand(cmd)) {
          return 'Plan mode is read-only — bash may only run inspection commands (find, ls, cat, head, tail, wc, grep, rg, file, stat, du, tree, git log/status/diff/show, …); redirection, pipes, and chaining are rejected. Turn Plan off to execute anything that changes state.';
        }
      } else {
        return 'Plan mode is read-only — the run cannot write files or execute commands. Turn Plan off to apply changes.';
      }
    }
    if ((perms.tools[name] ?? 'allow') === 'deny') {
      return `Denied by workspace permissions (${name} is set to deny).`;
    }
    const target = typeof args.path === 'string' ? args.path : '';
    if (target) {
      const hit = perms.denyPaths.find((d) => {
        const clean = d.trim().replace(/\/+$/, '');
        return clean !== '' && (target === clean || target.startsWith(clean + '/'));
      });
      if (hit) return `Denied by workspace permissions (path is under denied prefix "${hit.trim()}").`;
    }
    if ((perms.tools[name] ?? 'allow') === 'ask') return 'ask';
    return null;
  };
  /** Pause the agent loop until the user approves or denies this one call. */
  const requestApproval = (name: string, detail: string): Promise<boolean> => {
    setPendingApproval({ name, detail });
    return new Promise<boolean>((resolve) => {
      approvalResolveRef.current = (ok: boolean) => {
        approvalResolveRef.current = null;
        setPendingApproval(null);
        resolve(ok);
      };
    });
  };
  /** Resume the run after an ask_user pause, sending the human's decision (and
   * optional note) back to the model as the tool answer. */
  const resumeFromAsk = (answer: string) => {
    if (pendingQuestion === null) return;
    setPendingQuestion(null);
    setAskNote('');
    const msg: ChatMessage = { role: 'user', content: answer };
    // Resume into the PAUSED conversation (askConvRef) even if the user has
    // since switched — the answer must not resume from the transcript now on
    // screen.
    const pin = askConvRef.current;
    askConvRef.current = null;
    if (pin && (pin.ws !== activeWs || pin.convId !== activeConv)) {
      setStore((prev) => ({ ...prev, activeWs: pin.ws, activeConv: pin.convId }));
      const pMeta = storeRef.current.workspaces[pin.ws]?.conversations[pin.convId];
      const pDir = pMeta?.worktree ? `${pin.ws}/${pMeta.worktree}` : pin.ws;
      queueWorkspaceApply(pDir); // must settle before the resumed run's first tool call
      const base = storeRef.current.workspaces[pin.ws]?.conversations[pin.convId]?.messages ?? [];
      loadConv(pin.ws, pin.convId);
      runAgent(compactedContext(base).concat(msg), { scout: false, pin });
      return;
    }
    const next = [...messages, msg];
    setMessages(next);
    // Resumed runs skip the scout pre-pass (its findings are already in context).
    runAgent(compactedContext(messages).concat(msg), { scout: false, pin: pin ?? undefined });
  };

  // ---------------------------------------------------------------------------
  // AI summarization of giant tool outputs. When a tool result (command output,
  // a large file read, a fetched page) exceeds SUMMARY_THRESHOLD, we ask the
  // engine to condense it and return the summary plus a short raw tail to the
  // agent — keeping its context small instead of ingesting a raw multi-KB dump.
  // ---------------------------------------------------------------------------
  const SUMMARY_THRESHOLD = 16 * 1024;
  const SUMMARY_TAIL = 1500;
  const maybeSummarizeTool = async (
    name: string,
    resultStr: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    // Structured results (grep/glob/repo_search) are already bounded — skip them.
    if (name === 'grep' || name === 'glob' || name === 'repo_search') return resultStr;
    let res: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(resultStr);
      if (parsed && typeof parsed === 'object') res = parsed as Record<string, unknown>;
    } catch {
      return resultStr;
    }
    if (!res) return resultStr;
    const hasStd = typeof res.stdout === 'string' || typeof res.stderr === 'string';
    const hasContent = typeof res.content === 'string';
    if (!hasStd && !hasContent) return resultStr;
    const text = hasStd ? `${(res.stdout as string) || ''}\n${(res.stderr as string) || ''}` : (res.content as string);
    if (text.length <= SUMMARY_THRESHOLD) return resultStr;
    try {
      const summary = await summarizeOutput({ model, output: text, signal });
      if (!summary) return resultStr;
      const tail = text.slice(-SUMMARY_TAIL);
      const wrapped = `[AI-summarized output — ${text.length} chars condensed for brevity]\n${summary}\n\n--- raw tail (last ${SUMMARY_TAIL} chars) ---\n${tail}`;
      if (hasStd) {
        res.stdout = wrapped;
        res.stderr = '';
      } else {
        res.content = wrapped;
      }
      res._summarized = true;
      return JSON.stringify(res);
    } catch {
      // On any summarizer failure, fall back to the raw (already-truncated) output.
      return resultStr;
    }
  };

  // ---------------------------------------------------------------------------
  // Per-workspace risky-command approval memory.
  //
  // Some bash commands have external / hard-to-reverse side effects (pushing to a
  // remote, publishing a package, SSH to a host, mutating cloud/infra, running as
  // root). When the agent issues one, we pause for human-in-the-loop review. If the
  // human approves *and* asks to remember, the (normalized) command is added to
  // this workspace's `approvedCommands` so future matching commands run without
  // re-prompting. `detectDestructive` (server-side safe mode) still hard-blocks the
  // truly catastrophic ones; this layer is for "risky but allowed with a yay/nay".
  // ---------------------------------------------------------------------------
  const RISKY_PATTERNS: Array<[RegExp, string]> = [
    [/\bgit\s+push\b[^]*?(--force|-f\b|--delete)\b/i, 'force-pushes or deletes remote refs'],
    [/\bgit\s+push\b/i, 'pushes commits to a remote'],
    [/\b(npm|pnpm|yarn)\s+publish\b/i, 'publishes a package to a registry'],
    [/\bcargo\s+publish\b/i, 'publishes a crate'],
    [/\btwine\s+upload\b/i, 'uploads a release to PyPI'],
    [/\bgh\s+(pr|release|api)\b/i, 'creates a GitHub release/PR via gh'],
    [/\b(sudo|su|doas)\b/i, 'runs a command as another user (root)'],
    [/\bssh\b(?!-)/i, 'opens an SSH connection to a remote host'],
    [/\b(scp|rsync|sftp)\b/i, 'transfers files to/from a remote host'],
    [/\b(docker|podman)\b/i, 'runs containers'],
    [/\b(kubectl|helm|terraform\s+apply|ansible)\b/i, 'applies infrastructure changes'],
    [/\b(aws|gcloud|az)\b[^]*?\b(ec2|s3|deploy|apply|create|delete|update|push)\b/i, 'mutates cloud resources'],
    [/\b(apt|apt-get|yum|dnf|apk)\b\s+(install|remove|upgrade|update)\b/i, 'changes system packages'],
    [/\b(npm\s+install\s+-g|pnpm\s+add\s+-g|yarn\s+global\s+add)\b/i, 'installs a global package'],
  ];
  const detectRisky = (cmd: string): string | null => {
    for (const [re, why] of RISKY_PATTERNS) if (re.test(cmd)) return why;
    return null;
  };
  const normalizeCommand = (cmd: string): string => cmd.replace(/\s+/g, ' ').trim();
  const isApprovedCommand = (cmd: string, approved: string[] = []): boolean => {
    const c = normalizeCommand(cmd);
    return approved.some((a) => {
      const na = normalizeCommand(a);
      return c === na || c.startsWith(na + ' ');
    });
  };
  const addApprovedCommand = (cmd: string) => {
    const norm = normalizeCommand(cmd);
    setStore((prev) => {
      const wsd = prev.workspaces[activeWs];
      if (!wsd) return prev;
      const cur = wsd.perms?.approvedCommands || [];
      if (cur.includes(norm)) return prev;
      return {
        ...prev,
        workspaces: {
          ...prev.workspaces,
          [activeWs]: { ...wsd, perms: { ...(wsd.perms || DEFAULT_PERMS), approvedCommands: [...cur, norm] } },
        },
      };
    });
  };

  // Risky-command HITL dialog: Deny / Approve once / Approve & remember.
  const [riskyApproval, setRiskyApproval] = useState<{ command: string; reason: string } | null>(null);
  const riskyResolveRef = useRef<((v: 'deny' | 'once' | 'remember') => void) | null>(null);
  const requestRiskyApproval = (command: string, reason: string): Promise<'deny' | 'once' | 'remember'> => {
    setRiskyApproval({ command, reason });
    return new Promise((resolve) => {
      riskyResolveRef.current = (v) => {
        riskyResolveRef.current = null;
        setRiskyApproval(null);
        resolve(v);
      };
    });
  };

  /** Stage + auto-commit one file, returning a bounded unified-diff preview. */
  const commitFile = async (path: string, message: string): Promise<{ ok: boolean; preview: string }> => {
    const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const c = await coderExec(`git add ${q(path)} && git commit -m ${q(message)}`, undefined, 10000);
    if (c.exitCode !== 0) return { ok: false, preview: '' };
    const d = await coderExec(`git show --format= --unified=3 HEAD -- ${q(path)}`, undefined, 10000);
    return { ok: true, preview: (d.stdout || '').slice(0, 4000) };
  };
  /** Post-edit verification: lint (falls back to build) then test, each bounded.
   * Returns extra result fields; the first failure stops the chain so the
   * model sees one error to fix at a time. */
  const runPostEditChecks = async (res: unknown, preview: string): Promise<Record<string, unknown>> => {
    const out: Record<string, unknown> = { ...(res as Record<string, unknown>), ...(preview ? { preview_diff: preview } : {}) };
    const cmds = (activeWsDir ? detectedCmdsByWsRef.current.get(activeWsDir) : undefined) ?? {};
    const lintCmd = cmds.lint || cmds.build;
    if (lintCmd) {
      const check = await coderExec(lintCmd, undefined, 120000);
      if (check.exitCode !== 0) {
        const diags = parseDiagnostics(lintCmd, check.stderr || check.stdout || '');
        return { ...out, linter_error: (check.stderr || check.stdout || '').slice(0, 8000), diagnostics: diags };
      }
    }
    if (cmds.test) {
      const t = await coderExec(cmds.test, undefined, 180000);
      if (t.exitCode !== 0) {
        const diags = parseDiagnostics(cmds.test, t.stderr || t.stdout || '');
        return { ...out, test_error: (t.stderr || t.stdout || '').slice(0, 8000), diagnostics: diags };
      }
    }
    return out;
  };
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
        // Permission gate: plan-mode read-only, per-tool tiers, denied paths.
        // `ask` pauses the loop on a user decision; denials return an error
        // the model can react to instead of executing.
        const permVerdict = checkPerm(call.name, args);
        // Set when the user approves an `ask` call — the dispatch below runs.
        let approvedAfterAsk = false;
        if (permVerdict !== null) {
          logType = 'error';
          logDetail = `${call.name} blocked`;
          if (permVerdict === 'ask') {
            const detail = call.name === 'bash' ? String(args.command ?? '') : String(args.path ?? args.files ?? args.pattern ?? args.query ?? args.url ?? '');
            addLog({ type: 'ask', label: call.name, detail });
            const ok = await requestApproval(call.name, detail);
            addLog({ type: ok ? 'bash' : 'error', label: call.name, detail: ok ? `approved: ${detail}` : `denied: ${detail}` });
            if (!ok) {
              result = JSON.stringify({ error: `Denied by the user (${call.name}). Ask for an alternative or proceed without it.` });
            } else {
              approvedAfterAsk = true;
            }
          } else {
            result = JSON.stringify({ error: permVerdict });
          }
        }
        if (result === '' && (permVerdict === null || approvedAfterAsk)) {
          if (call.name === 'bash') {
          logType = 'bash'; logDetail = args.background ? `bg: ${args.command}` : args.command;
          // Risky-command HITL gate + per-workspace approval memory. Truly
          // catastrophic commands are already hard-blocked by server-side safe mode;
          // this pauses on *risky but allowed* operations and learns approvals so the
          // user isn't prompted again for the same command in this workspace.
          const command0 = String(args.command || '');
          const riskyReason = detectRisky(command0);
          if (riskyReason && !isApprovedCommand(command0, perms.approvedCommands || [])) {
            addLog({ type: 'ask', label: 'bash', detail: `risky: ${command0}` });
            const v = await requestRiskyApproval(command0, riskyReason);
            addLog({ type: v === 'deny' ? 'error' : 'bash', label: 'bash', detail: v === 'deny' ? `denied: ${command0}` : `approved (${v}): ${command0}` });
            if (v === 'deny') {
              result = JSON.stringify({ error: `Risky command denied by the user: ${riskyReason}. Use a safer alternative or ask.` });
            } else if (v === 'remember') {
              addApprovedCommand(command0);
            }
          }
          if (result === '') {
            // Commit-approval gate: a shell `git commit` must be signed off too.
            let commitBlocked = false;
            if (commitApproval && isGitCommitCommand(String(args.command || ''))) {
              addLog({ type: 'ask', label: 'bash', detail: 'git commit — awaiting human review' });
              const ok = await requestCommitApproval();
              addLog({ type: ok ? 'bash' : 'error', label: 'bash', detail: ok ? 'approved' : 'denied by user' });
              if (!ok) commitBlocked = true;
            }
            if (commitBlocked) {
              result = JSON.stringify({ error: 'Commit denied by the user (commit approval gate is ON). Review the working-tree diff and adjust; the commit was not made.' });
            } else {
              const res = await coderExec(args.command, undefined, args.timeoutMs, activeWsDir, args.background === true);
              result = JSON.stringify(res);
              if (args.background === true) mutated = true;
              if (res.jobId) {
                const id = res.jobId;
                const cmd = String(args.command || '');
                setBgJobs((prev) => (prev.some((j) => j.id === id) ? prev : [...prev.slice(-19), { id, command: cmd, ws: activeWsDir }]));
              }
            }
          }
        } else if (call.name === 'bash_poll') {
          logType = 'bash'; logDetail = `poll ${args.jobId}`;
          try {
            const res = await coderJob(String(args.jobId || ''));
            result = JSON.stringify(res);
            setJobStatus((prev) => ({ ...prev, [res.jobId]: res }));
          } catch (e) {
            result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
          }
        } else if (call.name === 'read') {
          logType = 'read'; logDetail = args.path;
          const res = await coderRead(args.path, args.offset, args.limit);
          result = JSON.stringify(res);
        } else if (call.name === 'write') {
          logType = 'write'; logDetail = args.path;
          const res = await coderWrite(args.path, args.content);
          mutated = true;
          if (commitApproval) {
            // Gate ON: don't auto-commit; let the human review + approve a real commit.
            result = JSON.stringify(await runPostEditChecks(res, ''));
          } else {
            const { preview } = await commitFile(args.path, `Agent auto-commit: wrote ${args.path}`);
            result = JSON.stringify(await runPostEditChecks(res, preview));
          }
        } else if (call.name === 'edit') {
          logType = 'edit'; logDetail = args.path;
          const res = await coderEdit(args.path, args.old, args.new, args.replaceAll);
          result = JSON.stringify(res);
          mutated = true;
          if (res.replacements > 0) {
            if (commitApproval) {
              result = JSON.stringify(await runPostEditChecks(res, ''));
            } else {
              const { preview } = await commitFile(args.path, `Agent auto-commit: edited ${args.path}`);
              result = JSON.stringify(await runPostEditChecks(res, preview));
            }
          }
        } else if (call.name === 'apply_patch') {
          logType = 'edit'; logDetail = `${args.path} (${Array.isArray(args.edits) ? args.edits.length : 0} hunks)`;
          const res = await coderPatch(args.path, Array.isArray(args.edits) ? args.edits : []);
          result = JSON.stringify(res);
          mutated = true;
          if (res.replacements > 0) {
            if (commitApproval) {
              result = JSON.stringify(await runPostEditChecks(res, ''));
            } else {
              const { preview } = await commitFile(args.path, `Agent auto-commit: patched ${args.path}`);
              result = JSON.stringify(await runPostEditChecks(res, preview));
            }
          }
        } else if (call.name === 'git_branch') {
          const action = String(args.action || 'list');
          logType = 'bash'; logDetail = `git branch ${action}${args.name ? ` ${args.name}` : ''}`;
          const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
          if (action === 'list') {
            const r = await coderExec(`git branch --show-current && git branch --format='%(refname:short)'`, undefined, 15000);
            const lines = (r.stdout || '').split('\n').map((s: string) => s.trim()).filter(Boolean);
            result = JSON.stringify({ current: lines[0] || '', branches: lines.slice(1), ...r });
          } else if (action === 'create' || action === 'switch') {
            const name = String(args.name || '').trim();
            if (!name) {
              result = JSON.stringify({ error: `branch name required for action '${action}'` });
            } else if (!/^[A-Za-z0-9._\/-]+$/.test(name)) {
              result = JSON.stringify({ error: `invalid branch name: ${name}` });
            } else {
              const cmd = action === 'create' ? `git checkout -b ${q(name)}` : `git switch ${q(name)}`;
              const r = await coderExec(cmd, undefined, 30000);
              result = JSON.stringify(r);
              if (r.exitCode === 0) mutated = true;
            }
          } else {
            result = JSON.stringify({ error: `unknown action: ${action} (use list, create, or switch)` });
          }
        } else if (call.name === 'git_worktree') {
          const action = String(args.action || 'list');
          logType = 'bash'; logDetail = `git worktree ${action}${args.path ? ` ${args.path}` : ''}`;
          const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
          if (action === 'list') {
            const r = await coderExec('git worktree list', undefined, 15000);
            const lines = (r.stdout || '').split('\n').map((s: string) => s.trim()).filter(Boolean);
            result = JSON.stringify({ worktrees: lines, ...r });
          } else if (action === 'add') {
            const p = String(args.path || '').trim();
            const b = String(args.branch || '').trim();
            if (!p || !b) {
              result = JSON.stringify({ error: "path and branch required for action 'add'" });
            } else if (!/^[A-Za-z0-9._\/-]+$/.test(b) || !/^\.\.\/[A-Za-z0-9._\/-]+$/.test(p)) {
              result = JSON.stringify({ error: "invalid branch or path (path must start with '../' to keep it out of the main worktree)" });
            } else {
              const cmd = `git worktree add -B ${q(b)} ${q(p)} ${q(b)} || git worktree add -b ${q(b)} ${q(p)}`;
              const r = await coderExec(cmd, undefined, 30000);
              result = JSON.stringify(r);
              if (r.exitCode === 0) {
                // Link the conversation to this new worktree
                setStore((prev) => {
                  const wsd = prev.workspaces[activeWs];
                  const meta = wsd?.conversations[activeConv];
                  if (!wsd || !meta) return prev;
                  return { ...prev, workspaces: { ...prev.workspaces, [activeWs]: { ...wsd, conversations: { ...wsd.conversations, [activeConv]: { ...meta, worktree: p } } } } };
                });
                mutated = true;
              }
            }
          } else {
            result = JSON.stringify({ error: `unknown action: ${action} (use list or add)` });
          }
        } else if (call.name === 'git_pr') {
          // Open a PR for the current branch. Pushes to the remote, then uses `gh`
          // when present; otherwise returns a compare URL to open manually. Never
          // force-pushes. Requires a clean, committed working tree on a real branch.
          logType = 'bash'; logDetail = `git pr: ${String(args.title || '').slice(0, 40)}`;
          const q = (s: string) => `'${String(s).replace(/'/g, "'\\''")}'`;
          const gitRemoteToWeb = (url: string, base: string, head: string): string => {
            if (!url) return '';
            let host: string | undefined; let repo: string | undefined;
            const ssh = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
            if (ssh) { host = ssh[1]; repo = ssh[2]; }
            else {
              try { const u = new URL(url); host = u.host; repo = u.pathname.replace(/^\//, '').replace(/\.git$/, ''); } catch { return ''; }
            }
            return host && repo ? `https://${host}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}` : '';
          };
          const br = await coderExec('git rev-parse --abbrev-ref HEAD', undefined, 10000);
          const branch = (br.stdout || '').trim();
          if (!branch || branch === 'HEAD') {
            result = JSON.stringify({ ok: false, error: 'Cannot open a PR from a detached HEAD. Create or check out a branch first.' });
          } else {
            const st = await coderExec('git status --porcelain', undefined, 10000);
            if ((st.stdout || '').trim()) {
              result = JSON.stringify({ ok: false, error: 'Working tree is not clean — commit (or stash) your changes before opening a PR.' });
            } else {
              const rm = await coderExec('git remote', undefined, 10000);
              const remote = (rm.stdout || '').trim().split('\n')[0];
              if (!remote) {
                result = JSON.stringify({ ok: false, error: 'No git remote configured. Add one (git remote add origin <url>) before opening a PR.' });
              } else {
                const base = String(args.base || '').trim()
                  || (await coderExec(`git rev-parse --abbrev-ref ${q(remote)}/HEAD 2>/dev/null || true`, undefined, 10000)).stdout.trim()
                  || 'main';
                const push = await coderExec(`git push -u ${q(remote)} ${q(branch)}`, undefined, 60000);
                if (push.exitCode !== 0) {
                  result = JSON.stringify({ ok: false, error: 'push failed', stderr: push.stderr, stdout: push.stdout });
                } else {
                  const gh = await coderExec('command -v gh >/dev/null 2>&1 && echo yes || echo no', undefined, 10000);
                  if ((gh.stdout || '').trim() === 'yes') {
                    let cmd = `gh pr create --title ${q(args.title)} --body ${q(args.body || '')}`;
                    if (base) cmd += ` --base ${q(base)}`;
                    const pr = await coderExec(cmd, undefined, 60000);
                    const url = (pr.stdout || '').match(/https?:\/\/\S+/)?.[0] || '';
                    result = JSON.stringify({ ok: pr.exitCode === 0, url, stdout: pr.stdout, stderr: pr.stderr });
                  } else {
                    const urlOut = await coderExec(`git remote get-url ${q(remote)}`, undefined, 10000);
                    const compare = gitRemoteToWeb((urlOut.stdout || '').trim(), base, branch);
                    result = JSON.stringify({ ok: true, pushed: true, remote, branch, base, compareUrl: compare, note: 'gh CLI not found — open the PR manually at the compare URL (or install gh).' });
                  }
                }
              }
            }
          }
        } else if (call.name === 'repo_search') {
          logType = 'read'; logDetail = `search: ${String(args.query ?? '').slice(0, 30)}`;
          const sr = await coderSearch(String(args.query || ''), typeof args.limit === 'number' ? args.limit : 15);
          result = JSON.stringify(sr);
        } else if (call.name === 'grep') {
          logType = 'grep'; logDetail = args.pattern;
          const res = await coderGrep(args.pattern, undefined, args.include, args.ignoreCase, args.offset || 0, args.limit || 200);
          result = JSON.stringify(res);
        } else if (call.name === 'glob') {
          logType = 'glob'; logDetail = args.pattern;
          const res = await coderGlob(args.pattern, undefined, args.offset || 0, args.limit || 200);
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
        } else if (call.name === 'git_commit') {
          logType = 'bash'; logDetail = `git commit ${args.files}`;
          // Commit-approval gate: when ON, the human must sign off on the
          // working-tree-vs-HEAD diff before the commit actually runs.
          let proceed = true;
          if (commitApproval) {
            addLog({ type: 'ask', label: 'git_commit', detail: 'awaiting human review' });
            proceed = await requestCommitApproval();
            addLog({ type: proceed ? 'bash' : 'error', label: 'git_commit', detail: proceed ? 'approved' : 'denied by user' });
          }
          if (!proceed) {
            result = JSON.stringify({ error: 'Commit denied by the user (commit approval gate is ON). Review the working-tree diff (Diff button) and adjust your changes; the commit was not made.' });
            continue;
          }
          // Safely quote each workspace path / flag; only bare flags (e.g. -A)
          // are passed through unquoted so git globs/flags still work.
          const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
          const fileTokens = args.files && String(args.files).trim()
            ? String(args.files).trim().split(/\s+/)
            : ['-A'];
          const fileArgs = fileTokens.map((t) => (t.startsWith('-') ? t : q(t))).join(' ');
          const message = args.message || 'Agent commit';
          const commitRes = await coderExec(`git add ${fileArgs} && git commit -m ${q(message)} && git rev-parse HEAD`, undefined, 30000);
          result = JSON.stringify(commitRes);
          // Note: a commit doesn't change the file tree, so we deliberately do
          // NOT set mutated=true (which would trigger a repo-map rescan, M5).
        } else if (call.name === 'git_diff') {
          logType = 'bash'; logDetail = `git diff ${args.ref || ''}`.trim();
          const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
          const ref = (args.ref || '').trim();
          // `path` may be a single path or several space-separated ones (L3).
          const pathTokens = (args.path || '').trim().split(/\s+/).filter(Boolean);
          const refArg = ref ? q(ref) : '';
          const pathArg = pathTokens.map(q).join(' ');
          const cmd = `git --no-pager diff ${refArg} ${pathArg}`.replace(/\s+/g, ' ').trim();
          const diffRes = await coderExec(cmd, undefined, 30000);
          result = JSON.stringify(diffRes);
        } else if (call.name === 'ask_user') {
          // Pause the run and surface the question to the user. We record the
          // question in askRef; runAgent detects it after the tool pass and stops,
          // leaving the conversation ready for the user's answer (release #5).
          logType = 'ask'; logDetail = args.question || '(no question)';
          askRef.current = String(args.question || '');
          result = JSON.stringify({ question: args.question, status: 'awaiting_user' });
        } else if (call.name === 'todo_write') {
          logType = 'todo'; logDetail = 'Updated task list';
          // Validate: the JSON schema is model-hint only. Reject malformed
          // items instead of stringifying them into real tasks — `String(...)`
          // would turn `{}` into "[object Object]" and arrays into
          // comma-joined text, which would then render and reach the system
          // prompt. The schema requires a string; non-strings don't qualify.
          const raw: unknown = Array.isArray(args.todos) ? args.todos : [];
          const cleaned: TodoItem[] = [];
          for (const t of raw as Array<Record<string, unknown>>) {
            const content = t && typeof t.content === 'string' ? t.content.trim() : '';
            if (!content) continue; // malformed (non-string/empty) — skip
            cleaned.push({
              content,
              status: t.status === 'in_progress' ? 'in_progress' : t.status === 'completed' ? 'completed' : 'pending',
            });
          }
          // Stale-write guard: todo_write replaces the WHOLE list, and this
          // response was generated from the list sent in `system` at request
          // build time. If the user edited the list while the request was
          // in flight, the model's snapshot is older than the user's edits —
          // discard it rather than clobber newer user state (the model sees
          // the user's list in the next turn's system prompt and can
          // re-emit if its plan is still the right one).
          if (todosRevRef.current > todosRevAtReqStartRef.current) {
            logDetail = 'Task list update discarded (edited mid-run)';
            addLog({ type: 'todo', label: 'todo_write', detail: 'discarded: list edited by the user mid-run' });
            result = JSON.stringify({ success: false, reason: 'the task list was edited by the user while this response was being generated, so this update was not applied. The current list is in your system prompt — re-emit todo_write with the full intended list if your plan is still correct.' });
          } else {
            // Composite of #5 (validation + stale-guard above) and #11 (run
            // pinning): sync the run-loop ref FIRST so the next LLM call's
            // system-prompt injection sees this list even before effects run,
            // then write through the pinned path (store lands in the run's
            // conversation even mid-switch; visible transcript mirrors it).
            todosRef.current = cleaned;
            updateRunTodos(cleaned, Date.now());
            result = JSON.stringify({ success: true, count: cleaned.length });
          }
        } else if (call.name === 'memory_update') {
          // Declared in TOOLS but previously unhandled — calls landed in the
          // "Unknown tool" branch and the learning was silently lost.
          const kind = args.kind === 'avoid' || args.kind === 'success' ? args.kind : 'tip';
          logType = 'todo'; logDetail = `memory: ${kind}`;
          const res = await coderMemoryAddLearning({ text: String(args.text || ''), kind });
          result = JSON.stringify(res ?? { success: true });
        } else if (call.name === 'delegate') {
          logType = 'ask'; logDetail = `delegate: ${String(args.task ?? '').slice(0, 30)}`;
          const res = await runSubagent(`delegate`, `Task: ${args.task}\n\nYou are a read-only subagent. Investigate and reply with a concise summary. Do not write code.`, modelRef.current, abortRef.current?.signal ?? new AbortController().signal, 6, Array.isArray(args.tools) ? args.tools.map(String).filter((t: string) => READONLY_TOOL_NAMES.has(t)) : undefined);
          result = JSON.stringify({ summary: res });
        } else if (call.name === 'subagent') {
          // Implementation subagent (worker): spawn a focused agent, capture its
          // diff, and optionally bounce it through the critic for a fix loop.
          logType = 'bash';
          const task = String(args.task || '');
          logDetail = `subagent: ${task.slice(0, 40)}`;
          addLog({ type: 'bash', label: 'subagent', detail: `spawning worker (${task.slice(0, 60)})` });
          const wmodel = (args.model && String(args.model).trim()) || modelRef.current;
          const workerTools = Array.isArray(args.tools) ? args.tools.map(String).filter((t: string) => READONLY_TOOL_NAMES.has(t)) : undefined;
          let preTree = '';
          try { preTree = (await coderExec('git write-tree', undefined, 10000)).stdout.trim(); } catch { /* no git */ }
          let res = { summary: '', diff: '', ok: false };
          let critique = '';
          const MAX_WORKER_CRIT = 2;
          for (let attempt = 0; attempt <= MAX_WORKER_CRIT; attempt++) {
            const p = attempt === 0
              ? `TASK (implement now):\n${task}`
              : `TASK (revise your previous implementation):\n${task}\n\nA code reviewer rejected your previous attempt with these issues — fix them:\n${critique}`;
            res = await runWorker('subagent', p, wmodel, abortRef.current?.signal ?? new AbortController().signal, 12, workerTools);
            if (criticMode && res.diff.trim()) {
              const c = await runCritic(res.diff, task);
              if (c.learnings.length) {
                await persistLearnings(c.learnings, c.approved ? 'critic:approve' : 'critic:reject', task);
              }
              if (!c.approved) {
                critique = c.issues;
                addLog({ type: 'error', label: 'critic', detail: `subagent changes rejected (${attempt + 1}/${MAX_WORKER_CRIT}) — re-running worker` });
                continue;
              }
            }
            break;
          }
          // Net diff across all worker attempts (git write-tree before/after).
          let diff = res.diff;
          try {
            const postTree = (await coderExec('git write-tree', undefined, 10000)).stdout.trim();
            if (preTree && postTree && preTree !== postTree) {
              const d = await coderExec(`git --no-pager diff ${preTree} ${postTree}`, undefined, 60000);
              diff = (d.stdout || '').slice(0, 60000);
            }
          } catch { /* keep res.diff */ }
          mutated = true;
          result = JSON.stringify({ summary: res.summary, diff, ok: res.ok });
          addLog({ type: 'bash', label: 'subagent', detail: `done: ${res.summary.slice(0, 60)}` });
        } else if (call.name === 'memory_update') {
          // Agent-proactive learning capture (the critic also writes learnings).
          // Persist outside the repo and refresh local state so the rest of this
          // run (and future runs) see the updated memory.
          logType = 'todo';
          const text = String(args.text || '').trim();
          const rawKind = String(args.kind || 'tip');
          const kind: CoderLearningKind = rawKind === 'success' || rawKind === 'avoid' ? rawKind : 'tip';
          logDetail = `memory: ${kind} — ${text.slice(0, 40)}`;
          addLog({ type: 'todo', label: 'memory', detail: `recording ${kind} learning` });
          if (!text) {
            result = JSON.stringify({ error: 'memory_update requires non-empty `text`.' });
          } else {
            try {
              const m = await coderMemoryAddLearning({ text, kind, provenance: 'tool' });
              // The write landed in the store the control points at *now*;
              // adopt it into the active workspace's state only if that is
              // still the confirmed workspace.
              if (wsAppliedDirRef.current === activeWsDir) {
                setMemory(m);
                memoryRef.current = m;
              }
              result = JSON.stringify({ ok: true, kind, learnings: m.learnings.length });
            } catch (e) {
              result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
            }
          }
        } else {
          result = JSON.stringify({ error: 'Unknown tool' });
        }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logDetail = msg;
        // Feed the failure back to the model instead of an empty result so it
        // can adapt (retry differently, skip, or report) rather than guess.
        result = JSON.stringify({ error: msg });
      }
      
      const durationMs = Math.round(performance.now() - t0);
      addLog({ type: logType, label: call.name, detail: logDetail, durationMs });

      // AI-summarize giant outputs so the agent gets a condensed summary + raw
      // tail instead of a raw multi-KB dump (keeps its context small).
      const maybeSummarized = await maybeSummarizeTool(call.name, result, modelRef.current, abortRef.current?.signal);
      if (maybeSummarized !== result) {
        addLog({ type: 'compact', label: call.name, detail: 'output AI-summarized (too large to pass through)' });
      }

      nextMessages.push({
        role: 'tool',
        content: maybeSummarized,
        tool_call_id: call.id,
        name: call.name
      });
    }

    if (mutated) {
      try { await onMutated?.(); } catch { /* ignore */ }
    }
    return nextMessages;
  };
  // ---- Read-only scout pre-pass (subagents lite) ----
  // Three parallel probes (structure / usages+tests / history+docs) with their
  // own short context; only merged summaries reach the main run. Parallelism
  // needs parallel engine slots, so this runs ONLY when the engine's
  // max-concurrency (from the profile it was launched with) exceeds 1.
  const SCOUT_PROBES = [
    { label: 'structure', goal: 'Map the relevant code structure: key files, modules, entry points, and how they connect. Be concrete with paths.' },
    { label: 'usages', goal: 'Find existing usages, tests, and examples related to the task. Quote exact paths.' },
    { label: 'history', goal: 'Summarize recent related work or docs that bear on the task (from file layout, changelogs, notes, or git diffs of related areas).' },
  ];
  const engineMaxConcurrency = async (): Promise<number> => {
    try {
      const s = await getStatus();
      const mc = s?.lastStart?.profile?.maxConcurrency;
      if (typeof mc === 'number' && mc > 0) return mc;
    } catch { /* unknown — fail closed below */ }
    return 1;
  };
  const runReadOnlyCall = async (call: AgentToolCall): Promise<string> => {
    try {
      const args = JSON.parse(call.arguments);
      switch (call.name) {
        case 'read': return JSON.stringify(await coderRead(args.path, args.offset, args.limit));
        case 'grep': return JSON.stringify(await coderGrep(args.pattern, undefined, args.include, args.ignoreCase, args.offset || 0, args.limit || 200));
        case 'glob': return JSON.stringify(await coderGlob(args.pattern, undefined, args.offset || 0, args.limit || 200));
        case 'ast_grep': return JSON.stringify(await coderExec(`sg -p '${String(args.pattern ?? '').replace(/'/g, "'\\''")}' -l ${args.lang}`, undefined, 15000));
        case 'web_fetch': return JSON.stringify(await coderWebFetch(args.url));
        case 'web_search': return JSON.stringify(await coderWebSearch(args.query));
        default: return JSON.stringify({ error: `scout cannot use tool: ${call.name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  const runSubagent = async (label: string, prompt: string, model: string, signal: AbortSignal, maxSteps = 6, allowedTools?: string[], depth = 0): Promise<string> => {
    if (depth > 5) return '(subagent failed: maximum depth 5 exceeded)';
    // Track the run so it shows live in the Jobs panel.
    const subId = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    setActiveSubs((prev) => [...prev.slice(-11), { id: subId, label, task: prompt.replace(/^Task: /, '').slice(0, 100), since: Date.now() }]);
    try {
      return await runSubagentInner(label, prompt, model, signal, maxSteps, allowedTools, depth);
    } finally {
      setActiveSubs((prev) => prev.filter((s) => s.id !== subId));
    }
  };
  const runSubagentInner = async (label: string, prompt: string, model: string, signal: AbortSignal, maxSteps = 6, allowedTools?: string[], depth = 0): Promise<string> => {
    if (depth > 5) return '(subagent failed: maximum depth 5 exceeded)';
    const allowed = allowedTools ? new Set(allowedTools) : new Set(['read', 'grep', 'glob', 'ast_grep', 'web_fetch', 'web_search']);
    const tools = TOOLS.filter((t) => allowed.has(t.function.name));
    let msgs: ChatMessage[] = [{ role: 'user', content: prompt }];
    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) return `(subagent ${label} aborted)`;
      let content = '';
      let toolCalls: AgentToolCall[] = [];
      try {
        await trackedStream(
          buildChatRequest(model, dynamicSystemRef.current, msgs, { thinking: coderParams.thinking, reasoningEffort: coderParams.thinkLevel, temperature: coderParams.temperature, topP: coderParams.topP, topK: coderParams.topK, seed: coderParams.seed, maxTokens: 2048 } as ChatParams, { tools }, coderParams.promptCache),
          signal,
          'subagent ' + label,
          { onContentDelta: (t) => { content += t; }, onToolCalls: (c) => { toolCalls = c; } },
        );
      } catch (e) {
        return `(subagent ${label} failed: ${e instanceof Error ? e.message : String(e)})`;
      }
      msgs = [...msgs, { role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls : undefined }];
      if (toolCalls.length === 0) return content.trim() || '(no findings)';
      for (const call of toolCalls) {
        if (call.name === 'delegate') {
          const args = JSON.parse(call.arguments);
          const res = await runSubagent(`delegate-${depth}`, `Task: ${args.task}\n\nYou are a read-only subagent. Investigate and reply with a concise summary. Do not write code.`, model, signal, maxSteps, Array.isArray(args.tools) ? args.tools.map(String).filter((t: string) => READONLY_TOOL_NAMES.has(t)) : undefined, depth + 1);
          msgs.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify({ summary: res }) });
        } else {
          const res = await runReadOnlyCall(call);
          msgs.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: res });
        }
      }
    }
    return '(subagent step budget reached)';
  };

  // Dispatch a single tool call for an IMPLEMENTATION worker subagent. This is a
  // self-contained, dependency-free executor (it does NOT go through the main
  // handleToolCalls, so it never pollutes the supervisor transcript or trips the
  // commit/ask gates). Read-only fan-out (`delegate`) recurses into runSubagent.
  const runWorkerCall = async (call: AgentToolCall, signal: AbortSignal, model: string, depth: number): Promise<string> => {
    try {
      const args = JSON.parse(call.arguments);
      switch (call.name) {
        case 'read': return JSON.stringify(await coderRead(args.path, args.offset, args.limit));
        case 'grep': return JSON.stringify(await coderGrep(args.pattern, undefined, args.include, args.ignoreCase, args.offset || 0, args.limit || 200));
        case 'glob': return JSON.stringify(await coderGlob(args.pattern, undefined, args.offset || 0, args.limit || 200));
        case 'ast_grep': return JSON.stringify(await coderExec(`sg -p '${String(args.pattern ?? '').replace(/'/g, "'\\''")}' -l ${args.lang}`, undefined, 15000));
        case 'web_fetch': return JSON.stringify(await coderWebFetch(args.url));
        case 'web_search': return JSON.stringify(await coderWebSearch(args.query));
        case 'repo_search': return JSON.stringify(await coderSearch(String(args.query || ''), typeof args.limit === 'number' ? args.limit : 15));
        case 'write': return JSON.stringify(await coderWrite(args.path, args.content));
        case 'edit': return JSON.stringify(await coderEdit(args.path, args.old, args.new, args.replaceAll));
        case 'apply_patch': return JSON.stringify(await coderPatch(args.path, Array.isArray(args.edits) ? args.edits : []));
        case 'bash': {
          // Foreground bash runs in a persistent per-workspace shell so cwd AND
          // environment (export / venv / conda activation) survive across calls;
          // background jobs get their own process and stay stateless.
          const sid = !args.background && activeWsDir ? 'sh:' + activeWsDir : (args.background ? activeWsDir : undefined);
          return JSON.stringify(await coderExec(args.command, undefined, args.timeoutMs, sid, args.background === true));
        }
        case 'bash_poll': return JSON.stringify(await coderJob(String(args.jobId || '')));
        case 'git_diff': return JSON.stringify(await coderExec(`git --no-pager diff ${String(args.ref || '').trim()}`.replace(/\s+/g, ' ').trim(), undefined, 30000));
        case 'delegate': {
          const r = await runSubagent(`delegate-${depth}`, `Task: ${args.task}\n\nYou are a read-only subagent. Investigate and reply with a concise summary. Do not write code.`, model, signal, 6, Array.isArray(args.tools) ? args.tools.map(String).filter((t: string) => READONLY_TOOL_NAMES.has(t)) : undefined, depth + 1);
          return JSON.stringify({ summary: r });
        }
        default: return JSON.stringify({ error: `worker cannot use tool: ${call.name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
  };

  // Run an autonomous implementation worker: a focused agent loop that shares the
  // workspace. Captures the net working-tree change (git write-tree before/after)
  // so the supervisor gets a clean per-task diff regardless of commits/edits.
  const runWorker = async (
    label: string,
    prompt: string,
    model: string,
    signal: AbortSignal,
    maxSteps = 12,
    allowedTools?: string[],
    depth = 0,
  ): Promise<{ summary: string; diff: string; ok: boolean }> => {
    if (depth > 3) return { summary: '(worker depth limit reached)', diff: '', ok: false };
    const allowed = allowedTools
      ? new Set(allowedTools)
      : new Set(['read', 'grep', 'glob', 'ast_grep', 'web_fetch', 'web_search', 'repo_search', 'write', 'edit', 'apply_patch', 'bash', 'bash_poll', 'git_diff', 'delegate']);
    const tools = TOOLS.filter((t) => allowed.has(t.function.name));
    let preTree = '';
    try { preTree = (await coderExec('git write-tree', undefined, 10000)).stdout.trim(); } catch { /* no git */ }
    let msgs: ChatMessage[] = [{ role: 'user', content: prompt }];
    let summary = '';
    try {
      for (let step = 0; step < maxSteps; step++) {
        if (signal.aborted) break;
        let content = '';
        let toolCalls: AgentToolCall[] = [];
        await trackedStream(
          buildChatRequest(model, WORKER_SYSTEM, msgs, { thinking: coderParams.thinking, reasoningEffort: coderParams.thinkLevel, temperature: coderParams.temperature, topP: coderParams.topP, topK: coderParams.topK, seed: coderParams.seed, maxTokens: 4096 } as ChatParams, { tools }, coderParams.promptCache),
          signal,
          'worker',
          { onContentDelta: (t) => { content += t; }, onToolCalls: (c) => { toolCalls = c; } },
        );
        summary = content.trim() || summary;
        msgs = [...msgs, { role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls : undefined }];
        if (toolCalls.length === 0) break;
        for (const call of toolCalls) {
          const res = await runWorkerCall(call, signal, model, depth);
          msgs.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: res });
        }
      }
    } catch (e) {
      summary = `(worker ${label} failed: ${e instanceof Error ? e.message : String(e)})`;
    }
    let diff = '';
    try {
      const postTree = (await coderExec('git write-tree', undefined, 10000)).stdout.trim();
      if (preTree && postTree && preTree !== postTree) {
        const d = await coderExec(`git --no-pager diff ${preTree} ${postTree}`, undefined, 60000);
        diff = (d.stdout || '').slice(0, 60000);
      }
    } catch { /* no diff */ }
    return { summary: summary || '(no summary)', diff, ok: !summary.startsWith('(worker') };
  };

  // Critic: review a working-tree-vs-HEAD diff against the task. Bounded and
  // fail-open (a critic error never blocks the run).
  /**
   * Review a diff and decide approve / reject. Also parses any `LEARNING:` /
   * `AVOID:` lines the critic appended into structured learnings the caller can
   * persist (the critic is the memory writer for the self-improving loop).
   */
  const runCritic = async (
    diff: string,
    task: string,
  ): Promise<{ approved: boolean; issues: string; learnings: Array<{ text: string; kind: CoderLearningKind }> }> => {
    const criticModel = coderParams.criticModel?.trim() || modelRef.current;
    const prompt = `TASK:\n${task.slice(0, 2000)}\n\nDIFF (working tree vs HEAD):\n\`\`\`diff\n${diff.slice(0, 24000)}\n\`\`\`\n\nReview the diff against the task.`;
    // When a review lens is active, extend the critic's rubric with it so the
    // second-pass reviewer judges the diff by that discipline (e.g. Linus's
    // "fatal invariants first" method) rather than generic taste. Concatenated
    // (not a template literal) because LINUS_LENS contains backticks.
    const criticSystem =
      coderParams.reviewLens === 'linus'
        ? CRITIC_SYSTEM + '\n\n# Review rubric — Linus Torvalds method (distilled)\n' + LINUS_LENS
        : CRITIC_SYSTEM;
    let content = '';
    try {
      await trackedStream(
        buildChatRequest(criticModel, criticSystem, [{ role: 'user', content: prompt }], { thinking: false, maxTokens: 2048 } as ChatParams, {}),
        abortRef.current?.signal ?? new AbortController().signal,
        'critic',
        { onContentDelta: (t) => { content += t; } },
      );
    } catch {
      return { approved: true, issues: '', learnings: [] };
    }
    const approved = /VERDICT:\s*APPROVED/i.test(content);
    // Pull learnings out of the raw text first so they don't bleed into `issues`.
    const learnings: Array<{ text: string; kind: CoderLearningKind }> = [];
    const kept: string[] = [];
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      const learn = line.match(/^LEARNING:\s*(.+)$/i) || line.match(/^\*?\s*LEARNING:\s*(.+)$/i);
      const avoid = line.match(/^AVOID:\s*(.+)$/i) || line.match(/^\*?\s*AVOID:\s*(.+)$/i);
      if (learn) {
        const t = learn[1].trim();
        if (t) learnings.push({ text: t, kind: 'success' });
      } else if (avoid) {
        const t = avoid[1].trim();
        if (t) learnings.push({ text: t, kind: 'avoid' });
      } else {
        kept.push(raw);
      }
    }
    const issues = kept
      .join('\n')
      .replace(/VERDICT:\s*(?:APPROVED|CHANGES_REQUESTED)\s*/i, '')
      .trim();
    return { approved, issues, learnings };
  };

  /**
   * Persist critic / agent learnings to the per-repo memory store (outside the
   * repo) and refresh local state so the rest of this run + future runs see them.
   */
  const persistLearnings = async (
    items: Array<{ text: string; kind: CoderLearningKind }>,
    provenance: string,
    task?: string,
  ) => {
    if (!items.length) return;
    let m = memoryRef.current;
    for (const it of items) {
      try {
        m = await coderMemoryAddLearning({ text: it.text, kind: it.kind, provenance, task: task || undefined });
      } catch {
        // An individual persistence failure must not break the run loop.
      }
    }
    // Adopt the final write response only if the control is still confirmed
    // at the active workspace (it re-points async on workspace switches).
    if (wsAppliedDirRef.current === activeWsDir) {
      setMemory(m);
      memoryRef.current = m;
    }
  };

  const runAgent = async (initialMessages: ChatMessage[], opts?: { scout?: boolean; pin?: { ws: string; convId: string } }) => {
    // Pin the run to its conversation BEFORE anything can switch the view, so
    // every transcript/log/todo write below lands in this conversation's store
    // entry even if the user moves to a different conversation mid-run.
    setRunConv(opts?.pin ?? { ws: activeWs, convId: activeConv });
    setRunning(true);
    // Pin the run's token accounting; the visible meter may follow the view.
    runTokensRef.current = lastPromptTokensRef.current;
    // Settle any in-flight sidecar re-point BEFORE the first tool call: a
    // switch POST only ever targets the view the run starts in, so awaiting
    // it makes the early calls hit the right repo instead of the previous
    // workspace, and nothing re-points mid-run (switches now queue behind it).
    await wsApplyQueueRef.current.catch(() => undefined);
    let currentMessages = initialMessages;
    // Capture the repo HEAD at run start so the critic can review the CUMULATIVE
    // diff of everything the agent did this run (including auto-committed edits),
    // not just the (often empty) working-tree-vs-HEAD diff.
    let runStartHead = '';
    try { runStartHead = (await coderExec('git rev-parse HEAD', undefined, 10000)).stdout.trim(); } catch { /* not a repo yet */ }

    // Build the initial system prompt (CODER_SYSTEM + repo map); it is refreshed
    // after file mutations during the run (P1 #6).
    await refreshRepoMap();
    // Auto-detect lint/test/build commands once per run (config, else
    // manifests) — cached under the workspace the run started in.
    {
      const m = detectedCmdsByWsRef.current;
      if (!m.has(activeWsDir) && m.size >= 8) m.delete(m.keys().next().value!);
      m.set(activeWsDir, await detectCommands());
    }

    abortRef.current = new AbortController();

    // Resolve the model the engine is actually serving — don't assume 'qwen-coder'
    // (P0 #1). Used for every request, the summarizer, and the context-size lookup.
    let model = 'qwen-coder';
    try {
      const s = await getStatus();
      if (s?.engine?.modelId) model = s.engine.modelId;
    } catch { /* ignore */ }
    modelRef.current = model;

    // Read-only scout pre-pass. The probes fan out concurrently, so they run
    // ONLY when the engine was launched with max-concurrency > 1 (parallel
    // slots must exist); otherwise the main loop works unaided.
    if (opts?.scout && scoutOn) {
      const mc = await engineMaxConcurrency();
      if (mc > 1 && !abortRef.current.signal.aborted) {
        const task = [...currentMessages].reverse().find((m) => m.role === 'user' && !isCompactedMsg(m))?.content ?? '';
        addLog({ type: 'read', label: 'scout', detail: `3 parallel probes (engine concurrency ${mc})` });
        const signal = abortRef.current.signal;
        const summaries = await Promise.all(
          SCOUT_PROBES.map(async (p) => {
            const s = await runSubagent(p.label, `Task: ${task.slice(0, 2000)}\n\nScout goal (${p.label}): ${p.goal}\n\nYou are read-only: investigate with tools and reply with a concise findings report (paths + facts). Do not write code.`, model, signal);
            addLog({ type: 'read', label: `scout:${p.label}`, detail: `${s.length} chars` });
            return `## ${p.label}\n${s}`;
          }),
        );
        if (!signal.aborted) {
          const scoutMsg: ChatMessage = {
            role: 'user',
            displayName: 'Scout',
            collapsed: true,
            content: `# Scout Report (read-only pre-pass, ${SCOUT_PROBES.length} parallel probes)\n${summaries.join('\n\n')}\n\nUse these findings; verify paths before editing.`,
          };
          currentMessages = [...currentMessages, scoutMsg];
          updateRunMessages((prev) => [...prev, scoutMsg]);
        }
      } else if (!abortRef.current.signal.aborted) {
        addLog({ type: 'read', label: 'scout', detail: `skipped: engine max-concurrency is ${mc} (needs > 1 for parallel probes)` });
      }
    }
    if (abortRef.current.signal.aborted) {
      setRunning(false);
      abortRef.current = null;
      setRunConv(null);
      return;
    }

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
    setCtxLimit(maxContext > 0 ? maxContext : null);
    const COMPACT_AT = 0.8;
    const MAX_ATTEMPTS = 3;
    // Hard ceiling on agent turns so a non-terminating plan (or a model that
    // keeps emitting tool calls) can't loop forever — it stops with a clear
    // message instead (release blocker #1).
    const MAX_AGENT_STEPS = 60;
    // Bounded self-repair: when the agent tries to "finish" right after a tool
    // action failed, nudge it to fix the error instead of declaring success (#6).
    const MAX_REPAIR = 3;
    // Bounded critic bounce-back: a reviewer can reject the final diff and send the
    // run back to fix at most MAX_CRITIC times before we give up and finish (M6).
    const MAX_CRITIC = 2;
    let criticBudget = 0;
    // The original user task — used as the critic's review context.
    const taskText = [...initialMessages].reverse().find((m) => m.role === 'user' && !isCompactedMsg(m))?.content ?? '';
    // Derive the response budget from the engine's context window so a small
    // context still leaves room for the prompt (P3 #12). The Coder always thinks,
    // and a reasoning trace plus the answer can exceed a tiny budget, so floor
    // thinking runs higher (M4). Falls back to 8192.
    const respFloor = 4096;
    const respMax = maxContext > 0
      ? Math.min(Math.max(Math.floor(maxContext / 2), respFloor), 16384)
      : 8192;

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
      let agentSteps = 0;
      setAgentSteps(0);
      let repairCount = 0;
      while (true) {
        if (abortRef.current?.signal.aborted) break;

        // Auto-compact when the model context is near (>=80%) or past (estimate
        // >=100%) the window limit, so we never silently truncate mid-task.
        // Use the recorded prompt-token count when the engine reports it; otherwise
        // fall back to the local estimate (M3) so the 80% trigger still fires.
        const est = estimateTokens(currentMessages);
        const recordedOrEst = Math.max(runTokensRef.current, est);
        const overBudget =
          maxContext > 0 &&
          (recordedOrEst >= COMPACT_AT * maxContext || est >= maxContext);
        if (overBudget) {
          addLog({ type: 'compact', label: 'compact', detail: `context ${runTokensRef.current}/${maxContext} — summarizing` });
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
            updateRunMessages((prev) => [...prev, ...currentMessages]);
            noteRunTokens(0);
            continue;
          } catch (e) {
            // Compaction is our only guard against context overflow — if it fails
            // we must stop rather than send an oversized payload (P1 #3).
            addLog({ type: 'error', label: 'compact', detail: e instanceof Error ? e.message : String(e) });
            updateRunMessages((prev) => [
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
        
        // Hard stop after MAX_AGENT_STEPS real turns (compactions above don't
        // count) so a runaway plan can't loop indefinitely (release blocker #1).
        if (agentSteps >= MAX_AGENT_STEPS) {
          addLog({ type: 'error', label: 'limit', detail: `reached max agent steps (${MAX_AGENT_STEPS}) — stopping to avoid a runaway run` });
          updateRunMessages((prev) => [...prev, {
            role: 'system',
            content: `⚠ Reached the maximum number of agent steps (${MAX_AGENT_STEPS}). The run was stopped to avoid a runaway loop. Review the work so far, then continue in a new message or break the task into smaller steps.`,
          }]);
          break;
        }
        agentSteps++;
        setAgentSteps(agentSteps);

        let content = '';
        let reasoning = '';
        let toolCalls: AgentToolCall[] = [];
        
        // Plan mode advertises read-only tools only; the permission gate in
        // handleToolCalls enforces it even if the model tries otherwise.
        // Plan mode keeps read-only tools PLUS bash (enforced to inspection
        // commands by checkPerm), so investigation doesn't push the model
        // into inventing tool markup for an undeclared tool.
        const activeTools = planMode ? TOOLS.filter((t) => READONLY_TOOL_NAMES.has(t.function.name) || t.function.name === 'bash') : TOOLS;
        const planToolNames = [...new Set([...READONLY_TOOL_NAMES, 'bash'])].join(', ');
        const system = (planMode
          ? `${dynamicSystemRef.current}\n\n# PLAN MODE (read-only): investigate, analyze, and propose a concrete, step-by-step plan, then stop and wait for the user.\nAvailable tools: ${planToolNames}. bash is READ-ONLY here: inspection commands only (find, ls, cat, head, tail, wc, grep, rg, file, stat, du, tree, git log/status/diff/show) — redirection, pipes, chaining, and anything that mutates state are rejected.\nDo NOT call write, edit, apply_patch, git_commit, or git_branch — they are disabled and calls to them are denied.\nCall tools through the native tool-call mechanism only — never write <tool_call> markup inside your reply text.`
          : dynamicSystemRef.current) + todoSystemBlock(todosRef.current);
        // Baseline for the stale todo_write guard: this request's system
        // prompt carried the list as of this moment.
        todosRevAtReqStartRef.current = todosRevRef.current;
        const req = buildChatRequest(model, system, currentMessages, { thinking: coderParams.thinking, reasoningEffort: coderParams.thinkLevel, temperature: coderParams.temperature, topP: coderParams.topP, topK: coderParams.topK, seed: coderParams.seed, maxTokens: respMax } as ChatParams, { tools: activeTools }, coderParams.promptCache);
        // Bounded retry on transient stream failures so a single dropped
        // connection doesn't kill a long agent run (P2 #9).
        let attempt = 0;
        let streamOk = false;
        while (!streamOk && attempt < MAX_ATTEMPTS) {
          attempt++;
          content = '';
          reasoning = '';
          toolCalls = [];
          try {
            await trackedStream(req, abortRef.current.signal, 'agent', {
              onContentDelta: (text) => { content += text; },
              onReasoningDelta: (text) => { reasoning += text; },
              onToolCalls: (calls) => { toolCalls = calls; },
              onDone: (meta) => {
                // Record the engine's real prompt-token count when present;
                // otherwise keep the local estimate so accounting stays accurate
                // across turns even when usage is omitted (M3). Pinned to the
                // run — the visible meter may follow a different conversation.
                noteRunTokens(meta?.promptTokens ?? est);
              },
            });
            streamOk = true;
          } catch (e) {
            if (abortRef.current?.signal.aborted) throw e;
            const msg = e instanceof Error ? e.message : String(e);
            if (attempt >= MAX_ATTEMPTS) {
              addLog({ type: 'error', label: 'retry', detail: `stream failed after ${MAX_ATTEMPTS} attempts: ${msg}` });
              throw e;
            }
            addLog({ type: 'error', label: 'retry', detail: `stream failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying: ${msg}` });
            await new Promise((r) => setTimeout(r, 800 * attempt));
          }
        }
        
        // Engine fallback: when the model emits tool markup as plain text (the
        // engine returns markup naming an undeclared tool instead of parsing
        // it), recover the calls so the run proceeds instead of dead-airing.
        // Undeclared ones are dropped with an explanatory note the model sees.
        if (toolCalls.length === 0 && /<tool_call>/.test(content)) {
          const declared = new Set(activeTools.map((t) => t.function.name));
          const recovered = parseMarkupToolCalls(content);
          const usable = recovered.filter((c) => declared.has(c.name));
          if (usable.length > 0) {
            content = stripToolMarkup(content);
            toolCalls = usable;
            const dropped = recovered.filter((c) => !declared.has(c.name)).map((c) => c.name);
            addLog({ type: 'error', label: 'markup', detail: `recovered ${usable.length} tool call(s) from text markup${dropped.length ? `; dropped undeclared: ${dropped.join(', ')}` : ''}` });
            if (dropped.length) {
              content += `\n\n[System: your <tool_call> markup for ${dropped.join(', ')} was ignored — those tools are not available right now. Available tools: ${[...declared].join(', ')}. Use the native tool-call format.]`;
            }
          }
        }

        // A response with neither content nor tool calls is a no-op (the engine
        // produced nothing actionable). Don't push a blank bubble into the
        // transcript or the model context, and don't treat it as "done" — just
        // stop the turn cleanly so the user can retry (H1).
        const isEmptyResponse = !content.trim() && toolCalls.length === 0;
        if (isEmptyResponse) {
          addLog({ type: 'error', label: 'empty', detail: 'Model returned an empty response (no content or tool calls) — stopping the turn.' });
          break;
        }

        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content,
          reasoning: reasoning || undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined
        };

        currentMessages = [...currentMessages, assistantMsg];
        updateRunMessages((prev) => [...prev, assistantMsg]);

        // Not-Ai auto-rewrite: for content-only (user-facing) replies, run the
        // deterministic tell-gate and silently re-write the message in place when
        // it trips a high-signal tell. Skipped for tool-call turns.
        if (coderParams.humanize && toolCalls.length === 0 && assistantMsg.content.trim()) {
          // Best-effort pass: the gate runs outside the rewrite's own try, so
          // wrap it too — a gate failure must keep the original reply, never
          // strand the streaming state.
          try {
            const gateRes = evaluate(assistantMsg.content, effectiveVoice({ ...coderParams, humanize: true }, 'technical'), {});
            if (needsHumanize(gateRes)) {
              const rewritten = await humanizeRewriteText({
                model,
                baseSystem: dynamicSystemRef.current,
                priorMessages: currentMessages.slice(0, currentMessages.length - 1),
                originalText: assistantMsg.content,
                params: { thinking: coderParams.thinking, humanize: true, voiceProfile: coderParams.voiceProfile || 'technical' },
                signal: abortRef.current?.signal,
              });
              if (rewritten && rewritten.trim() && rewritten.trim() !== assistantMsg.content.trim()) {
                const updated: ChatMessage = { ...assistantMsg, content: rewritten };
                currentMessages = currentMessages.map((m) => (m === assistantMsg ? updated : m));
                updateRunMessages((prev) => prev.map((m) => (m === assistantMsg ? updated : m)));
              }
            }
          } catch {
            /* keep the original reply if the gate or rewrite fails */
          }
        }

        if (toolCalls.length > 0) {
          const before = currentMessages.length;
          // Agent mutated files: refresh repo map, re-fetch open tabs (adopt or
          // conflict per tab), and refresh git badges.
          currentMessages = await handleToolCalls(toolCalls, currentMessages, async () => {
            await refreshRepoMap();
            await tabs.refreshOpenTabs();
            await tabs.refreshGitStatus();
          });
          // Keep the Commit History panel live as the agent commits changes.
          loadCommits();
          // Append only the new tool results to the visible transcript.
          updateRunMessages((prev) => [...prev, ...currentMessages.slice(before)]);
          // Human-in-the-loop pause: if the agent asked the user a question, stop
          // the run and surface it. The (already-visible) transcript includes the
          // question; the user's answer resumes the run (#5).
          if (askRef.current) {
            const q = askRef.current;
            askRef.current = null;
            askConvRef.current = runConvRef.current; // resume into THIS conversation
            setPendingQuestion(q);
            addLog({ type: 'ask', label: 'ask_user', detail: q });
            return;
          }
        } else {
          // Verification gate: before declaring done, confirm lint/test pass. If
          // they fail, send the run back to fix them (bounded by MAX_REPAIR) rather
          // than finishing with broken code.
          let bounced = false;
          if (verifyMode && repairCount < MAX_REPAIR) {
            const v = await runPostEditChecks({}, '');
            if (v.linter_error || v.test_error) {
              repairCount++;
              const summary = String(v.linter_error || v.test_error || '').slice(0, 2500);
              addLog({ type: 'error', label: 'verify', detail: `checks failing — sending back to fix (${repairCount}/${MAX_REPAIR})` });
              currentMessages = [...currentMessages, {
                role: 'user',
                displayName: 'Verify',
                collapsed: true,
                content: `VERIFICATION GATE: the project's lint/test checks are still failing. You must fix them before the task is complete — do not declare success. Re-run the checks after fixing.\n\n${summary}`,
              }];
              updateRunMessages((prev) => [...prev, currentMessages[currentMessages.length - 1]]);
              bounced = true;
            }
          }
          // Critic gate: if there are working-tree changes, a (possibly different)
          // model reviews the diff and can reject it, bouncing the run back to fix
          // before it is allowed to finish (bounded by MAX_CRITIC).
          if (!bounced && criticMode && criticBudget < MAX_CRITIC) {
            // Review the cumulative run diff (everything since run start, including
            // auto-committed edits). Falls back to working-tree-vs-HEAD if no base commit.
            let d = '';
            try {
              d = runStartHead
                ? (await coderExec(`git --no-pager diff ${runStartHead}`, undefined, 60000)).stdout || ''
                : (await coderDiff()).diff || '';
            } catch { d = ''; }
            if (d.trim()) {
              const c = await runCritic(d, taskText);
              if (c.learnings.length) {
                await persistLearnings(c.learnings, c.approved ? 'critic:approve' : 'critic:reject', taskText);
              }
              if (!c.approved) {
                criticBudget++;
                addLog({ type: 'error', label: 'critic', detail: `review rejected (${criticBudget}/${MAX_CRITIC}) — sending back to fix` });
                currentMessages = [...currentMessages, {
                  role: 'user',
                  displayName: 'Critic',
                  collapsed: true,
                  content: `CODE REVIEW REJECTED: a reviewer found issues with your changes. Address every point below, then continue — do not declare success until the review passes.\n\n${c.issues}`,
                }];
                updateRunMessages((prev) => [...prev, currentMessages[currentMessages.length - 1]]);
                bounced = true;
              } else {
                addLog({ type: 'todo', label: 'critic', detail: 'review passed' });
              }
            }
          }
          if (bounced) continue;
          break; // Done!
        }
      }
    } catch (err: unknown) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (!isAbort) {
        const msg = err instanceof Error ? err.message : String(err);
        addLog({ type: 'error', label: 'System Error', detail: msg });
        // The ledger line alone is easy to miss — surface run-death in the
        // transcript itself so a dead run never looks like a silent stop
        // ("subagents did their job and then nothing").
        setMessages((prev) => [...prev, { role: 'user', displayName: 'System', content: `[Run failed: ${msg}]`, error: true }]);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      setRunConv(null);
    }
  };

  const onSubmit = () => {
    if ((!input.trim() && attachments.length === 0) || running || !activeWs) return;
    // Answering a pending ask_user question: clear the pause and continue. The
    // answer is just a normal user message that resumes the run (#5). Resumed
    // runs skip the scout — its findings are already in context.
    const resuming = pendingQuestion !== null;
    if (resuming) setPendingQuestion(null);
    const msg: ChatMessage = { role: 'user', content: input.trim(), attachments: attachments.length ? attachments : undefined };
    // Answering a question that was asked while the user has since switched
    // conversations: the answer belongs to the PAUSED conversation — go back
    // there and resume from its transcript (not the one now on screen).
    const resumePin = resuming ? askConvRef.current : null;
    askConvRef.current = null;
    if (resumePin && (resumePin.ws !== activeWs || resumePin.convId !== activeConv)) {
      setStore((prev) => ({ ...prev, activeWs: resumePin.ws, activeConv: resumePin.convId }));
      const pMeta = storeRef.current.workspaces[resumePin.ws]?.conversations[resumePin.convId];
      const pDir = pMeta?.worktree ? `${resumePin.ws}/${pMeta.worktree}` : resumePin.ws;
      queueWorkspaceApply(pDir); // must settle before the resumed run's first tool call
      const base = storeRef.current.workspaces[resumePin.ws]?.conversations[resumePin.convId]?.messages ?? [];
      loadConv(resumePin.ws, resumePin.convId);
      setInput('');
      setAttachments([]);
      runAgent(compactedContext(base).concat(msg), { scout: false, pin: resumePin });
      return;
    }
    const next = [...messages, msg];
    setMessages(next);
    setInput('');
    setAttachments([]);
    // Seed the model context from the most recent compaction checkpoint onward.
    // The visible transcript keeps the full history; only the engine's context is
    // cleared to the summary and re-injected as leading context.
    runAgent(compactedContext(messages).concat(msg), { scout: !resuming, pin: resumePin ?? undefined });
  };

  // True while a run is in flight in a DIFFERENT conversation than the one on
  // screen. The Stop button is disabled there so the user can't stop (or try to
  // track) a run they can't see — switch to the running conversation (marked
  // with the pulsing dot / header chip) to stop it.
  const runElsewhere = running && !!runConv && (runConv.ws !== activeWs || runConv.convId !== activeConv);

  const stop = () => {
    abortRef.current?.abort();
    // Never leave the agent loop parked on an approval dialog after Stop.
    approvalResolveRef.current?.(false);
    commitResolveRef.current?.(false);
  };

  // Persist conversations + per-workspace permissions across reloads.
  useEffect(() => {
    try {
      localStorage.setItem(CONV_KEY, JSON.stringify(store));
    } catch { /* quota or privacy mode — session still works in memory */ }
  }, [store]);
  // Persist sampling params across reloads.
  useEffect(() => {
    try {
      localStorage.setItem(CODER_PARAMS_KEY, JSON.stringify(coderParams));
    } catch { /* ignore */ }
  }, [coderParams]);

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

  // Auto-scroll the transcript as the agent streams new messages/tools, but
  // only while the user is pinned near the bottom — scrolling up to read
  // history must not yank the view back down. Mirrors the Chat screen and
  // the Log pane (stick-to-bottom, re-engage when they return to the end).
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptStick = useRef(true);
  // Re-pin on workspace/conversation switch: a newly loaded transcript opens
  // at its latest message and follows the stream, instead of inheriting the
  // previous conversation's scrolled-up position (where auto-follow would be
  // off and the view would sit stale). Runs before the scroll effect below,
  // which then applies the fresh bottom position.
  useEffect(() => {
    transcriptStick.current = true;
  }, [activeWs, activeConv]);
  useEffect(() => {
    const el = transcriptRef.current;
    // While a file tab is active the chat panel is display:none (all dims 0) —
    // skip force-scrolling the hidden node; the existing re-pin logic decides
    // on re-show.
    if (el && transcriptStick.current && !tabs.activeTabId) el.scrollTop = el.scrollHeight;
  }, [messageGroups, tabs.activeTabId]);

  const boundPaths = activeMeta?.boundPaths ?? [];

  const renderTree = (list: FileNode[], depth: number): React.ReactNode => (
    <div>
      {list.map((n) => {
        const bound = boundPaths.includes(n.path);
        const kids = treeChildren[n.path] ?? n.children;
        return (
          <div key={n.path}>
            <div className={cn('group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-panel2', bound && 'text-accent')} style={{ paddingLeft: depth * 10 + 4 }}>
              {n.kind === 'dir' ? (
                <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-left" onClick={() => void onExpandDir(n)}>
                  {treeExpanded[n.path] ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
                  <Folder size={12} className="shrink-0 text-accent" />
                  <span className="truncate">{n.name}</span>
                </button>
              ) : (
                <>
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-left" onClick={() => tabs.openFile(n.path)} title={n.path}>
                    <span className="w-3 shrink-0" />
                    <File size={12} className="shrink-0 text-mute" />
                    <span className="truncate">{n.name}</span>
                  </button>
                  {tabs.statusMap.get(n.path) ? (
                    <span className={cn('shrink-0 font-mono text-[10px] font-bold', GIT_BADGE_CLASS[tabs.statusMap.get(n.path)!])} title={`git status: ${tabs.statusMap.get(n.path)}`}>
                      {tabs.statusMap.get(n.path)}
                    </span>
                  ) : null}
                </>
              )}
              <button
                type="button"
                className={cn('shrink-0 rounded p-0.5 hover:bg-panel', bound ? 'text-accent' : 'text-faint opacity-0 group-hover:opacity-100')}
                title={bound ? 'Unpin from system prompt (stop following)' : 'Pin to system prompt (follow this file/dir)'}
                onClick={() => toggleBind(n.path)}
              >
                <BookmarkPlus size={12} />
              </button>
            </div>
            {n.kind === 'dir' && treeExpanded[n.path] && kids && renderTree(kids, depth + 1)}
          </div>
        );
      })}
    </div>
  );

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
                        const isRunning = runConv?.ws === ws && runConv?.convId === cid;
                        return (
                          <div
                            key={cid}
                            className={cn('group flex items-center gap-1 rounded px-1.5 py-1', isActive ? 'bg-accent/15 text-ink' : 'text-mute hover:bg-panel2')}
                          >
                            {isRunning && (
                              <span role="status" aria-label="Run in progress" className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" title="Run in progress — this conversation keeps updating in the background" />
                            )}
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
        <SidebarSection title="Session Ledger" defaultOpen={false}>
        <div className="max-h-44 shrink-0 overflow-auto border-t border-line p-2">
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
        </SidebarSection>

        {/* Safe mode — blocks destructive shell commands (release blocker #2) */}
        <SidebarSection title="Safe Mode" icon={<Shield size={13} />} defaultOpen={true}>
        <div className="shrink-0 border-t border-line p-2">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => toggleSafeMode(!coderSafeMode)}
              className={cn("ml-auto rounded px-2 py-0.5 text-[11px] font-medium", coderSafeMode ? 'bg-ok/20 text-ok' : 'bg-danger/20 text-danger')}
              title={coderSafeMode ? 'Destructive commands are blocked' : 'Destructive commands are allowed'}
            >
              {coderSafeMode ? 'ON' : 'OFF'}
            </button>
          </div>
          <p className="mt-1 text-[10.5px] text-faint">Blocks <code className="font-mono">rm -rf /</code>, <code className="font-mono">git push --force</code>, <code className="font-mono">mkfs</code>, piping downloads into a shell, and similar.</p>
        </div>
        </SidebarSection>
        {/* Sandbox — wraps the agent shell in bwrap (workspace read-write, host read-only) */}
        <SidebarSection title="Sandbox" icon={<Shield size={13} />} defaultOpen={false}>
        <div className="shrink-0 border-t border-line p-2">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => toggleSandbox(!coderSandbox)}
              className={cn('ml-auto rounded px-2 py-0.5 text-[11px] font-medium', coderSandbox ? 'bg-ok/20 text-ok' : 'bg-danger/20 text-danger')}
              title={coderSandbox ? 'Agent shell is wrapped in bwrap (writes limited to the workspace)' : 'Agent shell runs directly on the host'}
            >
              {coderSandbox ? 'ON' : 'OFF'}
            </button>
          </div>
          <p className="mt-1 text-[10.5px] text-faint">Wraps <code className="font-mono">bash</code> in <code className="font-mono">bwrap</code> — host filesystem is read-only, only the workspace is writable. Requires <code className="font-mono">bwrap</code> installed.</p>
        </div>
        </SidebarSection>
        {/* Commit approval — gate: the agent cannot commit without human sign-off */}
        <SidebarSection title="Commit approval" icon={<GitCommit size={13} />} defaultOpen={false}>
        <div className="shrink-0 border-t border-line p-2">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setCommitApproval((v) => !v)}
              className={cn('ml-auto rounded px-2 py-0.5 text-[11px] font-medium', commitApproval ? 'bg-ok/20 text-ok' : 'bg-danger/20 text-danger')}
              title={commitApproval ? 'Agent commits require your approval of the working-tree diff' : 'Agent may commit freely (auto-commits on every write)'}
            >
              {commitApproval ? 'ON' : 'OFF'}
            </button>
          </div>
          <p className="mt-1 text-[10.5px] text-faint">When ON, the agent cannot commit until you review the working-tree-vs-HEAD diff and approve. Auto-commits on write/edit are paused so only intentional, reviewed commits land.</p>
        </div>
        </SidebarSection>
        {/* Permissions — per-tool allow/ask/deny + denied path prefixes (per workspace) */}
        <SidebarSection title="Permissions" icon={<Shield size={13} />} defaultOpen={false}>
        <div className="shrink-0 border-t border-line p-2">
          <div className="mb-1.5 flex items-center">
            <button
              type="button"
              className="ml-auto rounded p-0.5 text-faint hover:text-ink"
              title={permsOpen ? 'Collapse' : 'Expand'}
              onClick={() => setPermsOpen((o) => !o)}
            >
              {permsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          </div>
          {permsOpen && (
          <>
          {!activeWs ? (
            <div className="text-[10.5px] italic text-faint">Select a workspace.</div>
          ) : (
            <>
              <div className="max-h-36 space-y-1 overflow-auto">
                {TOOLS.map((t) => {
                  const tier = perms.tools[t.function.name] ?? 'allow';
                  return (
                    <div key={t.function.name} className="flex items-center gap-1">
                      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-mute" title={t.function.description}>{t.function.name}</span>
                      {(['allow', 'ask', 'deny'] as PermTier[]).map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setToolPerm(t.function.name, v)}
                          title={`${v} ${t.function.name}`}
                          className={cn(
                            'rounded px-1.5 py-px text-[10px] font-medium',
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
                key={activeWs}
                defaultValue={perms.denyPaths.join(' ')}
                placeholder="Denied paths, space-separated (e.g. secrets/ .env)"
                title="Tool calls touching these workspace-relative paths are denied"
                onBlur={(e) => setPerms({ ...perms, denyPaths: e.target.value.split(/\s+/).map((s) => s.trim()).filter(Boolean) })}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                className="mt-1.5 w-full rounded border border-line bg-inset px-1.5 py-1 font-mono text-[10.5px] outline-none placeholder:text-faint focus:border-accent/50"
              />
              <div className="mt-2">
                <div className="mb-1 text-[10.5px] font-semibold text-mute">Approved risky commands</div>
                {(perms.approvedCommands || []).length === 0 ? (
                  <div className="text-[10px] italic text-faint">None yet. Risky commands (push, publish, ssh, sudo, docker, cloud/infra mutations…) prompt for approval; choose &quot;Approve &amp; remember&quot; to whitelist them here for this workspace.</div>
                ) : (
                  <div className="max-h-28 space-y-1 overflow-auto">
                    {(perms.approvedCommands || []).map((c) => (
                      <div key={c} className="flex items-center gap-1 rounded border border-line bg-inset px-1.5 py-0.5">
                        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-mute" title={c}>{c}</span>
                        <button
                          type="button"
                          onClick={() => setStore((prev) => {
                            const wsd = prev.workspaces[activeWs];
                            if (!wsd) return prev;
                            const cur = wsd.perms?.approvedCommands || [];
                            return { ...prev, workspaces: { ...prev.workspaces, [activeWs]: { ...wsd, perms: { ...(wsd.perms || DEFAULT_PERMS), approvedCommands: cur.filter((x) => x !== c) } } } };
                          })}
                          className="shrink-0 rounded p-0.5 text-faint hover:bg-danger/10 hover:text-danger"
                          title="Remove from approved list"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          </>
          )}
        </div>
        </SidebarSection>

        {/* Commit History — git log of the active workspace */}
        <SidebarSection title="Commit History" icon={<GitCommit size={13} />} defaultOpen={false}>
        <div className="max-h-52 shrink-0 overflow-hidden border-t border-line p-2">
          <div className="mb-2 flex items-center gap-2">
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
                    <div className="flex w-full items-center gap-2 px-2 py-1 hover:bg-panel2">
                      <button
                        type="button"
                        onClick={() => setExpandedCommit(expandedCommit === c.hash ? null : c.hash)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span className="shrink-0 font-mono text-[10.5px] text-accent">{c.hash.slice(0, 7)}</span>
                        <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{c.subject}</span>
                        <span className="shrink-0 text-[10px] text-faint">{c.relDate}</span>
                      </button>
                      <button
                        type="button"
                        title={`Revert ${c.hash.slice(0, 7)} (creates an undo commit)`}
                        onClick={() => revertCommit(c.hash)}
                        className="shrink-0 rounded p-0.5 text-faint hover:bg-panel hover:text-warn"
                      >
                        <Undo2 size={12} />
                      </button>
                    </div>
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
        </SidebarSection>
        {/* Background Jobs — live view of detached shell jobs for this workspace */}
        <SidebarSection title="Jobs" icon={<Terminal size={13} />} defaultOpen={false}>
        <div className="shrink-0 border-t border-line p-2">
          <div className="mb-1.5 flex items-center">
            <button
              type="button"
              className="ml-auto rounded p-0.5 text-faint hover:text-ink"
              title={jobsOpen ? 'Collapse' : 'Expand'}
              onClick={() => setJobsOpen((o) => !o)}
            >
              {jobsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          </div>
          {jobsOpen && (() => {
            const wsJobs = bgJobs.filter((j) => j.ws === activeWs);
            const subs = activeSubs;
            if (wsJobs.length === 0 && subs.length === 0) return <div className="text-[10.5px] italic text-faint">No background jobs. Long builds/tests run here via bash with background:true.</div>;
            return (
              <div className="max-h-40 space-y-1 overflow-auto">
                {subs.map((s) => (
                  <div key={s.id} className="rounded border border-accent/25 bg-accent/8 px-2 py-1" title={s.task}>
                    <div className="flex items-center gap-2">
                      <BrainCircuit size={11} className="shrink-0 animate-pulse text-accent" />
                      <span className="min-w-0 flex-1 truncate text-[10.5px] text-mute">{s.label} — {s.task}</span>
                      <span className="shrink-0 text-[10px] text-faint">{Math.max(1, Math.round((subTick - s.since) / 1000))}s</span>
                    </div>
                  </div>
                ))}
                {wsJobs.map((j) => {
                  const s = jobStatus[j.id];
                  const done = s?.done ?? false;
                  const ok = done && (s?.exitCode === 0);
                  return (
                    <div key={j.id} className="rounded border border-line px-2 py-1">
                      <div className="flex items-center gap-2">
                        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', !done ? 'animate-pulse bg-accent' : ok ? 'bg-ok' : 'bg-danger')} />
                        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-mute" title={j.command}>{j.command || j.id}</span>
                        <span className="shrink-0 text-[10px] text-faint">{!done ? 'running' : s?.exitCode === null ? (s?.killed ? 'killed' : 'done') : `exit ${s?.exitCode}`}</span>
                        {!done ? (
                          <button
                            type="button"
                            title="Kill job"
                            className="shrink-0 rounded p-0.5 text-faint hover:bg-panel hover:text-danger"
                            onClick={async () => {
                              try {
                                const k = await coderJobKill(j.id);
                                setJobStatus((prev) => ({ ...prev, [j.id]: k }));
                              } catch (e) {
                                addLog({ type: 'error', label: 'job', detail: e instanceof Error ? e.message : String(e) });
                              }
                            }}
                          >
                            <Square size={11} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            title="Dismiss"
                            className="shrink-0 rounded p-0.5 text-faint hover:bg-panel hover:text-ink"
                            onClick={() => {
                              setBgJobs((prev) => prev.filter((x) => x.id !== j.id));
                              setJobStatus((prev) => {
                                const next = { ...prev };
                                delete next[j.id];
                                return next;
                              });
                            }}
                          >
                            <X size={11} />
                          </button>
                        )}
                      </div>
                      {s && (s.stdout || s.stderr) && (
                        <div className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all border-t border-line pt-1 font-mono text-[10px] text-mute">
                          {redactSecrets((s.stdout + (s.stderr ? `\n${s.stderr}` : '')).slice(-2000))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
        </SidebarSection>
      </div>

      {/* Middle: file tree + system-prompt follow bindings */}
      {treeOpen ? (
        <div className="flex w-64 flex-col border-r border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line p-2 text-sm font-semibold">
            <Folder size={14} /> Files
            <button type="button" className="ml-auto rounded p-0.5 text-faint hover:text-ink" title="Refresh tree" onClick={() => void loadTree()}>
              <RefreshCw size={12} className={treeLoading ? 'animate-spin' : ''} />
            </button>
            <button type="button" className="rounded p-0.5 text-faint hover:text-ink" title="Collapse file tree" onClick={() => setTreeOpen(false)}>
              <ChevronLeft size={14} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto text-[11.5px]">
            {treeLoading ? (
              <div className="p-3 text-faint">Loading…</div>
            ) : treeNodes.length === 0 ? (
              <div className="p-3 text-faint">No files.</div>
            ) : (
              renderTree(treeNodes, 0)
            )}
          </div>
          <div className="shrink-0 border-t border-line p-2 text-[10.5px] text-faint">
            System prompt follows <span className="text-ink">{boundPaths.length}</span> item{boundPaths.length === 1 ? '' : 's'}.
            {boundPaths.length > 0 && (
              <button type="button" className="ml-1 underline hover:text-ink" onClick={clearBinds}>Clear</button>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="flex w-8 shrink-0 flex-col items-center justify-center gap-1 border-r border-line bg-panel text-faint hover:text-ink"
          title="Show file tree"
          onClick={() => { setTreeOpen(true); void loadTree(); }}
        >
          <Folder size={15} />
        </button>
      )}

      {/* Center: VS Code-style tab container (Chat tab + one tab per open file) */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* tab strip */}
        <div className="flex h-8 shrink-0 items-center overflow-x-auto border-b border-line bg-panel">
          <button
            type="button"
            className={cn('flex h-full shrink-0 items-center gap-1.5 border-r border-line px-3 text-[11.5px]', !tabs.activeTabId ? 'bg-panel2 text-ink' : 'text-mute hover:text-ink')}
            onClick={() => tabs.setActive(null)}
            title="Chat"
          >
            <MessageSquare size={12} className="shrink-0" /> Chat
            {running && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" title="agent run in flight" />}
          </button>
          {tabs.tabs.map((t) => (
            <div key={t.id} className="flex h-full shrink-0 items-center border-r border-line">
              <button
                type="button"
                className={cn('flex h-full min-w-0 items-center gap-1.5 px-2.5 text-[11.5px]', tabs.activeTabId === t.id ? 'bg-panel2 text-ink' : 'text-mute hover:text-ink')}
                onClick={() => tabs.setActive(t.id)}
                title={t.path}
              >
                {t.kind === 'image' ? <Image size={12} className="shrink-0" /> : <File size={12} className="shrink-0" />}
                <span className="max-w-32 truncate font-mono text-[11px]">{t.path.split(/[\/]/).pop()}</span>
                {t.gitStatus && (
                  <span className={cn('shrink-0 font-mono text-[10px] font-bold', GIT_BADGE_CLASS[t.gitStatus])} title={`git status: ${t.gitStatus}`}>
                    {t.gitStatus}
                  </span>
                )}
                {t.status === 'conflict' && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title="changed elsewhere since you opened it" />}
                {t.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title="unsaved changes" />}
              </button>
              <button type="button" className="shrink-0 px-1 text-faint hover:text-ink" onClick={() => tabs.closeTab(t.id)} title={`Close ${t.path}`}>
                <X size={12} />
              </button>
            </div>
          ))}
          {tabs.notice && <span className="ml-2 shrink-0 text-[10.5px] text-warn">{tabs.notice}</span>}
        </div>
        <div className="min-h-0 flex-1">
          {/* Chat panel: always mounted, hidden (never unmounted) while a file tab
              is active — DOM scroll, composer draft, in-flight streaming survive. */}
          <div style={{ display: tabs.activeTabId ? 'none' : undefined }} className="flex h-full min-h-0 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 text-[12px]">
          <Folder size={13} className="text-accent" />
          <span className="font-medium text-ink">{activeWs ? baseName(activeWs) : 'No workspace'}</span>
          <span className="text-faint">/</span>
          <span className="truncate text-mute">{activeMeta?.title || 'New conversation'}</span>
          {runConv && !(runConv.ws === activeWs && runConv.convId === activeConv) && (
            <span
              role="status"
              className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-1.5 text-[10px] text-accent"
              title="A run is in progress in another conversation — it keeps running in the background; switch back to watch it."
            >
              ● running in {baseName(runConv.ws)} / {store.workspaces[runConv.ws]?.conversations[runConv.convId]?.title || '…'}
            </span>
          )}
          {wsHeld && (
            <span
              className="shrink-0 text-[10px] text-faint"
              title="All agent tools run against the sidecar's configured workspace, so the re-point to this workspace is held until the in-flight run finishes."
            >
              sidecar on {baseName(wsAppliedDirRef.current!)} until run ends
            </span>
          )}
          <span
            className="ml-auto hidden shrink-0 font-mono text-[10.5px] text-faint sm:inline"
            title={ctxLimit != null ? `${formatTokens(ctxTokens)} of ${formatTokens(ctxLimit)} context tokens used (last request)` : 'Context usage appears after the first agent request'}
          >
            {ctxLimit != null ? `ctx ${formatTokens(ctxTokens)} / ${formatTokens(ctxLimit)}` : `ctx ${formatTokens(ctxTokens)}`}
            {(running || agentSteps > 0) && <span className="text-mute"> · step {agentSteps}/60</span>}
          </span>
          <button
            type="button"
            onClick={() => setPlanMode((v) => !v)}
            disabled={running}
            title={planMode ? 'Plan mode ON: read-only investigation, no writes or commands' : 'Turn on Plan mode: read-only investigation'}
            className={cn('rounded border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40', planMode ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line text-mute hover:bg-panel2 hover:text-ink')}
          >
            Plan
          </button>
          <button
            type="button"
            onClick={() => setScoutOn((v) => !v)}
            disabled={running}
            title={scoutOn ? 'Scout pre-pass ON: 3 parallel read-only probes when the engine allows (max-concurrency > 1)' : 'Scout pre-pass OFF'}
            className={cn('rounded border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40', scoutOn ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line text-mute hover:bg-panel2 hover:text-ink')}
          >
            Scout
          </button>
          <button
            type="button"
            onClick={() => setVerifyMode((v) => !v)}
            disabled={running}
            title={verifyMode ? 'Verify mode ON: the run must pass lint/test before it can finish' : 'Verify mode OFF'}
            className={cn('rounded border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40', verifyMode ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line text-mute hover:bg-panel2 hover:text-ink')}
          >
            Verify
          </button>
          <button
            type="button"
            onClick={() => setCriticMode((v) => !v)}
            disabled={running}
            title={criticMode ? 'Critic ON: a model reviews the diff and can bounce it back for fixes before the run finishes' : 'Critic OFF'}
            className={cn('rounded border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40', criticMode ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line text-mute hover:bg-panel2 hover:text-ink')}
          >
            Critic
          </button>
          <button
            type="button"
            onClick={() => setDiffViewOpen(true)}
            disabled={!activeWs}
            title="Review the working-tree vs HEAD diff"
            className={cn('flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40', diffViewOpen ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line text-mute hover:bg-panel2 hover:text-ink')}
          >
            <GitCommit size={13} /> Diff
          </button>
          <button
            type="button"
            onClick={() => setMemOpen(true)}
            disabled={!activeWs}
            title={`Repository memory bank + learnings (${memory.learnings.length} learning${memory.learnings.length === 1 ? '' : 's'})`}
            className={cn('flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40', memOpen ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line text-mute hover:bg-panel2 hover:text-ink')}
          >
            <BookmarkPlus size={13} /> Memory{memory.learnings.length ? ` (${memory.learnings.length})` : ''}
          </button>
          <button
            type="button"
            className="rounded border border-line px-2 py-0.5 text-[11px] text-mute hover:bg-panel2 hover:text-ink disabled:opacity-40"
            onClick={forkConversation}
            disabled={!activeWs || running}
            title="Fork this conversation into a new thread"
          >
            <GitFork size={13} />
          </button>
          <button
            type="button"
            className="rounded border border-line px-2 py-0.5 text-[11px] text-mute hover:bg-panel2 hover:text-ink disabled:opacity-40"
            onClick={exportTranscript}
            disabled={!activeWs || messages.length === 0}
            title="Export transcript as Markdown"
          >
            <Download size={13} />
          </button>
          <button
            type="button"
            className="rounded border border-line px-2 py-0.5 text-[11px] text-mute hover:bg-panel2 hover:text-ink disabled:opacity-40"
            onClick={undoLastCommit}
            disabled={!activeWs || running || commits.length === 0}
            title="Undo last commit (changes stay in the worktree)"
          >
            <Undo2 size={13} />
          </button>
          <button
            type="button"
            className={cn('rounded border px-2 py-0.5 text-[11px] disabled:opacity-40', showCheckpoints ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line text-mute hover:bg-panel2 hover:text-ink')}
            onClick={() => setShowCheckpoints((o) => !o)}
            disabled={!activeWs}
            title="Checkpoints — snapshot transcript + workspace, restore on a wrong turn"
          >
            <BookmarkPlus size={13} />
          </button>
          <button
            className="rounded border border-line px-2 py-0.5 text-[11px] text-mute hover:bg-panel2 hover:text-ink disabled:opacity-40"
            onClick={() => newChat(activeWs)}
            disabled={!activeWs}
            title="New conversation in this workspace"
          >
            + chat
          </button>
        </div>
        {showCheckpoints && activeWs && (
          <SidebarSection title="Checkpoints" icon={<BookmarkPlus size={13} />} defaultOpen={false}>
          <div className="shrink-0 border-b border-line bg-panel px-4 py-2">
            <div className="mb-1.5 flex items-center">
              <button
                type="button"
                className="ml-auto rounded border border-line px-2 py-px text-[10.5px] normal-case tracking-normal text-mute hover:bg-panel2 hover:text-ink disabled:opacity-40"
                onClick={createCheckpoint}
                disabled={!activeConv || running}
                title="Snapshot the transcript and workspace HEAD"
              >
                + checkpoint
              </button>
            </div>
            {checkpoints.length === 0 ? (
              <div className="text-[11px] italic text-faint">No checkpoints yet — snapshot before a risky run, restore when the loop goes off a cliff.</div>
            ) : (
              <div className="max-h-36 space-y-1 overflow-auto">
                {checkpoints.map((cp) => (
                  <div key={cp.id} className="flex items-center gap-2 rounded border border-line px-2 py-1">
                    <span className="shrink-0 font-mono text-[10.5px] text-accent">{cp.label}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-mute">{new Date(cp.time).toLocaleString()} · {cp.messages} msgs · {cp.todos.length} todos</span>
                    <button
                      type="button"
                      title={`Restore checkpoint ${cp.label}`}
                      onClick={() => restoreCheckpoint(cp)}
                      disabled={running}
                      className="shrink-0 rounded p-0.5 text-faint hover:bg-panel hover:text-ok disabled:opacity-40"
                    >
                      <RotateCcw size={12} />
                    </button>
                    <button
                      type="button"
                      title="Delete checkpoint"
                      onClick={() => deleteCheckpoint(cp.id)}
                      className="shrink-0 rounded p-0.5 text-faint hover:bg-panel hover:text-danger"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          </SidebarSection>
        )}

        <div
          ref={transcriptRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            // Hidden chat panel (file tab active): dims are all 0, the stick
            // check would mis-fire as "pinned" — skip it.
            if (tabs.activeTabId) return;
            transcriptStick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="flex-1 overflow-auto bg-panel2 space-y-4 p-4"
        >
          {planMode && (
            <div className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-[11.5px] text-accent flex items-center gap-2">
              <BrainCircuit size={13} className="shrink-0" />
              <span>Plan mode is on — the agent investigates read-only and cannot write files or run commands. Turn it off to apply changes.</span>
            </div>
          )}
          {coderSafeMode && (
            <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[11.5px] text-warn flex items-center gap-2">
              <span>🛡</span>
              <span>Safe mode is on — destructive commands (e.g. <code className="font-mono">rm -rf /</code>, <code className="font-mono">git push --force</code>, piping a download into a shell) are blocked. Turn it off in the sidebar only for trusted workspaces.</span>
            </div>
          )}
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
                ) : g.items[0].displayName && g.items[0].collapsed ? (
                  <ReportBlock message={g.items[0]} />
                ) : (
                  <div className={cn("p-3 rounded-lg border mb-4", g.items[0].role === 'user' ? 'bg-panel border-line' : 'bg-panel border-accent/30')}>
                    <div className="font-semibold text-xs text-faint mb-1">{g.items[0].displayName ?? (g.items[0].role === 'assistant' ? 'Garrulous' : g.items[0].role)}</div>
                    {g.items[0].attachments?.length ? (
                      <div className="flex flex-wrap gap-1.5 mb-1.5">
                        {g.items[0].attachments.map((a, i) => (
                          <span key={i} className="inline-flex items-center gap-1 rounded-full border border-line bg-panel2 px-2 py-0.5 text-[11.5px] text-ink">{a.kind === 'image' ? <Image size={11} /> : <File size={11} />} {a.name}</span>
                        ))}
                      </div>
                    ) : null}
                    {g.items[0].content && (
                      g.items[0].role === 'assistant' || g.items[0].displayName
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
          {llmPhase && (
            <div className="mb-2 flex items-center gap-2 rounded-md border border-accent/25 bg-accent/8 px-2.5 py-1.5 text-[11.5px] text-mute">
              <BrainCircuit size={13} className="animate-pulse text-accent" />
              <span className="font-medium text-ink">
                {llmPhase.stage === 'prefill' ? 'Model reading context (prefill)' : 'Model writing (decode)'}
              </span>
              <span className="text-faint">
                · {llmPhase.label} · {((nowTick - llmPhase.since) / 1000).toFixed(1)}s · {llmPhase.chars.toLocaleString()} chars
              </span>
            </div>
          )}
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
          {showCoderParams && (
            <div className="rounded-md border border-line bg-panel2 px-3 py-2 mb-2">
              <div className="flex items-center gap-4 flex-wrap">
                <label className="flex items-center gap-1.5 text-[12px] text-mute">
                  <Toggle checked={coderParams.thinking} onChange={(v) => setCoderParams({ ...coderParams, thinking: v })} /> thinking
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-mute" title="Reasoning effort sent to the engine as reasoning_effort (low/medium/high/xhigh). Default follows the thinking toggle; choosing a level forces thinking on.">
                  think level
                  <SelectField
                    value={coderParams.thinkLevel || ''}
                    onChange={(v) => setCoderParams({ ...coderParams, thinkLevel: (v || undefined) as CoderParams['thinkLevel'] })}
                    options={[
                      { value: '', label: 'default' },
                      { value: 'low', label: 'low' },
                      { value: 'medium', label: 'medium' },
                      { value: 'high', label: 'high' },
                      { value: 'xhigh', label: 'xhigh' },
                    ]}
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-mute" title="Mark the system prompt with cache_control so the engine can cache it across turns (prefix caching). Only enable if your engine supports it.">
                  <Toggle checked={!!coderParams.promptCache} onChange={(v) => setCoderParams({ ...coderParams, promptCache: v })} /> prompt cache
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-mute">
                  temp <NumberField value={coderParams.temperature ?? null} onChange={(v) => setCoderParams({ ...coderParams, temperature: v })} onEmpty={() => setCoderParams({ ...coderParams, temperature: undefined })} empty />
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-mute">
                  top_p <NumberField value={coderParams.topP ?? null} onChange={(v) => setCoderParams({ ...coderParams, topP: v })} onEmpty={() => setCoderParams({ ...coderParams, topP: undefined })} empty />
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-mute">
                  top_k <NumberField value={coderParams.topK ?? null} onChange={(v) => setCoderParams({ ...coderParams, topK: v })} onEmpty={() => setCoderParams({ ...coderParams, topK: undefined })} empty />
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-mute">
                  seed <NumberField value={coderParams.seed ?? null} onChange={(v) => setCoderParams({ ...coderParams, seed: v })} onEmpty={() => setCoderParams({ ...coderParams, seed: undefined })} empty />
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-mute" title="Optional model id for the critic (defaults to the supervisor's model). Empty = same model reviews the diff.">
                  critic
                  <input
                    value={coderParams.criticModel ?? ''}
                    onChange={(e) => setCoderParams({ ...coderParams, criticModel: e.target.value })}
                    placeholder="same model"
                    className="w-28 bg-inset border border-line rounded px-1.5 py-0.5 text-[11px] outline-none focus:border-accent/50"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-mute" title="Rewrite the agent's user-facing summaries to sound human — no em dashes, no buzzwords, no empty framing. Content-only replies that trip the tell-gate are silently re-written.">
                  <Toggle checked={!!coderParams.humanize} onChange={(v) => setCoderParams({ ...coderParams, humanize: v })} /> humanize
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-mute">
                  voice
                  <SelectField
                    value={(coderParams.voiceProfile as VoiceProfile) || 'technical'}
                    onChange={(v) => setCoderParams({ ...coderParams, voiceProfile: v })}
                    disabled={!coderParams.humanize}
                    options={VOICE_PROFILES.map((p) => ({ value: p.value, label: p.label }))}
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-mute">
                  lens
                  <SelectField
                    value={coderParams.reviewLens || ''}
                    onChange={(v) => setCoderParams({ ...coderParams, reviewLens: v })}
                    options={CODING_LENSES.map((l) => ({ value: l.value, label: l.label }))}
                  />
                </label>
                <button type="button" onClick={() => setCoderParams({ ...DEFAULT_CODER_PARAMS })} className="ml-auto text-[11px] text-faint hover:text-ink">reset</button>
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={openPicker} disabled={running || !activeWs} title="Attach workspace files">
              <Paperclip size={14} />
            </Button>
            <Button variant="ghost" onClick={() => setShowCoderParams((v) => !v)} disabled={!activeWs} title="Sampling params (thinking, temperature, top_p, top_k, seed)">
              <SlidersHorizontal size={14} />
            </Button>
            <input 
              className="flex-1 bg-inset border border-line rounded px-3 py-1.5 text-sm outline-none focus:border-accent/50" 
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && onSubmit()}
              placeholder={pendingQuestion ? "Use the popup above to approve or disapprove…" : activeWs ? "Instruct the coder agent..." : "Add a workspace to begin"}
              disabled={running || !activeWs || pendingQuestion !== null}
            />
            {running ? (
               <Button variant="danger" onClick={stop} disabled={runElsewhere}
                 title={runElsewhere && runConv
                   ? `Run is in ${baseName(runConv.ws)} / ${store.workspaces[runConv.ws]?.conversations[runConv.convId]?.title || '…'} — switch to that conversation to stop it.`
                   : 'Stop the running agent'}><Square size={14} /> Stop</Button>
            ) : (
               <Button variant="primary" onClick={onSubmit} disabled={!activeWs && attachments.length === 0 || pendingQuestion !== null}><Play size={14} /> Run</Button>
            )}
          </div>
          {activeWs && (
            <div className={cn('mt-2 text-[10.5px]', coderSafeMode ? 'text-faint' : 'font-medium text-danger')}>
              {coderSafeMode
                ? `Agent runs shell commands locally in ${baseName(activeWs)} — destructive commands are blocked by Safe Mode.`
                : `Agent runs shell commands locally in ${baseName(activeWs)} — Safe Mode is OFF, destructive commands are allowed.`}
            </div>
          )}
        </div>
          </div>
          {tabs.tabs.map((t) => (
            <div key={t.id} style={{ display: tabs.activeTabId === t.id ? undefined : 'none' }} className="flex h-full min-h-0 flex-col">
              <Suspense fallback={<div className="flex h-full items-center justify-center text-[11.5px] text-faint">Loading editor…</div>}>
                <LazyEditorPane
                  tab={t}
                  active={tabs.activeTabId === t.id}
                  onDocChange={(id, doc) => tabs.onDocChange(id, doc)}
                  onSave={(id) => { void tabs.saveTab(id); }}
                  onReload={(id) => { void tabs.reloadTab(id); }}
                  onUndo={() => tabs.undoEdit(t.id)}
                  onDiff={(path) => setFileDiffPath(path)}
                  onResolve={(id, kind) => tabs.resolveConflict(id, kind)}
                  undoDisabled={running}
                />
              </Suspense>
            </div>
          ))}
        </div>
      </div>

      {/* Right: todos (agent-maintained via todo_write; the user can also
          edit directly — edits reach the agent on its next LLM call via the
          per-turn system-prompt injection) */}
      <div className="flex w-64 flex-col border-l border-line bg-panel">
        <div className="p-2 border-b border-line text-sm font-semibold flex items-center gap-2">
          <CheckSquare size={14} /> Todos
          {todosUpdatedAt != null && (
            <span className="ml-auto font-mono text-[10px] font-normal text-faint" title="Last updated (agent todo_write or your edit)">
              {new Date(todosUpdatedAt).toLocaleTimeString([], { hour12: false })}
            </span>
          )}
        </div>
        <div className="flex-1 p-2 text-[11.5px] text-mute overflow-auto">
          {todos.length === 0 ? 'No pending tasks.' : (
            <div className="space-y-1.5">
              {todos.map((t, i) => (
                <div key={i} className={cn("group flex items-start gap-2", t.status === 'completed' ? 'opacity-50 line-through' : '')}>
                  <button
                    type="button"
                    className="mt-0.5 shrink-0 cursor-pointer hover:opacity-70"
                    title={`${t.status} — click to advance to ${t.status === 'pending' ? 'in_progress' : t.status === 'in_progress' ? 'completed' : 'pending'}`}
                    onClick={() => cycleTodo(i)}
                  >
                    {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '⏳' : '☐'}
                  </button>
                  <span className={cn('min-w-0 flex-1 break-words', t.status === 'in_progress' ? 'text-accent font-medium' : '')}>{t.content}</span>
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 text-faint opacity-0 group-hover:opacity-100 hover:text-danger"
                    title="Remove task (takes effect on the agent's next step)"
                    onClick={() => removeTodo(i)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="shrink-0 border-t border-line p-2">
          <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); addTodo(todoDraft); setTodoDraft(''); }}>
            <input
              value={todoDraft}
              onChange={(e) => setTodoDraft(e.target.value)}
              placeholder="add a task…"
              className="min-w-0 flex-1 rounded border border-line bg-inset px-2 py-1 text-[11px] outline-none focus:border-accent/50"
            />
            <Button size="sm" variant="ghost" type="submit" disabled={!todoDraft.trim()} title="Add a task to the agent's plan — visible to it on its next step">
              <Plus size={13} /> add
            </Button>
          </form>
          <p className="mt-1 text-[10px] text-faint">Click a status to cycle it · your edits reach the agent on its next step</p>
        </div>
      </div>

      {pendingQuestion && (
        <HitlDialog
          tone="accent"
          icon={<HelpCircle size={15} />}
          title="Agent is waiting for your input"
          subtitle="Review the request, then approve or disapprove to continue the run."
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => resumeFromAsk(askNote.trim() ? `Disapproved. ${askNote.trim()}` : 'Disapproved.')}>
                Disapprove
              </Button>
              <Button variant="primary" size="sm" onClick={() => resumeFromAsk(askNote.trim() ? `Approved. ${askNote.trim()}` : 'Approved.')}>
                Approve
              </Button>
            </>
          }
        >
          <div className="whitespace-pre-wrap text-ink/90">{pendingQuestion}</div>
          <textarea
            value={askNote}
            onChange={(e) => setAskNote(e.target.value)}
            placeholder="Optional note to send back with your decision…"
            rows={2}
            className="mt-2 w-full resize-y rounded-md border border-line bg-inset px-2 py-1.5 text-[12px] outline-none focus:border-accent/50"
          />
        </HitlDialog>
      )}
      {pendingApproval && (
        <HitlDialog
          tone="warn"
          width={480}
          icon={<Shield size={15} />}
          title="Agent requests approval"
          subtitle={<span><span className="font-mono text-accent">{pendingApproval.name}</span> is set to <span className="font-mono">ask</span> in this workspace.</span>}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => approvalResolveRef.current?.(false)}>
                Deny
              </Button>
              <Button variant="primary" size="sm" onClick={() => approvalResolveRef.current?.(true)}>
                Approve once
              </Button>
            </>
          }
        >
          <pre className="m-0 whitespace-pre-wrap break-all font-mono text-[12px] text-ink">{redactSecrets(pendingApproval.detail) || '(no details)'}</pre>
        </HitlDialog>
      )}
      {riskyApproval && (
        <HitlDialog
          tone="warn"
          icon={<Shield size={15} />}
          title="Risky command — approval required"
          subtitle={<span>This command {riskyApproval.reason}. Approve it for this run, or remember it for this workspace so it won&apos;t prompt again.</span>}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => riskyResolveRef.current?.('deny')}>
                Deny
              </Button>
              <Button variant="ghost" size="sm" onClick={() => riskyResolveRef.current?.('once')}>
                Approve once
              </Button>
              <Button variant="primary" size="sm" onClick={() => riskyResolveRef.current?.('remember')}>
                Approve &amp; remember
              </Button>
            </>
          }
        >
          <pre className="m-0 whitespace-pre-wrap break-all font-mono text-[12px] text-ink">{redactSecrets(riskyApproval.command) || '(no command)'}</pre>
        </HitlDialog>
      )}

      {/* Diff-review viewer: working-tree vs HEAD, opened from the toolbar "Diff" button. */}
      <DiffReviewModal
        open={diffViewOpen}
        mode="view"
        title="Working tree vs HEAD"
        onClose={() => setDiffViewOpen(false)}
        fetchDiff={coderDiff}
      />
      {/* Commit-approval gate: the agent asked to commit while the gate is ON. */}
      <DiffReviewModal
        open={commitReviewOpen}
        mode="approve"
        title="Approve commit?"
        onClose={() => commitResolveRef.current?.(false)}
        onApprove={() => commitResolveRef.current?.(true)}
        fetchDiff={coderDiff}
      />
      {/* Per-file diff vs HEAD (opened from a file tab's Diff button; staged
          changes included — `git diff HEAD`). */}
      <DiffReviewModal
        open={fileDiffPath !== null}
        mode="view"
        title={fileDiffPath ?? undefined}
        onClose={() => setFileDiffPath(null)}
        fetchDiff={() => (fileDiffPath ? fetchFileDiff(fileDiffPath) : Promise.resolve({ files: [], diff: '' }))}
      />
      {/* Self-improving memory: per-repo bank (markdown) + extracted learnings. */}
      <MemoryModal
        open={memOpen}
        onClose={() => setMemOpen(false)}
        memory={memory}
        onSaveBank={(bank) => coderMemorySetBank(bank).then((m) => { if (wsAppliedDirRef.current === activeWsDir) { setMemory(m); memoryRef.current = m; } })}
        onDropLearning={(id) => coderMemoryDropLearning(id).then((m) => { if (wsAppliedDirRef.current === activeWsDir) { setMemory(m); memoryRef.current = m; } })}
        onChanged={() => loadMemory()}
      />
      {showDir && (
        <DirBrowser
          initialPath="~"
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
                    <span className="text-danger text-[10px]">over 50 MB</span>
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
          <span className="text-[11px] text-faint">Select files (≤50 MB each). Images embed as pictures; others inline as text.</span>
          <Button variant="primary" size="sm" disabled={selectedNodes.length === 0} onClick={() => onAttachSelected(selectedNodes)}>
            Attach {selectedNodes.length || ''} selected
          </Button>
        </div>
      </div>
    </div>
  );
}
