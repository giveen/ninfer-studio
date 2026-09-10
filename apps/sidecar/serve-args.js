// Build the ninfer-serve command line for an engine profile.
//
// Extracted from server.js so it can be imported without booting the sidecar
// (server.js listens and probes engines at import time). This builder and the
// Rust twin in desktop/control/src/types.rs (build_serve_args) MUST stay in
// lockstep — scripts/args-parity.mjs and the Rust parity test fail on drift.

export function buildServeArgs(profile) {
  const p = profile || {};
  const a = [];
  const num = (v) => (v === null || v === undefined || v === '' ? null : String(v));
  const set = (flag, v) => { if (v !== null && v !== undefined) a.push(flag, String(v)); };
  const setFlag = (flag, v) => { if (v) a.push(flag); };

  set('--host', p.host);
  set('--port', p.port);
  set('--api-key', p.apiKey);
  set('--model-id', p.modelId);
  set('--max-context', num(p.maxContext));
  if (p.kvCapacity !== null && p.kvCapacity !== undefined && p.kvCapacity !== '') {
    a.push('--kv-capacity', String(p.kvCapacity)); // 'auto' or number
  }
  set('--max-concurrency', num(p.maxConcurrency));
  set('--max-pending-requests', num(p.maxPendingRequests));
  set('--pending-timeout-ms', num(p.pendingTimeoutMs));
  set('--prefill-chunk', num(p.prefillChunk));
  set('--log-stats-interval-ms', num(p.logStatsIntervalMs));
  set('--log-level', p.logLevel);
  set('--device', num(p.device));
  set('--context-cost-presets', p.contextCostPresets);
  set('--max-request-mib', num(p.maxRequestMib));
  set('--media-cache-mib', num(p.mediaCacheMib));
  set('--media-live-mib', num(p.mediaLiveMib));
  set('--media-preprocess-threads', num(p.mediaPreprocessThreads));
  set('--request-log-jsonl', p.requestLogJsonl);
  set('--response-store-max-records', num(p.responseStoreMaxRecords));
  set('--response-store-max-mib', num(p.responseStoreMaxMib));
  set('--kv-dtype', p.kvDtype);
  if (p.spec) {
    a.push('--spec', String(p.spec));
    set('--draft-tokens', num(p.draftTokens));
  }
  setFlag('--lm-head-draft', p.lmHeadDraft);
  set('--default-max-tokens', num(p.defaultMaxTokens));
  set('--default-thinking-budget', num(p.defaultThinkingBudget));
  setFlag('--vision', p.vision);
  setFlag('--no-cuda-graph', p.noCudaGraph);
  setFlag('--no-prefix-reuse', p.noPrefixReuse);
  set('--device-state-slots', num(p.deviceStateSlots));
  set('--host-state-slots', num(p.hostStateSlots));
  set('--host-kv-mib', num(p.hostKvMib));
  set('--max-private-continuations', num(p.maxPrivateContinuations));
  set('--max-shared-prefixes', num(p.maxSharedPrefixes));
  set('--max-long-anchors-per-continuation', num(p.maxLongAnchorsPerContinuation));
  setFlag('--no-thinking', p.noThinking);
  setFlag('--preserve-thinking', p.preserveThinking);
  set('--temperature', p.temperature);
  set('--top-p', p.topP);
  set('--top-k', num(p.topK));
  set('--min-p', p.minP);
  set('--presence-penalty', p.presencePenalty);
  set('--frequency-penalty', p.frequencyPenalty);
  set('--seed', num(p.seed));
  setFlag('--greedy', p.greedy);
  setFlag('--cors', p.cors);
  return a;
}
