// Tool schemas the coder harness exposes to the model, plus the allow-lists
// and permission-tier types that gate which of them a given run/subagent may
// use. Pure data + predicates — no UI, no closure state.

export const TOOLS = [
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
      name: "udiff_edit",
      description: "Apply a unified diff format patch to a file. Used as an alternative to apply_patch. The diff string should be in standard unified diff format (with ---, +++, and @@ headers).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          diff: {
            type: "string",
            description: "The full unified diff text to apply."
          }
        },
        required: ["path", "diff"]
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
      description: "Search for a regex pattern in files using ripgrep. Returns matching lines and file paths up to the match limit.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "Subdirectory path relative to workspace root to restrict the search to." },
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
      description: "Find files matching a glob pattern relative to the workspace root or specified subfolder.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "Subdirectory path relative to workspace root to restrict the search to." }
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
      name: "browser",
      description: "Built-in headless web browser (runs page JavaScript, unlike web_fetch). Use for JS-rendered pages. Actions: navigate (url), snapshot (page URL/title/Markdown), click (selector), fill (selector, value), press_key (key, optional selector), select_option (selector, value), evaluate (expression), wait_for (selector, optional timeout), close, status. Prefer web_fetch for simple static pages; use the browser when the content only renders via JavaScript.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["navigate", "snapshot", "click", "fill", "press_key", "select_option", "evaluate", "wait_for", "close", "status"] },
          url: { type: "string", description: "For navigate." },
          wait_until: { type: "string", enum: ["domcontentloaded", "load"], description: "navigate only, default domcontentloaded." },
          selector: { type: "string", description: "CSS selector for click/fill/press_key/select_option/wait_for." },
          value: { type: "string", description: "For fill / select_option." },
          key: { type: "string", description: "press_key: key name, e.g. \"Enter\"." },
          expression: { type: "string", description: "evaluate: JavaScript expression to run in the page." },
          timeout: { type: "number", description: "wait_for: seconds to poll (default 5, max 15)." }
        },
        required: ["action"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "obs_recall",
      description: "Page through the full original content of a large tool result that was replaced with a placeholder to save context (see the placeholder's 'retrieve' line for its id). Call repeatedly with the returned next_offset until eof is true.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Observation id from the placeholder, e.g. obs_ab12cd34ef56..." },
          offset: { type: "number", description: "Byte offset to resume from — 0 for the first call, then the previous response's next_offset." }
        },
        required: ["id"]
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
          component: { type: "string", description: "The architectural component this applies to (e.g., auth, api, ui)" },
          scope: { type: "string", description: "The scope of the learning (e.g., any, production, prototype)" },
          target_key: { type: "string", description: "A unique key for the constraint (e.g., auth_method, db_engine). Used to supersede older rules with the same key." },
          value: { type: "string", description: "The value for the target_key (e.g., oauth2, postgresql)" },
          text: { type: "string", description: "One concise, self-contained learning (imperative, e.g. 'Run `pnpm test` (not npm) — this repo uses pnpm.')." },
          kind: { type: "string", enum: ["success", "tip", "avoid"], description: "success = a working approach/fix; tip = a convention/fact/command; avoid = a mistake or anti-pattern." }
        },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "memory_recall",
      description: "Search this repo's FULL learning history for a keyword or phrase — not just the most recent 15 learnings injected into your system prompt. Use it when you suspect a past run already hit this problem but its learning aged out of the injected window.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword(s) or phrase to search for, matched case-insensitively against learning text and task." },
          kind: { type: "string", enum: ["success", "tip", "avoid"], description: "Optional filter to a single learning kind." },
          limit: { type: "number", description: "Max matches to return, most recent first (default 10, max 30)." }
        },
        required: ["query"]
      }
    }
  }
];

export type PermTier = 'allow' | 'ask' | 'deny';
export interface PermConfig { tools: Record<string, PermTier>; denyPaths: string[]; approvedCommands?: string[]; }
export const DEFAULT_PERMS: PermConfig = { tools: {}, denyPaths: [] };
/** Tools that mutate the workspace or run code — gated by plan mode + permissions. */
export const MUTATING_TOOLS = new Set(['write', 'edit', 'apply_patch', 'udiff_edit', 'bash', 'git_commit', 'git_branch', 'git_worktree', 'git_pr', 'memory_update', 'subagent']);

