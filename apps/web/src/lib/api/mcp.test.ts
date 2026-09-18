import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  mcpServersGet,
  mcpServersUpsert,
  mcpServerDelete,
  mcpServerRestart,
  mcpToolsGet,
  mcpCall,
  clearMcpToolsCache,
} from './mcp';
import * as core from './core';

describe('mcp.ts API module', () => {
  afterEach(() => {
    clearMcpToolsCache();
    vi.restoreAllMocks();
  });

  describe('mcpServersGet', () => {
    it('fetches server list from /api/mcp/servers', async () => {
      const getSpy = vi.spyOn(core, 'getJSON').mockResolvedValueOnce({
        servers: [{ name: 'github', transport: 'stdio', status: 'connected', toolCount: 2 }],
      });

      const res = await mcpServersGet();
      expect(res.servers.length).toBe(1);
      expect(getSpy).toHaveBeenCalledWith('/api/mcp/servers', 10000);
    });
  });

  describe('mcpServersUpsert', () => {
    it('posts spec to /api/mcp/servers and clears tools cache', async () => {
      const postSpy = vi.spyOn(core, 'postJSON').mockResolvedValueOnce({
        servers: [{ name: 'github', transport: 'stdio', status: 'connected', toolCount: 2 }],
      });

      const res = await mcpServersUpsert({ name: 'github', command: 'npx' });
      expect(res.servers.length).toBe(1);
      expect(postSpy).toHaveBeenCalledWith(
        '/api/mcp/servers',
        { name: 'github', command: 'npx' },
        90000,
      );
    });
  });

  describe('mcpServerDelete', () => {
    it('posts delete request to /api/mcp/servers/:name', async () => {
      const postSpy = vi.spyOn(core, 'postJSON').mockResolvedValueOnce({ ok: true, removed: true });

      const res = await mcpServerDelete('github');
      expect(res).toEqual({ ok: true, removed: true });
      expect(postSpy).toHaveBeenCalledWith('/api/mcp/servers/github', {}, 10000);
    });
  });

  describe('mcpServerRestart', () => {
    it('posts restart request to /api/mcp/servers/:name/restart', async () => {
      const postSpy = vi.spyOn(core, 'postJSON').mockResolvedValueOnce({ servers: [] });

      const res = await mcpServerRestart('github');
      expect(res).toEqual({ servers: [] });
      expect(postSpy).toHaveBeenCalledWith('/api/mcp/servers/github/restart', {}, 90000);
    });
  });

  describe('mcpToolsGet', () => {
    it('deduplicates concurrent in-flight requests for the same scope', async () => {
      const getSpy = vi.spyOn(core, 'getJSON').mockResolvedValue({ tools: [] });

      const p1 = mcpToolsGet('ws-1');
      const p2 = mcpToolsGet('ws-1');

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toEqual({ tools: [] });
      expect(r2).toEqual({ tools: [] });
      expect(getSpy).toHaveBeenCalledTimes(1);
    });

    it('forces fresh fetch when force parameter is true', async () => {
      const getSpy = vi.spyOn(core, 'getJSON').mockResolvedValue({ tools: [] });

      await mcpToolsGet('ws-1');
      await mcpToolsGet('ws-1', true);

      expect(getSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('mcpCall', () => {
    it('posts tool call payload to /api/mcp/call', async () => {
      const postSpy = vi.spyOn(core, 'postJSON').mockResolvedValueOnce({ ok: true, output: 'result' });

      const res = await mcpCall({ name: 'mcp__github__create_issue', arguments: { title: 'bug' } });
      expect(res).toEqual({ ok: true, output: 'result' });
      expect(postSpy).toHaveBeenCalledWith(
        '/api/mcp/call',
        { name: 'mcp__github__create_issue', arguments: { title: 'bug' } },
        610000,
        undefined,
      );
    });
  });
});
