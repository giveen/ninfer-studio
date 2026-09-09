// NInfer Studio — sidecar
//
// Zero-dependency Node 22 server that makes the NInfer engine usable from a
// desktop UI:
//   * spawns / supervises / stops `ninfer-serve` (profile -> CLI args)
//   * scans a models directory for `.ninfer` artifacts
//   * downloads artifacts via the `hf` CLI
//   * reports GPU state via nvidia-smi
//   * proxies the engine's OpenAI/Anthropic HTTP API (SSE-safe passthrough)
//   * statically hosts the built web app
//
// In the production Tauri build the same responsibilities move into the Rust
// core (tauri commands + state); this file is the reference implementation.

import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.SIDECAR_PORT || 8787);
const SELF_DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(SELF_DIR, '..', '..');

// Persisted data lives in the user's profile dir, not next to the checkout, so
// a person's settings survive a fresh pull of the app. Override with
// NINFIER_STUDIO_DATA for dev/portable use.
//   Linux:   ~/.config/ninfier-studio
//   Windows: ~/AppData/Roaming/ninfier-studio
function resolveDataDir() {
  if (process.env.NINFIER_STUDIO_DATA) return path.resolve(process.env.NINFIER_STUDIO_DATA);
  const home = os.homedir();
  const base =
    process.platform === 'win32'
      ? path.join(home, 'AppData', 'Roaming')
      : path.join(home, '.config');
  return path.join(base, 'ninfer-studio');
}
const DATA_DIR = resolveDataDir();
const DIST_DIR = path.join(ROOT, 'apps', 'web', 'dist');
const ENGINE_LOG_DIR = DATA_DIR;

// ---------------------------------------------------------------------------
// Registered artifact catalog (mirrors the NInfer README model table)
// ---------------------------------------------------------------------------
export const ARTIFACTS = [
  {
    file: 'qwen3_6_27b.ninfer',
    modelId: 'qwen3.6-27b',
    model: 'Qwen3.6-27B',
    weights: 'groupwise-int',
    repo: 'neroued/Qwen3.6-27B-NInfer',
    card: 'Qwen3.6-27B-NInfer',
    spec: 'mtp (1..5) or off',
    vision: true,
  },
  {
    file: 'qwen3_6_27b_nvfp4.ninfer',
    modelId: 'qwen3.6-27b',
    model: 'Qwen3.6-27B',
    weights: 'nvfp4',
    repo: 'neroued/Qwen3.6-27B-nvfp4-NInfer',
    card: 'Qwen3.6-27B-nvfp4-NInfer',
    spec: 'mtp (1..5) or off',
    vision: true,
  },
  {
    file: 'qwen3_8_27b.ninfer',
    modelId: 'qwen3.8-27b',
    model: 'Qwen3.8-27B',
    weights: 'groupwise-int',
    repo: 'neroued/Qwen3.8-27B-NInfer',
    card: 'Qwen3.8-27B-NInfer',
    spec: 'mtp (1..5) or dflash2 (1..15) or off',
    vision: true,
  },
  {
    file: 'qwen3_8_27b_nvfp4.ninfer',
    modelId: 'qwen3.8-27b',
    model: 'Qwen3.8-27B',
    weights: 'nvfp4',
    repo: 'neroued/Qwen3.8-27B-nvfp4-NInfer',
    card: 'Qwen3.8-27B-nvfp4-NInfer',
    spec: 'mtp (1..5) or dflash2 (1..15) or off',
    vision: true,
  },
  {
    file: 'qwen3_6_35b_a3b.ninfer',
    modelId: 'qwen3.6-35b-a3b',
    model: 'Qwen3.6-35B-A3B',
    weights: 'groupwise-int',
    repo: 'neroued/Qwen3.6-35B-A3B-NInfer',
    card: 'Qwen3.6-35B-A3B-NInfer',
    spec: 'mtp (1..5) or dflash (1..15) or off',
    vision: true,
  },
];

// ---------------------------------------------------------------------------
// Persistent configuration
// ---------------------------------------------------------------------------
const defaultConfig = {
  // No hardcoded paths: a fresh checkout must not ship a developer's machine
  // layout. The user sets these in Settings (or config.json). Empty values are
  // treated as "not configured" so we surface a clear error instead of spawning
  // a binary that does not exist on their machine.
  ninferPath: '',
  modelsDir: '',
  enginePort: 8080,
  apiKey: '',
  hfCli: 'hf',
  buildCommand: 'cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build -j$(nproc)',
  reasoningEffort: '',
};

let config = { ...defaultConfig };

