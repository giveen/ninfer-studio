// Shared types mirroring the sidecar's API surface and the NInfer engine's
// HTTP contract (docs/serving.md).

export type EngineState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed' | 'external';

export interface EngineStatus {
  state: EngineState;
  pid: number | null;
  port: number | null;
  artifact: string | null;
  modelId: string | null;
  argv: string[] | null;
  startedAt: number | null;
  logPath: string | null;
  adopted: boolean;
  failReason: string | null;
  failHint?: string | null;
  maxContext?: number | null;
}

export interface GpuApp {
  pid: number;
  name: string;
  memMiB: number;
}

export interface GpuStats {
  available: boolean;
  name: string | null;
  memUsedMiB: number | null;
  memTotalMiB: number | null;
  utilPct: number | null;
  apps: GpuApp[];
}

export interface ModelArtifact {
  file: string;
  path: string;
  size: number;
  mtime: number;
  known: CatalogEntry | null;
  modelId: string | null;
  model: string | null;
  weights: string | null;
  repo: string | null;
}

export interface CatalogEntry {
  file: string;
  modelId: string;
  model: string;
  weights: string;
  repo: string;
  card: string;
  spec: string;
  vision: boolean;
}

export interface AppSettings {
  /** Root of the NInfer checkout/build. The ninfer-serve binary (build/apps/ninfer-serve),
   * the ninfer CLI, and the git source for pull/build are all derived from this. */
  ninferPath: string;
  modelsDir: string;
  enginePort: number;
  apiKey: string;
  hfCli: string;
  buildCommand: string;
  /** JSON object merged (as defaults) into every proxied /v1 request body. */
  defaultRequestParams: string;
  /** Global default reasoning effort injected into chat_template_kwargs.reasoning_effort for every proxied request (client fields win). '' = unset. */
  reasoningEffort: string;
  /** Coding harness: the directory the "Code" mode may read/write/execute within. Empty = not configured. */
  coderWorkspace: string;
}

export interface UpdateJob {
  id: string;
  action: 'pull' | 'build';
  cmd: string;
  pid: number | null;
  out: string;
  exitCode: number | null;
  done: boolean;
  failed: boolean;
  startedAt: number;
}

export interface LastStart {
  port: number;
  profile: EngineProfile;
  artifact: string | null;
  at: number;
}

export interface StatusPayload {
  engine: EngineStatus;
  engines?: EngineStatus[];
  lastStart?: LastStart | null;
  gpu: GpuStats;
  config: AppSettings;
  artifacts: ModelArtifact[];
  catalog: CatalogEntry[];
  downloads: DownloadRec[];
  update?: UpdateJob | null;
}

export interface DownloadRec {
  id: string;
  repo: string;
  file: string;
  localDir: string;
  pid: number | null;
  out: string;
  exitCode: number | null;
  done: boolean;
  failed: boolean;
  totalBytes?: number | null;
  downloadedBytes: number;
  speedBps: number;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Engine profile — one entry per ninfer-serve option. `undefined` means the
// flag is omitted and the engine executable default applies.
// ---------------------------------------------------------------------------
export interface EngineProfile {
  host?: string;
  port: number;
  apiKey?: string;
  modelId?: string;

  // context & memory
  maxContext?: number;
  kvCapacity?: number | 'auto' | '';
  prefillChunk?: number;
  defaultMaxTokens?: number;
  defaultThinkingBudget?: number;
  device?: number;

  // scheduling
  maxConcurrency?: number;
  maxPendingRequests?: number;
  pendingTimeoutMs?: number;
  logStatsIntervalMs?: number;

  // kv cache & context cache
  kvDtype?: 'bf16' | 'int8' | 'fp8' | 'nvfp4' | 'k8v4';
  noPrefixReuse?: boolean;
  deviceStateSlots?: number;
  hostStateSlots?: number;
  hostKvMib?: number;
  maxPrivateContinuations?: number;
  maxSharedPrefixes?: number;
  maxLongAnchorsPerContinuation?: number;

  // speculative decoding
  spec?: '' | 'mtp' | 'dflash' | 'dflash2';
  draftTokens?: number;
  lmHeadDraft?: boolean;

  // vision & media
  vision?: boolean;
  mediaCacheMib?: number;
  mediaLiveMib?: number;
  mediaPreprocessThreads?: number;
  maxRequestMib?: number;

  // sampling defaults
  noThinking?: boolean;
  preserveThinking?: boolean;
  greedy?: boolean;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;

