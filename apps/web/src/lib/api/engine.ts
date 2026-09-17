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
  return postJSON<EngineActionResult>('/api/engine/start', { profile, artifact }, 15_000);
}

export function stopEngine(externalPid?: number): Promise<EngineActionResult> {
  return postJSON<EngineActionResult>('/api/engine/stop', { externalPid }, 15_000);
}

export function startEngineUpdate(action: 'pull' | 'build'): Promise<EngineActionResult> {
  return postJSON<EngineActionResult>('/api/engine/update', { action });
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
  /** set by the control plane when the profile failed to deserialize */
  profileParseError?: string;
}

export function engineArgs(profile: unknown, artifact: string | null): Promise<EngineArgsResult> {
  return postJSON<EngineArgsResult>('/api/engine/args', { profile, artifact }, 8_000);
}

export interface LogResponse {
  lines: string[];
  size: number;
}

export function getLogs(n = 400): Promise<LogResponse> {
  return getJSON<LogResponse>(`/api/logs?n=${encodeURIComponent(n)}`, 6000);
}
