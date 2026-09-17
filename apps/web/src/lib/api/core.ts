// Shared HTTP plumbing every api/*.ts domain module builds on: the base URL
// (dev vs packaged desktop), the fetch wrappers that combine a per-call timeout
// with an optional caller-supplied abort signal, and stream idle timeouts.

// In dev (Vite) the web is served on :5173 and /api is proxied to the control
// plane on :8787, so relative paths work. In a bundled desktop build the webview
// is loaded from the Tauri asset origin (tauri://localhost) and must reach the
// in-process control plane by its absolute loopback URL instead.
//
// A THIRD case: Remote Access (see remote.ts) serves this same bundle from
// the control plane itself, at http://<lan-ip>:1337/ — a plain browser page,
// not the Tauri webview. Its loopback would be the *other* machine's, so
// relative paths (same-origin, hitting the server that served the page) are
// required there, same as dev. Only the Tauri webview needs the hardcoded
// loopback origin; detect it by scheme/host rather than assuming "not dev
// means Tauri".
const isTauriWebview =
  typeof window !== 'undefined' &&
  (window.location.protocol === 'tauri:' || window.location.hostname === 'tauri.localhost');
export const API_BASE = !import.meta.env.DEV && isTauriWebview ? 'http://127.0.0.1:8787' : '';

export function isAbortError(err: unknown, callerSignal?: AbortSignal): boolean {
  if (callerSignal?.aborted) return true;
  if (!err) return false;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

export function isTimeoutError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof DOMException && err.name === 'TimeoutError') return true;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.message.includes('timed out'))) return true;
  return false;
}

/** Combine a per-call timeout with an optional caller-supplied abort signal. */
export function combinedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
}

export class StreamIdleController {
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  public readonly signal: AbortSignal;

  constructor(
    public readonly idleTimeoutMs = 30_000,
    private callerSignal?: AbortSignal,
  ) {
    this.signal = callerSignal
      ? AbortSignal.any([this.controller.signal, callerSignal])
      : this.controller.signal;

    if (callerSignal?.aborted) {
      this.controller.abort(callerSignal.reason);
    } else if (callerSignal) {
      callerSignal.addEventListener(
        'abort',
        () => {
          this.controller.abort(callerSignal.reason);
        },
        { once: true },
      );
    }
    this.touch();
  }

  /** Reset the idle timer whenever data is received. */
  touch(): void {
    this.clear();
    this.timer = setTimeout(() => {
      const err = new Error(`Stream idle timeout after ${this.idleTimeoutMs}ms`);
      err.name = 'TimeoutError';
      this.controller.abort(err);
    }, this.idleTimeoutMs);
  }

  /** Clear the timer when stream completes or closes. */
  dispose(): void {
    this.clear();
  }

  private clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export async function fetchStream(
  path: string,
  init: RequestInit = {},
  options: { connectTimeoutMs?: number; idleTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ response: Response; idle: StreamIdleController }> {
  const idle = new StreamIdleController(options.idleTimeoutMs ?? 30_000, options.signal);
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  // Bounds only the wait for response headers — a long-running body (e.g. a
  // large prompt still prefilling) must not be killed by it, so the timer is
  // cleared as soon as fetch() resolves; AbortSignal.timeout() can't be
  // cancelled, hence the manual AbortController instead.
  const connectController = new AbortController();
  const connectTimer = setTimeout(() => {
    const err = new Error(`${path} → connection timed out after ${connectTimeoutMs}ms`);
    err.name = 'TimeoutError';
    connectController.abort(err);
  }, connectTimeoutMs);
  const combined = AbortSignal.any([idle.signal, connectController.signal]);

  try {
    const response = await fetch(API_BASE + path, { ...init, signal: combined });
    clearTimeout(connectTimer);
    idle.touch();
    return { response, idle };
  } catch (e) {
    clearTimeout(connectTimer);
    idle.dispose();
    if (options.signal?.aborted) {
      throw e;
    }
    if (connectController.signal.aborted) {
      throw connectController.signal.reason;
    }
    if (idle.signal.aborted) {
      throw idle.signal.reason;
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${path} → ${msg}`);
  }
}

async function requestJSON<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = callerSignal ? AbortSignal.any([timeoutSignal, callerSignal]) : timeoutSignal;

  let r: Response;
  try {
    r = await fetch(API_BASE + path, { ...init, signal: combined });
  } catch (e) {
    if (callerSignal?.aborted) {
      throw e;
    }
    if (timeoutSignal.aborted) {
      const err = new Error(`${path} → request timed out after ${timeoutMs}ms`);
      err.name = 'TimeoutError';
      throw err;
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${path} → ${msg}`);
  }

  const text = await r.text();

  if (!r.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      if (j && typeof j === 'object') {
        const msg = j.error?.message || j.error?.code || (typeof j.error === 'string' ? j.error : null) || j.message;
        if (msg) detail = String(msg);
      }
    } catch {
      /* keep raw slice */
    }
    throw new Error(`${path} → HTTP ${r.status}${detail ? `: ${detail}` : ''}`);
  }

  if (!text.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${path} → unparseable response (HTTP ${r.status}): ${text.slice(0, 300)}`);
  }
}

export function getJSON<T>(path: string, timeoutMs = 4000, signal?: AbortSignal): Promise<T> {
  return requestJSON<T>(path, { method: 'GET' }, timeoutMs, signal);
}

export function postJSON<T>(path: string, body?: unknown, timeoutMs = 10_000, signal?: AbortSignal): Promise<T> {
  return requestJSON<T>(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    },
    timeoutMs,
    signal,
  );
}