async function loadConfig() {
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, 'config.json'), 'utf8');
    config = { ...defaultConfig, ...JSON.parse(raw) };
  } catch {
    /* first run: defaults */
  }
}

async function saveConfig(patch) {
  config = { ...config, ...patch };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, 'config.json'), JSON.stringify(config, null, 2));
  return config;
}

// ---------------------------------------------------------------------------
// Per-user profile state — the live engine profile, the chosen artifact, and the
// named saved profiles. Persisted to <DATA_DIR>/profile.json so they survive a
// restart (previously kept in browser localStorage).
// ---------------------------------------------------------------------------
const PROFILE_PATH = path.join(DATA_DIR, 'profile.json');
let profileState = { profile: null, artifact: null, saved: [] };

async function loadProfileState() {
  try {
    const raw = await fs.readFile(PROFILE_PATH, 'utf8');
    const p = JSON.parse(raw);
    profileState = {
      profile: p.profile ?? null,
      artifact: p.artifact ?? null,
      saved: Array.isArray(p.saved) ? p.saved : [],
    };
  } catch {
    profileState = { profile: null, artifact: null, saved: [] };
  }
  return profileState;
}

async function saveProfileState(patch) {
  const next = { ...profileState, ...patch };
  // keep shape explicit so older/partial payloads can't wedge the file
  next.profile = next.profile ?? null;
  next.artifact = next.artifact ?? null;
  next.saved = Array.isArray(next.saved) ? next.saved : [];
  profileState = next;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(PROFILE_PATH, JSON.stringify(next, null, 2));
  return next;
}

// ---------------------------------------------------------------------------
// Engine child-process management
// ---------------------------------------------------------------------------
/**
 * engine: {
 *   state: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed' | 'external'
 *   pid, port, artifact, modelId, argv, startedAt, logPath
 *   adopted: boolean  (running but not spawned by us)
 * }
 */
let engine = { state: 'stopped', pid: null, port: null, artifact: null, modelId: null, argv: null, startedAt: null, logPath: null, adopted: false, failReason: null, failHint: null };
let engineProc = null;
let engineLogStream = null;
const healthPollers = new Set();

function logPathFor(port) {
  return path.join(ENGINE_LOG_DIR, `engine-${port}.log`);
}

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

async function engineHealth(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const body = await r.json().catch(() => null);
    return body?.status === 'ok';
  } catch {
    return false;
  }
}

async function engineModelId(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      signal: AbortSignal.timeout(1500),
      headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
    });
    if (!r.ok) return null;
    const body = await r.json();
    return body?.data?.[0]?.id || null;
  } catch {
    return null;
  }
}

async function adoptExternal(port) {
  const d = (await discoverEngines()).find((x) => x.port === port);
  engine.state = 'external';
  engine.adopted = true;
  engine.pid = d?.pid ?? (await findExternalServePids())[0] ?? null;
  engine.argv = d?.argv ?? null;
  engine.artifact = engine.artifact ?? d?.artifact ?? null;
  engine.modelId = await engineModelId(port);
  engine.failReason = null;
  engine.failHint = null;
}

async function refreshEngineStatus() {
  if (engineProc) {
    const healthy = await engineHealth(engine.port);
    if (healthy) {
      if (engine.state !== 'running') {
        engine.state = 'running';
        engine.modelId = (await engineModelId(engine.port)) || engine.modelId;
      }
    } else if (engine.state === 'starting' || engine.state === 'running') {
      // give startup time; process still alive
      if (engine.state === 'starting' && !engine.deadline) engine.deadline = Date.now() + 180_000;
    }
  } else if (engine.state === 'starting' || engine.state === 'running') {
    // child exited underneath us
    markFailed('engine process exited');
  }
  if (engine.state === 'starting' && engine.deadline && Date.now() > engine.deadline) {
    markFailed('engine did not become healthy within 3 minutes');
  }
  if (engine.state === 'stopped' && engine.port) {
    const healthy = await engineHealth(engine.port);
    if (healthy) {
      await adoptExternal(engine.port);
    }
  } else if (engine.state === 'external') {
    const healthy = await engineHealth(engine.port);
    if (healthy) {
      const d = (await discoverEngines()).find((x) => x.port === engine.port);
      if (d) engine.pid = d.pid;
      engine.modelId = engine.modelId || (await engineModelId(engine.port));
    } else {
      engine.state = 'stopped';
      engine.adopted = false;
      engine.pid = null;
      engine.argv = null;
    }
  }
}