  // logging & misc
  logLevel?: string;
  requestLogJsonl?: string;
  responseStoreMaxRecords?: number;
  responseStoreMaxMib?: number;
  contextCostPresets?: string;
  cors?: boolean;
  noCudaGraph?: boolean;
}

// ---------------------------------------------------------------------------
// Persisted engine profile state (per-user profile dir, not localStorage).
// Holds the live form, the chosen artifact, and the named saved profiles.
// ---------------------------------------------------------------------------
export interface SavedProfile {
  name: string;
  profile: EngineProfile;
}

export interface ProfileState {
  profile: EngineProfile | null;
  artifact: string | null;
  saved: SavedProfile[];
}

// ---------------------------------------------------------------------------
// Chat (OpenAI-compatible) — client-side message model
// ---------------------------------------------------------------------------
export interface ChatAttachment {
  kind: 'image' | 'video' | 'file';
  name: string;
  /** image/video: a data URL. Omitted for kind 'file'. */
  dataUrl?: string;
  /** file: workspace-relative path of the attached source file. */
  path?: string;
  /** file: text content of the attached source file. */
  content?: string;
}

export interface MessageMeta {
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  promptTokPerSec?: number;
  decodeTokPerSec?: number;
  ttftMs?: number;
  draftN?: number;
  draftNAccepted?: number;
  finishReason?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Stable id; assigned to streaming placeholders so delta updates can target
   *  a specific message instead of guessing by array index (C2). */
  id?: string;
  reasoning?: string;
  attachments?: ChatAttachment[];
  meta?: MessageMeta;
  model?: string;
  error?: boolean;
  /** Agent tool calls (assistant role). */
  tool_calls?: AgentToolCall[];
  /** Tool call ID (tool role). */
  tool_call_id?: string;
  /** Tool name (tool role). */
  name?: string;
}

export interface Conversation {
  id: string;
  title: string;
  /** Structured compaction summary (set by /compact). When present, the model
   * context is rebuilt from this summary + post-compaction messages, while the
   * full message history stays visible in the UI. */
  compactedSummary?: string;
  /** Number of messages in `messages` at compaction time (the split point). */
  compactedCount?: number;
  model: string;
  createdAt: number;
  messages: ChatMessage[];
}

export interface ChatParams {
  systemPrompt?: string;
  thinking: boolean;
  reasoningEffort?: '' | 'none' | 'low' | 'medium' | 'xhigh';
  preserveThinking?: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  greedy?: boolean;
}

// ---------------------------------------------------------------------------
// Coding harness ("Code" mode under Chat) — an agentic loop driven by the
// engine's native OpenAI tool-calling. The control plane executes the tools.
// ---------------------------------------------------------------------------
export interface AgentToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments emitted by the model. */
  arguments: string;
}

export interface CoderToolCall extends AgentToolCall {
  status?: 'running' | 'done' | 'error';
  result?: string;
  error?: string;
}

export interface CoderUserMsg {
  role: 'user';
  id: string;
  content: string;
}
export interface CoderAssistantMsg {
  role: 'assistant';
  id: string;
  content: string;
  reasoning?: string;
  toolCalls?: CoderToolCall[];
  meta?: MessageMeta;
  error?: boolean;
}
export interface CoderToolMsg {
  role: 'tool';
  id: string;
  toolCallId: string;
  name: string;
  content: string;
}
export type CoderMessage = CoderUserMsg | CoderAssistantMsg | CoderToolMsg;

export interface CoderTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

// Control-plane response shapes (mirrors apps/sidecar/server.js / Rust coder.rs).
export interface FileNode {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  size?: number;
  children?: FileNode[];
}
export interface CoderWorkspace {
  workspace: string;
  exists: boolean;
}
export interface CoderTree {
  root: string;
  nodes: FileNode[];
}
export interface CoderReadResult {
  path: string;
  content?: string;
  totalLines?: number;
  truncated?: boolean;
  lineCount?: number;
  binary?: boolean;
  note?: string;
}
export interface CoderWriteResult {
  path: string;
  bytes: number;
  created: boolean;
}
export interface CoderEditResult {
  path: string;
  replacements: number;
  error?: string;
}
export interface CoderExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** True when stdout/stderr exceeded the sidecar's output cap and was truncated. */
  truncated?: boolean;
  /** True when the command was refused by safe mode (see detectDestructive). */
  blocked?: boolean;
  cwd: string;
  error?: string;
}
export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}
export interface CoderGrepResult {
  matches: GrepMatch[];
  truncated: boolean;
  count: number;
}
export interface CoderGlobResult {
  files: string[];
}
export interface CoderWebFetch {
  url: string;
  status: number;
  contentType: string;
  content: string;
  truncated: boolean;
}
export interface CoderWebSearch {
  results: Array<{ title: string; url: string; snippet: string }>;
  query: string;
}
