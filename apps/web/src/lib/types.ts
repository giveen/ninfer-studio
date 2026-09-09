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
  kind: 'image' | 'video';
  name: string;
  dataUrl: string;
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
  role: 'system' | 'user' | 'assistant';
  content: string;
  reasoning?: string;
  attachments?: ChatAttachment[];
  meta?: MessageMeta;
  model?: string;
  error?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
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
