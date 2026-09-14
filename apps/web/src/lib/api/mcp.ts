// MCP (Model Context Protocol) control-plane endpoints. External tool servers
// (stdio child processes or streamable-HTTP endpoints) are configured in
// Settings > Safety & Permissions; the control plane (desktop/control/src/mcp.rs)
// owns the connections, and their tools reach the agent loops as
// `mcp__<server>__<tool>` through the same allow/ask/deny tiers as the
// built-in tools — the control plane re-checks the tier on /api/mcp/call,
// with a per-tool row `mcp__<server>__<tool>` overriding a server-level row
// `mcp__<server>`.

import { getJSON, postJSON } from './core';

export interface McpServerSpec {
  name: string;
  /** stdio transport: the command to spawn. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** streamable-HTTP transport: the endpoint url. */
  url?: string;
  headers?: Record<string, string>;
  /** `Authorization` header value (stored only server-side; the UI sees a mask). */
  authorization?: string;
}

export interface McpServerInfo {
  name: string;
  transport: 'stdio' | 'http' | 'none';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Always the mask `***` when set (the secret never leaves the control plane). */
  authorization?: string;
  /** `connected` | `disconnected` | `error: <reason>`. */
  status: string;
  /** Peer's serverInfo (name/version) once connected. */
  peer?: { name?: string; version?: string } | null;
  /** Child pid for stdio servers. */
  pid?: number;
  toolCount: number;
}

export interface McpToolInfo {
  /** `mcp__<server>__<tool>` — what the model calls. */
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Effective tier for the requested scope (per-tool row over server row). */
  tier: 'allow' | 'ask' | 'deny';
}

export function mcpServersGet(): Promise<{ servers: McpServerInfo[] }> {
  return getJSON<{ servers: McpServerInfo[] }>('/api/mcp/servers', 10_000);
}
/** Upsert one server spec, persist it, and (re)connect. The spec is saved
 *  even when the connection fails — in that case this rejects (HTTP 502)
 *  and the server shows up in the list with an `error: …` status, so
 *  callers should refetch the list after a failure. */
export function mcpServersUpsert(spec: McpServerSpec): Promise<{ servers: McpServerInfo[] }> {
  // Connect + initialize is capped server-side at 60s (hung npx installs).
  return postJSON<{ servers: McpServerInfo[] }>('/api/mcp/servers', spec, 90_000);
}
export function mcpServerDelete(name: string): Promise<{ ok: boolean; removed: boolean }> {
  return postJSON<{ ok: boolean; removed: boolean }>(`/api/mcp/servers/${encodeURIComponent(name)}`, {}, 10_000);
}
export function mcpServerRestart(name: string): Promise<{ servers: McpServerInfo[] }> {
  return postJSON<{ servers: McpServerInfo[] }>(`/api/mcp/servers/${encodeURIComponent(name)}/restart`, {}, 90_000);
}
/** The merged `mcp__<server>__<tool>` catalog (LLM-ready schemas + effective
 *  tier per scope). Servers are connected/refreshed on demand, so a cold
 *  start can take a while — long timeout on purpose. */
export function mcpToolsGet(scope?: string): Promise<{ tools: McpToolInfo[] }> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : '';
  return getJSON<{ tools: McpToolInfo[] }>(`/api/mcp/tools${qs}`, 120_000);
}
/** Invoke one MCP tool. Tool-level failures come back as `{ ok: false,
 *  output }` (fed straight to the model); HTTP errors are permission
 *  denials (403), unknown servers (404) or connection failures (502). */
export function mcpCall(
  body: { name: string; arguments?: Record<string, unknown>; scope?: string; approvalToken?: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; output: string }> {
  // Must exceed the server's per-call cap (600s) so only a true hang surfaces.
  return postJSON<{ ok: boolean; output: string }>('/api/mcp/call', body, 610_000, signal);
}
