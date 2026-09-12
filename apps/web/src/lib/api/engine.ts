// Engine process control: start/stop, source update (pull/build), the
// server-computed launch args + restart-dirty check, and the engine log tail.

import type { StatusPayload } from '../types';
import { getJSON, postJSON } from './core';

export interface EngineActionResult {
  ok: boolean;
  code?: string;
  message?: string;
  engine?: StatusPayload['engine'];
  /** set by the control plane when the profile failed to deserialize */
  profileParseError?: string;
}

export function startEngine(profile: unknown, artifact: string | null): Promise<EngineActionResult> {
  // Empty strings are how the form represents "unset" for some fields, but the
  // Rust control plane deserializes typed Option<u64>/Option<f64> fields — a ''
  // value fails the whole profile parse there and (with its fallback) silently
  // drops EVERY setting. Strip '' values here so the control plane receives a
  // clean profile; `undefined` keys are dropped by JSON.stringify.
  const clean = JSON.parse(JSON.stringify(profile, (_k, v) => (v === '' ? undefined : v)));
  return postJSON<EngineActionResult>('/api/engine/start', { profile: clean, artifact }, 15_000);
}

export function stopEngine(externalPid?: number): Promise<EngineActionResult> {
  return postJSON<EngineActionResult>('/api/engine/stop', { externalPid }, 15_000);
}

export function startEngineUpdate(action: 'pull' | 'build'): Promise<EngineActionResult> {
  return postJSON('/api/engine/update', { action });
}

/** Server-computed launch command + restart-dirty verdict (single source of
 * truth: both backends build argv with the same builder that spawns the
 * engine, so the UI can no longer drift from what actually runs). */
export interface EngineArgsResult {
  /** Launch argv for the posted profile; the api key is masked server-side. */
  args: string[];
  /** Form settings differ from the running engine (only true while a matching
   * engine is up; an unreadable argv on an adopted engine is never dirty). */
  dirty: boolean;
  /** The running engine serves the profile's port. */
  portMatch: boolean;
}

export function engineArgs(profile: unknown, artifact: string | null): Promise<EngineArgsResult> {
  // Same ''-stripping as startEngine: the dirty check compares against the
  // profile the engine was ACTUALLY started with (already cleaned), so the
  // form must be cleaned identically or empty fields read as "changed".
  const clean = JSON.parse(JSON.stringify(profile, (_k, v) => (v === '' ? undefined : v)));
  return postJSON<EngineArgsResult>('/api/engine/args', { profile: clean, artifact }, 8_000);
}

export function getLogs(n = 400): Promise<{ lines: string[]; size: number }> {
  return getJSON<{ lines: string[]; size: number }>(`/api/logs?n=${n}`, 6000);
}