import type { AppSettings } from './types';
export function filterToolsByConfig(tools: any[], config: any): any[] {
  let filtered = tools;
  if (config && config.coderUdiffEditEnabled === false) {
    filtered = filtered.filter((t) => t.function.name !== 'udiff_edit');
  }
  if (config && config.coderRepoMapEnabled === false) {
    filtered = filtered.filter((t) => t.function.name !== 'repo_map');
  }
  return filtered;
}
/** Hard ceiling on agent turns per run, user-adjustable (coderParams.maxAgentSteps). */
export const DEFAULT_MAX_AGENT_STEPS = 60;
/** Tool names the read-only scout and plan mode may use. */
export const READONLY_TOOL_NAMES = new Set(['todo_write', 'read', 'grep', 'glob', 'ast_grep', 'web_fetch', 'web_search', 'git_diff', 'ask_user', 'bash_poll', 'delegate', 'repo_search', 'obs_recall', 'memory_recall']);
/** Tool names an implementation `subagent` worker may use by default — the
 *  same set `runWorker` falls back to when no allow-list is given. Used to
 *  validate a model-supplied `tools` allow-list for the `subagent` tool
 *  (unlike `delegate`, which is read-only-only, `subagent`'s whole point is
 *  writing/running things, so it must NOT be filtered against
 *  READONLY_TOOL_NAMES — that would silently strip write/edit/bash). */
export const WORKER_TOOL_NAMES = new Set(['read', 'grep', 'glob', 'ast_grep', 'web_fetch', 'web_search', 'browser', 'repo_search', 'write', 'edit', 'apply_patch', 'udiff_edit', 'bash', 'bash_poll', 'git_diff', 'delegate']);

/** Filter a model-supplied tool allow-list against `allowed`, falling back to
 *  `undefined` (caller's default set) when nothing survives the filter — an
 *  empty array is still truthy in JS, so without this an all-invalid or
 *  all-filtered-out request would silently leave a subagent with ZERO tools
 *  instead of a sensible default. */
export function filterToolAllowList(raw: unknown, allowed: Set<string>): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const filtered = raw.map(String).filter((t) => allowed.has(t));
  return filtered.length ? filtered : undefined;
}

/** Binaries bash may run in plan mode (inspection only). */
const READONLY_BASH = new Set(['find', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'fd', 'file', 'stat', 'du', 'df', 'tree', 'pwd', 'which', 'uname', 'date', 'sort', 'uniq', 'diff', 'nl', 'basename', 'dirname', 'realpath', 'readlink', 'md5sum', 'sha256sum']);
/** Read-only git subcommands allowed in plan mode.
 *  Note: branch, tag, and remote are omitted because they write/mutate state
 *  when passed flags or arguments. */
const READONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'blame', 'shortlog', 'describe', 'ls-files', 'rev-parse']);

/** True when a bash command is pure inspection (plan mode). Conservative:
 *  rejects shell composition (redirection, pipes, chaining, substitution)
 *  and newlines outright, then allow-lists the first word — and for git, the subcommand. */
