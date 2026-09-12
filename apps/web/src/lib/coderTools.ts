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
        required: ["id", "offset"]
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

export type PermTier = 'allow' | 'ask' | 'deny';
export interface PermConfig { tools: Record<string, PermTier>; denyPaths: string[]; approvedCommands?: string[]; }
export const DEFAULT_PERMS: PermConfig = { tools: {}, denyPaths: [] };
/** Tools that mutate the workspace or run code — gated by plan mode + permissions. */
export const MUTATING_TOOLS = new Set(['write', 'edit', 'apply_patch', 'bash', 'git_commit', 'git_branch', 'git_worktree', 'subagent']);
/** Hard ceiling on agent turns per run, user-adjustable (coderParams.maxAgentSteps). */
export const DEFAULT_MAX_AGENT_STEPS = 60;
/** Tool names the read-only scout and plan mode may use. */
export const READONLY_TOOL_NAMES = new Set(['todo_write', 'read', 'grep', 'glob', 'ast_grep', 'web_fetch', 'web_search', 'git_diff', 'ask_user', 'bash_poll', 'delegate', 'repo_search', 'obs_recall']);
/** Tool names an implementation `subagent` worker may use by default — the
 *  same set `runWorker` falls back to when no allow-list is given. Used to
 *  validate a model-supplied `tools` allow-list for the `subagent` tool
 *  (unlike `delegate`, which is read-only-only, `subagent`'s whole point is
 *  writing/running things, so it must NOT be filtered against
 *  READONLY_TOOL_NAMES — that would silently strip write/edit/bash). */
export const WORKER_TOOL_NAMES = new Set(['read', 'grep', 'glob', 'ast_grep', 'web_fetch', 'web_search', 'browser', 'repo_search', 'write', 'edit', 'apply_patch', 'bash', 'bash_poll', 'git_diff', 'delegate']);

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
export const READONLY_BASH = new Set(['find', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'fd', 'file', 'stat', 'du', 'df', 'tree', 'pwd', 'which', 'uname', 'date', 'sort', 'uniq', 'diff', 'nl', 'basename', 'dirname', 'realpath', 'readlink', 'md5sum', 'sha256sum']);
/** Read-only git subcommands allowed in plan mode. */
export const READONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'branch', 'tag', 'remote', 'blame', 'shortlog', 'describe', 'ls-files', 'rev-parse']);

/** True when a bash command is pure inspection (plan mode). Conservative:
 *  rejects shell composition (redirection, pipes, chaining, substitution)
 *  outright, then allow-lists the first word — and for git, the subcommand. */
export function isReadOnlyCommand(cmd: string): boolean {
  if (!cmd) return false;
  if (/[>|;&`]|\$\(/.test(cmd)) return false;
  const words = cmd.split(/\s+/).filter(Boolean);
  const first = words[0].replace(/^.*\//, '');
  if (first === 'git') return words.length >= 2 && READONLY_GIT.has(words[1]);
  return READONLY_BASH.has(first);
}
