// Remote Access: serve the full app on 0.0.0.0 so another device on the
// network can open the same live backend. See desktop/control/src/remote.rs
// for the server side and its deliberate no-auth tradeoff (SECURITY.md).

import { getJSON, postJSON } from './core';

export interface RemoteAccessStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  /** Best-effort LAN-facing IPv4 address for the "open this on your laptop"
   *  link. Null if the host has no network route to detect one from. */
  lanIp: string | null;
}

export function getRemoteAccessStatus(): Promise<RemoteAccessStatus> {
  return getJSON<RemoteAccessStatus>('/api/remote', 4000);
}

export function startRemoteAccess(port?: number): Promise<RemoteAccessStatus> {
  return postJSON<RemoteAccessStatus>('/api/remote/start', port ? { port } : {}, 8000);
}

export function stopRemoteAccess(): Promise<RemoteAccessStatus> {
  return postJSON<RemoteAccessStatus>('/api/remote/stop', {}, 8000);
}
