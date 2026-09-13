// Shared HTTP plumbing every api/*.ts domain module builds on: the base URL
// (dev vs packaged desktop), and the two fetch wrappers that combine a
// per-call timeout with an optional caller-supplied abort signal.

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

/** Combine the per-call timeout with an optional caller-supplied abort
 *  signal (e.g. a running agent's Stop button) so either one can cut the
 *  fetch short. */
function combinedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
}

export async function getJSON<T>(path: string, timeoutMs = 4000, signal?: AbortSignal): Promise<T> {
  const r = await fetch(API_BASE + path, { signal: combinedSignal(timeoutMs, signal) });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return (await r.json()) as T;
}

export async function postJSON<T>(path: string, body: unknown, timeoutMs = 10_000, signal?: AbortSignal): Promise<T> {
  const r = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: combinedSignal(timeoutMs, signal),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${path} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
}
