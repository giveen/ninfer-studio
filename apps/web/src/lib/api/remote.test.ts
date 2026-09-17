import { describe, it, expect, vi, afterEach } from 'vitest';
import { getRemoteAccessStatus, startRemoteAccess, stopRemoteAccess } from './remote';
import * as core from './core';

describe('remote.ts API module', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getRemoteAccessStatus', () => {
    it('fetches status payload from /api/remote', async () => {
      const getSpy = vi.spyOn(core, 'getJSON').mockResolvedValueOnce({
        enabled: true,
        running: true,
        port: 1337,
        lanIp: '192.168.1.100',
      });

      const res = await getRemoteAccessStatus();
      expect(res).toEqual({
        enabled: true,
        running: true,
        port: 1337,
        lanIp: '192.168.1.100',
      });
      expect(getSpy).toHaveBeenCalledWith('/api/remote', 4000);
    });
  });

  describe('startRemoteAccess', () => {
    it('posts port payload when specified', async () => {
      const postSpy = vi.spyOn(core, 'postJSON').mockResolvedValueOnce({
        enabled: true,
        running: true,
        port: 8080,
        lanIp: '192.168.1.100',
      });

      const res = await startRemoteAccess(8080);
      expect(res.port).toBe(8080);
      expect(postSpy).toHaveBeenCalledWith('/api/remote/start', { port: 8080 }, 8000);
    });

    it('posts empty object payload when port is omitted', async () => {
      const postSpy = vi.spyOn(core, 'postJSON').mockResolvedValueOnce({
        enabled: true,
        running: true,
        port: 1337,
        lanIp: '192.168.1.100',
      });

      const res = await startRemoteAccess();
      expect(res.port).toBe(1337);
      expect(postSpy).toHaveBeenCalledWith('/api/remote/start', {}, 8000);
    });
  });

  describe('stopRemoteAccess', () => {
    it('posts stop request to /api/remote/stop', async () => {
      const postSpy = vi.spyOn(core, 'postJSON').mockResolvedValueOnce({
        enabled: false,
        running: false,
        port: 1337,
        lanIp: '192.168.1.100',
      });

      const res = await stopRemoteAccess();
      expect(res.enabled).toBe(false);
      expect(res.running).toBe(false);
      expect(postSpy).toHaveBeenCalledWith('/api/remote/stop', {}, 8000);
    });
  });
});