export function isReadOnlyCommand(cmd: string): boolean {
  if (!cmd) return false;
  if (/[>|;&`\(\n\r]|\$\(/.test(cmd) || cmd.includes('\n') || cmd.includes('\r')) return false;
  const words = cmd.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const first = words[0].replace(/^.*[/\\]/, '');
  if (first === 'git') {
    if (words.length < 2 || !READONLY_GIT.has(words[1])) return false;
    if (words[1] === 'diff' && words.some((w) => w.startsWith('--output'))) return false;
    return true;
  }
  if (!READONLY_BASH.has(first)) return false;
  if (first === 'find' && words.some((w) => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(w))) return false;
  if (first === 'fd' && words.some((w) => ['-x', '-X', '--exec', '--exec-batch'].includes(w))) return false;
  if (first === 'rg' && words.some((w) => w.startsWith('--pre'))) return false;
  if (first === 'sort' && words.some((w) => w === '-o' || w.startsWith('--output'))) return false;
  if (first === 'uniq') {
    const nonFlags = words.slice(1).filter((w) => !w.startsWith('-'));
    if (nonFlags.length >= 2) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) tool namespacing — `mcp__<server>__<tool>`.
// The control plane (desktop/control/src/mcp.rs) owns the connections; the web
// side only needs the naming rules + the per-server tier fallback so the
// client-side gates match the server's `tier_for` exactly.
// ---------------------------------------------------------------------------
/** Prefix every MCP-exposed tool name carries. */
export const MCP_NAME_PREFIX = 'mcp__';

/** Split `mcp__<server>__<tool>` into `{ server, tool }`, or null for any
 *  other name. Server names never contain `_` (sanitized server-side), so
 *  the first `__` after the prefix is the separator; the tool part may
 *  itself contain `__` (mangled from a server-side name that did). */
export function splitMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(MCP_NAME_PREFIX)) return null;
  const rest = name.slice(MCP_NAME_PREFIX.length);
  const idx = rest.indexOf('__');
  if (idx <= 0 || idx === rest.length - 2) return null;
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}

/** The server-level permission key for an MCP tool name (`mcp__<server>`),
 *  or null for non-MCP names. */
export function mcpServerKey(name: string): string | null {
  const m = splitMcpName(name);
  return m ? `${MCP_NAME_PREFIX}${m.server}` : null;
}

/** The effective tier for a (possibly MCP-namespaced) tool: a per-tool row
 *  wins, then the per-server row for MCP names, then `allow` — mirrors the
 *  control plane's `tier_for` so client-side gating and the server's
 *  re-check never disagree. */
export function mcpToolTier(perms: PermConfig, name: string): PermTier {
  const exact = perms.tools[name];
  if (exact === 'allow' || exact === 'ask' || exact === 'deny') return exact;
  const key = mcpServerKey(name);
  if (key) {
    const server = perms.tools[key];
    if (server === 'allow' || server === 'ask' || server === 'deny') return server;
  }
  return 'allow';
}

/** An LLM tool schema for one MCP catalog entry (same shape as TOOLS). */
export function mcpToolSchema(t: { name: string; description: string; parameters: Record<string, unknown> }): {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
} {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description || `MCP tool ${t.name}`,
      parameters: t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} },
    },
  };
}

export const PURE_DEDUP_TOOLS = new Set(['read', 'grep', 'glob', 'ast_grep', 'web_fetch', 'web_search', 'repo_search', 'obs_recall', 'memory_recall']);
export const READ_STREAK_TOOLS = new Set(['read', 'grep', 'glob', 'ast_grep', 'web_fetch', 'web_search', 'repo_search', 'obs_recall', 'memory_recall']);

export const hashToolCall = (name: string, argsStr: string): string => {
  let norm = argsStr;
  try {
    const o = JSON.parse(argsStr);
    if (o && typeof o === 'object') norm = JSON.stringify(o, Object.keys(o).sort());
  } catch { /* not JSON */ }
  return `${name}|${norm}`;
};

export const isErrorResult = (s: string): boolean => {
  try { const o = JSON.parse(s); return !!(o && typeof o === 'object' && 'error' in o); } catch { return false; }
};

export const withNote = (resultStr: string, note: string): string => {
  try {
    const o = JSON.parse(resultStr);
    if (o && typeof o === 'object') { (o as Record<string, unknown>)._note = note; return JSON.stringify(o); }
  } catch { /* not JSON */ }
  return `${resultStr}\n\n[SYSTEM] ${note}`;
};

export const SCOUT_PROBES = [
  { label: 'structure', goal: 'Map the relevant code structure: key files, modules, entry points, and how they connect. Be concrete with paths.' },
  { label: 'usages', goal: 'Find existing usages, tests, and examples related to the task. Quote exact paths.' },
  { label: 'history', goal: 'Summarize recent related work or docs that bear on the task (from file layout, changelogs, notes, or git diffs of related areas).' },
];

export const RISKY_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(-[rf]*\s+)?(\/|~|\.\.)(\/|\s|$)/i, 'deletes root, home, or parent directory'],
  [/\b(mkfs|dd|fdisk|parted)\b/i, 'formats or overwrites disk partitions'],
  [/\bssh\b(?!-)/i, 'opens an SSH connection to a remote host'],
  [/\b(scp|rsync|sftp)\b/i, 'transfers files to/from a remote host'],
  [/\b(docker|podman)\b/i, 'runs containers'],
  [/\b(kubectl|helm|terraform\s+apply|ansible)\b/i, 'applies infrastructure changes'],
  [/\b(aws|gcloud|az)\b[^]*?\b(ec2|s3|deploy|apply|create|delete|update|push)\b/i, 'mutates cloud resources'],
  [/\b(apt|apt-get|yum|dnf|apk)\b\s+(install|remove|upgrade|update)\b/i, 'changes system packages'],
  [/\b(npm\s+install\s+-g|pnpm\s+add\s+-g|yarn\s+global\s+add)\b/i, 'installs a global package'],
];

export const detectRisky = (cmd: string): string | null => {
  for (const [re, why] of RISKY_PATTERNS) if (re.test(cmd)) return why;
  return null;
};

export const normalizeCommand = (cmd: string): string => cmd.replace(/\s+/g, ' ').trim();

export const isApprovedCommand = (cmd: string, approved: string[] = []): boolean => {
  const c = normalizeCommand(cmd);
  return approved.some((a) => {
    const na = normalizeCommand(a);
    return c === na || c.startsWith(na + ' ');
  });
};