async function startEngine(profile, artifactPath) {
  const port = Number(profile?.port ?? config.enginePort);
  const artifact = artifactPath || null;

  if (await engineHealth(port)) {
    // something already serves this port — adopt, do not double-spawn
    engine = {
      state: 'external',
      pid: (await findExternalServePids())[0] ?? null,
      port,
      artifact,
      modelId: await engineModelId(port),
      argv: null,
      startedAt: null,
      logPath: logPathFor(port),
      adopted: true,
      failReason: null,
      failHint: null,
    };
    return { ok: false, code: 'already_serving', message: `an engine is already serving on port ${port} (adopted as external)`, engine: publicEngine() };
  }
  if (engineProc) {
    return { ok: false, code: 'already_running', message: 'an engine spawn is already in progress', engine: publicEngine() };
  }
  if (!artifact) {
    return { ok: false, code: 'no_artifact', message: 'select a downloaded .ninfer artifact first' };
  }
  let stat;
  try {
    stat = await fs.stat(artifact);
  } catch {
    return { ok: false, code: 'artifact_missing', message: `artifact not found: ${artifact}` };
  }
  const args = buildServeArgs({ ...profile, port, host: profile?.host || '127.0.0.1' });
  const logFile = logPathFor(port);
  await fs.mkdir(DATA_DIR, { recursive: true });
  const logStream = await fs.open(logFile, 'a');
  engineLogStream = logStream;

  engine = {
    state: 'starting',
    pid: null,
    port,
    artifact,
    modelId: null,
    argv: [artifact, ...args],
    startedAt: Date.now(),
    logPath: logFile,
    adopted: false,
    failReason: null,
    failHint: null,
    deadline: Date.now() + 180_000,
  };

  const engineBinary = config.ninferPath ? path.join(config.ninferPath, 'build', 'apps', 'ninfer-serve') : '';
  if (!engineBinary) {
    markFailed('Engine path not configured — open Settings and set the Ninfer path.');
    return { ok: false, code: 'not_configured', message: 'Engine path not configured — open Settings and set the Ninfer path.' };
  }
  const proc = spawn(engineBinary, [artifact, ...args], {
    cwd: path.dirname(engineBinary),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${process.env.PATH}:${os.homedir()}/.local/bin` },
  });
  engineProc = proc;
  engine.pid = proc.pid;
  lastStart = { port, profile, artifact, at: Date.now() };
  await fs.writeFile(path.join(DATA_DIR, 'last-start.json'), JSON.stringify(lastStart));

  const pump = (stream) => {
    stream.on('data', (chunk) => {
      logStream.write(chunk);
    });
  };
  pump(proc.stdout);
  pump(proc.stderr);

  const procLogStream = logStream;
  proc.on('error', (err) => {
    if (engineProc === proc) {
      markFailed(`spawn failed: ${err.message}`);
    }
  });
  proc.on('exit', async (code, signal) => {
    if (engineProc === proc) engineProc = null;
    if (engine.state === 'starting' || engine.state === 'running') {
      const healthy = await engineHealth(port).catch(() => false);
      if (!healthy) {
        markFailed(`process exited (${signal ? `signal ${signal}` : `code ${code}`}) — see log`);
      }
    }
    if (engineLogStream === procLogStream) engineLogStream = null;
    try { await procLogStream.close(); } catch { /* noop */ }
  });

  // poll health until ready or the deadline passes
  const poll = setInterval(async () => {
    if (!engineProc) return clearPoll();
    if (await engineHealth(port)) {
      engine.state = 'running';
      engine.modelId = (await engineModelId(port)) || engine.modelId;
      clearPoll();
    } else if (engine.deadline && Date.now() > engine.deadline) {
      markFailed('engine did not become healthy within 3 minutes');
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
      clearPoll();
    }
  }, 2000);
  function clearPoll() { clearInterval(poll); }

  return { ok: true, engine: publicEngine() };
}

async function stopEngine({ externalPid } = {}) {
  engine.failReason = null;
  engine.failHint = null;
  if (engineProc) {
    const proc = engineProc;
    engine.state = 'stopping';
    try { proc.kill('SIGTERM'); } catch { /* noop */ }
    const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* noop */ } }, 8000);
    await new Promise((resolve) => {
      proc.on('exit', () => { clearTimeout(killTimer); resolve(); });
      setTimeout(resolve, 10_000);
    });
    engineProc = null;
    engine.state = 'stopped';
    engine.adopted = false;
    engine.pid = null;
    return { ok: true, message: 'engine stopped' };
  }
  const target = externalPid ?? engine.pid;
  if (!target) {
    if (engine.state === 'external') {
      const all = await discoverEngines();
      const isDefault = engine.port === config.enginePort;
      // port-aware: never signal a process bound to a different port
      const pid =
        all.find((d) => d.port === engine.port)?.pid ??
        (isDefault ? all.find((d) => !d.port)?.pid : undefined);
      if (!pid) { engine.state = 'stopped'; return { ok: true, message: 'no engine process found' }; }
      engine.state = 'stopping';
      try { process.kill(pid, 'SIGTERM'); } catch (err) { engine.state = 'stopped'; return { ok: false, message: err.message }; }
      await new Promise((r) => setTimeout(r, 1500));
      engine.state = 'stopped';
      return { ok: true, message: `signaled external pid ${pid}` };
    }
    return { ok: false, message: 'no engine process is running' };
  }
  engine.state = 'stopping';
  try { process.kill(target, 'SIGTERM'); } catch (err) { engine.state = 'stopped'; return { ok: false, message: err.message }; }
  await new Promise((r) => setTimeout(r, 1000));
  engine.state = 'stopped';
  engine.adopted = false;
  engine.pid = null;
  return { ok: true, message: `signaled pid ${target}` };
}

async function discoverEngines() {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir('/proc');
  } catch {
    return out; // non-Linux
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = await fs.readFile(`/proc/${entry}/cmdline`, 'utf8');
      const parts = cmdline.split('\0').filter(Boolean);
      if (!/ninfer-serve$/.test(parts[0] || '')) continue;
      const args = parts.slice(1);
      let port = null;
      let artifact = null;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--port' && i + 1 < args.length) {
          const v = Number(args[i + 1]);
          if (Number.isInteger(v) && v > 0) port = v;
          i++;
          continue;
        }
        if (args[i].startsWith('--port=')) {
          const v = Number(args[i].slice('--port='.length));
          if (Number.isInteger(v) && v > 0) port = v;
        }
        if (artifact === null && !args[i].startsWith('-') && args[i].endsWith('.ninfer')) {
          artifact = args[i];
        }
      }
      out.push({ pid: Number(entry), port, artifact, argv: args });
    } catch { /* process vanished */ }
  }
  return out;
}

async function findExternalServePids() {
  return (await discoverEngines()).map((d) => d.pid);
}

// Map a startup failure to a one-line, actionable hint by scanning the engine
// log for known error signatures (bad artifact, OOM, port in use, missing
// capability). Falls back to a generic "see the log" message.
async function computeFailHint(reason) {
  let tail = '';
  try {
    const p = engine.logPath || logPathFor(engine.port || config.enginePort);
    const raw = await fs.readFile(p, 'utf8').catch(() => '');
    tail = raw.split('\n').slice(-80).join('\n');
  } catch {
    /* no log available */
  }
  const t = tail.toLowerCase();
  if (/out of memory|cannot allocate|insufficient (gpu )?memory|cuda error.*memory|\boom\b/i.test(t))
    return 'GPU memory exhausted (OOM) — lower --max-context / --kv-capacity, pick a smaller KV dtype (int8/fp8/nvfp4), or free the GPU before starting.';
  if (/address already in use|eaddrinuse|failed to bind|bind.*port|port.*(in use|already)|already in use/i.test(t))
    return 'The listen port is already taken — stop the other engine on that port or pick a different --port.';
  if (/not a valid.*artifact|invalid artifact|corrupt|\bmissing\b.*weights|weights.*not found|cannot open.*\.ninfer|no such file|failed to load.*artifact/i.test(t))
    return 'The artifact failed to load — confirm the .ninfer file is complete (partial downloads fail readiness) and built for this engine version.';
  if (/not supported|unsupported|capability|requires? (a )?(compute|sm_|gpu)|compute capability|sm_\d+/i.test(t))
    return 'This artifact needs a GPU capability the current device/build lacks (e.g. sm_120a) — check the engine build and --device.';
  // reason-based fallbacks when the log is silent
  if (/did not become healthy/i.test(reason || ''))
    return 'Engine never reported healthy — open the log below for the FATAL line, fix the profile, and start again.';
  if (/spawn failed/i.test(reason || ''))
    return 'The engine binary could not be launched — check the binary path in Settings and that it is executable.';
  return 'Engine exited during startup. Open the log below for the exact FATAL line, fix the profile, and start again.';
}

function markFailed(reason) {
  engine.state = 'failed';
  engine.failReason = reason;
  engine.failHint = null;
  computeFailHint(reason)
    .then((h) => { engine.failHint = h; })
    .catch(() => { engine.failHint = null; });
}

function publicEngine() {
  return {
    state: engine.state,
    pid: engine.pid,
    port: engine.port,
    artifact: engine.artifact,
    modelId: engine.modelId,
    argv: engine.argv ? [engine.argv[0], ...engine.argv.slice(1)] : null,
    startedAt: engine.startedAt,
    logPath: engine.logPath,
    adopted: engine.adopted,
    failReason: engine.failReason,
    failHint: engine.failHint ?? null,
    // The --max-context the engine was started with (the chat uses this to show
    // a context-limit indicator). Unknown for externally-adopted engines.
    maxContext: !engine.adopted && lastStart?.profile ? (lastStart.profile.maxContext ?? null) : null,
  };
}

// Last profile/artifact handed to an engine (dirty-check source for the UI).
let lastStart = null;

// Primary engine + every locally-discovered ninfer-serve on other ports.
async function enginesPublic() {
  const out = [publicEngine()];
  for (const d of await discoverEngines()) {
    if (!d.port) continue;
    if (engine.port === d.port || d.pid === engine.pid) continue;
    const model = await engineModelId(d.port);
    out.push({
      state: 'external',
      pid: d.pid,
      port: d.port,
      artifact: d.artifact,
      modelId: model,
      argv: d.argv,
      startedAt: null,
      logPath: null,
      adopted: true,
      failReason: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Models directory
// ---------------------------------------------------------------------------
async function listModels() {
  const dir = config.modelsDir;
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { dir, artifacts: [] };
  }
  const artifacts = [];
  for (const name of entries.sort()) {
    if (!name.endsWith('.ninfer')) continue;
    const full = path.join(dir, name);
    try {
      const st = await fs.stat(full);
      const known = ARTIFACTS.find((a) => a.file === name) || null;
      artifacts.push({
        file: name,
        path: full,
        size: st.size,
        mtime: st.mtimeMs,
        known,
        modelId: known?.modelId || null,
        model: known?.model || null,
        weights: known?.weights || null,
        repo: known?.repo || null,
      });
    } catch { /* unreadable entry */ }
  }
  return { dir, artifacts };
}

// ---------------------------------------------------------------------------
// Downloads (hf CLI)
// ---------------------------------------------------------------------------
const downloads = new Map();

function parseSize(s) {
  s = String(s).trim();
  const m = s.match(/^([\d.]+)\s*([kKmMgGtT])?/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(v * mult);
}

// Largest file under `dir` — the staging blob is the largest file in flight,
// so this yields downloaded bytes during a download.
function largestFileSize(dir) {
  let max = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          const s = fs.statSync(p).size;
          if (s > max) max = s;
        } catch {
          /* gone */
        }
      }
    }
  };
  walk(dir);
  return max;
}

// Resolve total size via `hf download --dry-run --json` (no actual transfer).
function hfDryRun(cli, repo, file, dir) {
  return new Promise((resolve) => {
    const cp = spawn(cli, ['download', repo, file, '--local-dir', dir, '--dry-run', '--json'], {
      env: { ...process.env, PATH: `${process.env.PATH}:${os.homedir()}/.local/bin:/usr/local/bin` },
    });
    let out = '';
    cp.stdout.on('data', (c) => (out += c));
    cp.on('error', () => resolve(null));
    cp.on('close', () => {
      try {
        const arr = JSON.parse(out);
        const size = arr?.[0]?.size;
        resolve(size ? parseSize(size) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

async function startDownload({ repo, file, localDir, hfCli }) {
  if (!repo || !file) return { ok: false, message: 'repo and file are required' };
  const dir = localDir || config.modelsDir;
  const cli = hfCli || config.hfCli || 'hf';
  await fs.mkdir(dir, { recursive: true });
  const totalBytes = await hfDryRun(cli, repo, file, dir);
  const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const proc = spawn(cli, ['download', repo, file, '--local-dir', dir], {
    env: { ...process.env, PATH: `${process.env.PATH}:${os.homedir()}/.local/bin:/usr/local/bin` },
  });
  const rec = {
    id,
    repo,
    file,
    localDir: dir,
    pid: proc.pid,
    out: '',
    exitCode: null,
    done: false,
    failed: false,
    totalBytes,
    downloadedBytes: 0,
    speedBps: 0,
    startedAt: Date.now(),
  };
  downloads.set(id, rec);
  const pump = (c) => {
    rec.out = (rec.out + c.toString()).slice(-200_000);
  };
  proc.stdout.on('data', pump);
  proc.stderr.on('data', pump);
  proc.on('error', (err) => {
    rec.failed = true;
    rec.done = true;
    rec.out += `\n[spawn error] ${err.message}\n`;
  });
  proc.on('exit', (code) => {
    rec.exitCode = code;
    rec.done = true;
    if (code !== 0) rec.failed = true;
    if (rec.totalBytes) rec.downloadedBytes = rec.totalBytes;
    rec.speedBps = 0;
  });
  // progress monitor: sample the staging blob size on disk
  let last = 0;
  let lastT = Date.now();
  const mon = setInterval(() => {
    const cur = largestFileSize(dir);
    const now = Date.now();
    const dt = (now - lastT) / 1000;
    if (dt > 0 && cur >= last) rec.speedBps = (cur - last) / dt;
    rec.downloadedBytes = cur;
    if (rec.done) {
      clearInterval(mon);
      if (rec.totalBytes) rec.downloadedBytes = rec.totalBytes;
      rec.speedBps = 0;
    }
    last = cur;
    lastT = now;
  }, 400);
  return { ok: true, id };
}

function downloadsPublic() {
  return [...downloads.values()].map((d) => ({ ...d, out: d.out.split('\n').slice(-30).join('\n') }));
}

// ---------------------------------------------------------------------------
// Engine source updates (git pull / rebuild)
// ---------------------------------------------------------------------------
let updateJob = null;

async function startUpdate(action) {
  if (action !== 'pull' && action !== 'build') {
    return { ok: false, message: "action must be 'pull' or 'build'" };
  }
  if (updateJob && !updateJob.done) {
    return { ok: false, message: `an ${updateJob.action} job is already running (pid ${updateJob.pid ?? '?'})` };
  }
  const repo = config.ninferPath || '';
  if (!repo) return { ok: false, message: 'Ninfer path is not configured' };
  try {
    const st = await fs.stat(repo);
    if (!st.isDirectory()) return { ok: false, message: `not a directory: ${repo}` };
  } catch {
    return { ok: false, message: `repo dir not found: ${repo}` };
  }

  let cmd;
  if (action === 'pull') {
    try {
      await new Promise((resolve, reject) => {
        execFile('git', ['-C', repo, 'rev-parse', '--is-inside-work-tree'], (err) => (err ? reject(err) : resolve()));
      });
    } catch {
      return { ok: false, message: `${repo} is not a git work tree` };
    }
    cmd = `git -C ${JSON.stringify(repo)} pull --ff-only`;
  } else {
    cmd = config.buildCommand || '';
    if (!cmd) return { ok: false, message: 'buildCommand is not configured' };
  }

  const id = `upd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const proc = spawn('sh', ['-c', cmd], { cwd: repo });
  const rec = { id, action, cmd, pid: proc.pid, out: '', exitCode: null, done: false, failed: false, startedAt: Date.now() };
  updateJob = rec;
  const pump = (c) => {
    rec.out = (rec.out + c.toString()).slice(-200_000);
  };
  proc.stdout.on('data', pump);
  proc.stderr.on('data', pump);
  proc.on('error', (err) => {
    rec.failed = true;
    rec.done = true;
    rec.out += `\n[spawn error] ${err.message}\n`;
  });
  proc.on('exit', (code) => {
    rec.exitCode = code;
    rec.done = true;
    rec.failed = code !== 0;
    rec.out += rec.failed ? `\n✗ failed (exit ${code})` : '\n✓ done (exit 0)';
  });
  return { ok: true, id, cmd };
}

function updatePublic() {
  return updateJob;
}

// ---------------------------------------------------------------------------
// GPU stats
// ---------------------------------------------------------------------------
function gpuStats() {
  return new Promise((resolve) => {
    const fallback = () => resolve({ available: false, name: null, memUsedMiB: null, memTotalMiB: null, utilPct: null, apps: [] });
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 3000 },
      async (err1, out1) => {
        if (err1) return fallback();
        const [name, memUsed, memTotal, util] = out1.trim().split('\n')[0].split(',').map((s) => s.trim());
        execFile(
          'nvidia-smi',
          ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits'],
          { timeout: 3000 },
          (err2, out2) => {
            const apps = [];
            if (!err2 && out2) {
              for (const line of out2.trim().split('\n').filter(Boolean)) {
                const [pid, pname, mem] = line.split(',').map((s) => s.trim());
                apps.push({ pid: Number(pid), name: pname, memMiB: Number(mem) });
              }
            }
            resolve({
              available: true,
              name,
              memUsedMiB: Number(memUsed),
              memTotalMiB: Number(memTotal),
              utilPct: Number(util),
              apps,
            });
          },
        );
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Engine log tail
// ---------------------------------------------------------------------------
async function tailLog(lines = 400) {
  if (!engine.logPath) return { lines: [] };
  try {
    const st = await fs.stat(engine.logPath);
    if (st.size <= 512 * 1024) {
      const text = await fs.readFile(engine.logPath, 'utf8');
      return { lines: text.split('\n').slice(-lines), size: st.size };
    }
    const fd = await fs.open(engine.logPath, 'r');
    const buf = Buffer.alloc(512 * 1024);
    await fd.read(buf, 0, buf.length, st.size - buf.length);
    await fd.close();
    const text = buf.toString('utf8');
    return { lines: text.split('\n').slice(-lines), size: st.size };
  } catch {
    return { lines: [] };
  }
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization, x-api-key',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  const buf = Buffer.concat(chunks);
  if (!buf.length) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 });
  }
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

async function serveStatic(req, res, urlPath) {
  try {
    await fs.access(DIST_DIR);
  } catch {
    return sendJson(res, 503, { error: 'web build not found — run `pnpm build` first (or use the Vite dev server on :5173)' });
  }
  let file = path.normalize(path.join(DIST_DIR, decodeURIComponent(urlPath)));
  if (!file.startsWith(DIST_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  let isFile = false;
  try {
    const st = await fs.stat(file);
    isFile = st.isFile();
  } catch { /* not found */ }
  if (!isFile) file = path.join(DIST_DIR, 'index.html'); // SPA fallback
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  await new Promise((resolve) => {
    const rs = createReadStream(file);
    rs.pipe(res); // pipe closes res when the stream ends
    rs.on('error', (err) => {
      console.error('[ninfier-sidecar] static read error', file, err.message);
      resolve();
    });
    rs.on('end', resolve);
  });
}

// Route a proxied request: when the JSON body names a model, go to the engine
// that serves it; otherwise the primary (or the single discovered / configured).
async function routePort() {
  const cands = [];
  if (engine.port && ['running', 'external', 'starting'].includes(engine.state)) {
    cands.push({ port: engine.port, model: engine.modelId });
  }
  for (const d of await discoverEngines()) {
    if (!d.port) continue;
    if (cands.some((c) => c.port === d.port)) continue;
    const m = await engineModelId(d.port);
    if (m) cands.push({ port: d.port, model: m });
  }
  return cands;
}

async function proxyToEngine(req, res, targetPath) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = Buffer.concat(chunks);

  // Inject configured defaults into the request body. Two sources, both with
  // client fields winning:
  //   1. defaultRequestParams — a free-form JSON object merged as top-level
  //      defaults (so external clients inherit per-tool config).
  //   2. reasoningEffort — a dedicated UI control that sets
  //      chat_template_kwargs.reasoning_effort for every request. It overrides
  //      the generic default for this single key (it's the explicit control).
  const drp = (config.defaultRequestParams || '').trim();
  const re = (config.reasoningEffort || '').trim();
  if (drp || re) {
    try {
      const obj = body.length ? JSON.parse(body.toString('utf8')) : {};
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const clientHasRe =
          obj.chat_template_kwargs &&
          typeof obj.chat_template_kwargs === 'object' &&
          !Array.isArray(obj.chat_template_kwargs) &&
          'reasoning_effort' in obj.chat_template_kwargs;

        // 1. generic top-level defaults (client fields win)
        if (drp) {
          const defaults = JSON.parse(drp);
          if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
            for (const k of Object.keys(defaults)) {
              if (!(k in obj)) obj[k] = defaults[k];
            }
          }
        }

        // 2. reasoning effort → chat_template_kwargs.reasoning_effort
        //    (client explicit value wins; the dedicated control beats the
        //     generic default for this one key)
        if (re && !clientHasRe) {
          if (!obj.chat_template_kwargs || typeof obj.chat_template_kwargs !== 'object' || Array.isArray(obj.chat_template_kwargs)) {
            obj.chat_template_kwargs = {};
          }
          obj.chat_template_kwargs.reasoning_effort = re;
        }

        body = Buffer.from(JSON.stringify(obj));
      }
    } catch { /* leave body untouched on parse error */ }
  }

  let model = null;
  if (body.length) {
    try {
      model = JSON.parse(body.toString('utf8'))?.model ?? null;
    } catch { /* not json */ }
  }
  const cands = await routePort();
  let port;
  if (model) {
    const hit = cands.find((c) => c.model === model);
    if (hit) port = hit.port;
    else if (cands.length > 1) {
      const avail = cands.map((c) => `${c.model} (:${c.port})`).join(', ');
      return sendJson(res, 400, { error: `no engine serves model '${model}' — available: ${avail}` });
    }
  }
  port = port ?? cands[0]?.port ?? engine.port ?? config.enginePort;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  if (config.apiKey && !headers.authorization && !headers['x-api-key']) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }

  const upstream = await fetch(`http://127.0.0.1:${port}${targetPath}`, {
    method: req.method,
    headers: { ...headers, 'content-type': req.headers['content-type'] || 'application/json' },
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    duplex: 'half',
    redirect: 'manual',
  }).catch((err) => {
    sendJson(res, 502, { error: 'engine unreachable', detail: err.message });
    return null;
  });
  if (!upstream) return;

  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') || 'application/json',
    'cache-control': 'no-cache',
    'x-request-id': upstream.headers.get('x-request-id') || '',
    'access-control-allow-origin': '*',
  });
  if (req.method === 'HEAD') return res.end();

  if (!upstream.body) return res.end();
  // SSE-safe: pipe chunks as they arrive
  try {
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
      if (typeof res.flush === 'function') res.flush();
    }
  } catch (err) {
    // client aborted
  }
  res.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, authorization, x-api-key',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      });
      return res.end();
    }

    if (p === '/api/health') return sendJson(res, 200, { ok: true });

    if (p === '/api/status' && req.method === 'GET') {
      await refreshEngineStatus();
      const [gpu, models] = await Promise.all([gpuStats(), listModels()]);
      return sendJson(res, 200, {
        engine: publicEngine(),
        engines: await enginesPublic(),
        lastStart,
        gpu,
        config,
        artifacts: models.artifacts,
        catalog: ARTIFACTS,
        downloads: downloadsPublic(),
        update: updatePublic(),
      });
    }

    if (p === '/api/config' && req.method === 'GET') return sendJson(res, 200, config);

    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req, 1 << 20);
      const c = await saveConfig(body);
      return sendJson(res, 200, c);
    }

    if (p === '/api/profile-state' && req.method === 'GET') {
      return sendJson(res, 200, profileState);
    }

    if (p === '/api/profile-state' && req.method === 'POST') {
      const body = await readBody(req, 1 << 20);
      const next = await saveProfileState(body || {});
      return sendJson(res, 200, next);
    }

    if (p === '/api/engine/start' && req.method === 'POST') {
      const body = await readBody(req, 1 << 20);
      const result = await startEngine(body?.profile ?? {}, body?.artifact);
      if (result.ok) return sendJson(res, 200, result);
      return sendJson(res, 200, result); // client interprets code
    }

    if (p === '/api/engine/stop' && req.method === 'POST') {
      const body = (await readBody(req, 1 << 20)) || {};
      const result = await stopEngine(body);
      return sendJson(res, 200, result);
    }

    if (p === '/api/engine/update' && req.method === 'POST') {
      const body = await readBody(req, 1 << 20);
      const result = await startUpdate(body?.action);
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    if (p === '/api/logs' && req.method === 'GET') {
      const n = Number(url.searchParams.get('n') || 400);
      const { lines, size } = await tailLog(n);
      return sendJson(res, 200, { lines, size });
    }

    if (p === '/api/models' && req.method === 'GET') {
      return sendJson(res, 200, { ...(await listModels()), catalog: ARTIFACTS });
    }

    if (p === '/api/models/download' && req.method === 'POST') {
      const body = await readBody(req, 1 << 20);
      const result = await startDownload(body || {});
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    if (p === '/api/gpu' && req.method === 'GET') {
      return sendJson(res, 200, await gpuStats());
    }

    // Engine API passthrough (OpenAI / Anthropic / health)
    if (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE') {
      if (p.startsWith('/v1/') || p === '/health' || p.startsWith('/health/')) {
        return await proxyToEngine(req, res, req.url.split('?')[0]);
      }
    }

    if (p === '/' || p.startsWith('/assets/') || !p.startsWith('/api')) {
      return await serveStatic(req, res, p === '/' ? '/index.html' : p);
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    const code = err.status || 500;
    console.error('[ninfier-sidecar] request error', req.method, url.pathname, err.message);
    if (!res.headersSent) sendJson(res, code, { error: err.message });
    else res.end();
  }
});

await fs.mkdir(DATA_DIR, { recursive: true });
await loadConfig();
await loadProfileState();
try {
  lastStart = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'last-start.json'), 'utf8'));
} catch { /* first run */ }

// adopt any externally-running engine on the configured port at boot
const bootCheck = async () => {
  engine.port = config.enginePort;
  engine.logPath = logPathFor(config.enginePort);
  if (await engineHealth(config.enginePort)) {
    engine.state = 'external';
    engine.adopted = true;
    engine.pid = (await findExternalServePids())[0] ?? null;
    engine.modelId = await engineModelId(config.enginePort);
  }
};
await bootCheck();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ninfier-sidecar] listening on http://127.0.0.1:${PORT}`);
  console.log(`[ninfier-sidecar] engine port ${engine.port} ${engine.state === 'external' ? '— external engine detected' : '— no engine detected'}`);
});
