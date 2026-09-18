import { describe, it, expect, vi, afterEach } from 'vitest';
import { startEngine, stopEngine, startEngineUpdate, engineArgs, getLogs } from './engine';
import * as core from './core';

describe('engine.ts API module', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('startEngine', () => {
    it('posts profile and artifact payload to /api/engine/start', async () => {
      const postSpy = vi.spyOn(core, 'postJSON').mockResolvedValueOnce({ ok: true });

      const res = await startEngine({ model: 'qwen' }, 'artifact-1');
      expect(res).toEqual({ ok: true });
      expect(postSpy).toHaveBeenCalledWith(
        '/api/engine/start',
        { profile: { model: 'qwen' }, artifact: 'artifact-1' },
        15000,
      );
    });
  });

  describe('stopEngine', () => {
    it('posts externalPid to /api/engine/stop', async () => {
      const postSpy = vi.spyOn(core, 'postJSON').mockResolvedValueOnce({ ok: true });

      const res = await stopEngine(1234);
      expect(res).toEqual({ ok: true });
      expect(postSpy).toHaveBeenCalledWith('/api/engine/stop', { externalPid: 1234 }, 15000);
    });
  });

  describe('startEngineUpdate', () => {
    it('posts action to /api/engine/update', async () => {
      const postSpy = vi.spyOn(core, 'postJSON').mockResolvedValueOnce({ ok: true });

      const res = await startEngineUpdate('pull');
      expect(res).toEqual({ ok: true });
      expect(postSpy).toHaveBeenCalledWith('/api/engine/update', { action: 'pull' });
    });
  });

  describe('engineArgs', () => {
    it('posts profile and artifact payload to /api/engine/args', async () => {
      const postSpy = vi.spyOn(core, 'postJSON').mockResolvedValueOnce({
        args: ['ninfer-serve', '--model', 'qwen'],
        dirty: false,
        portMatch: true,
      });

      const res = await engineArgs({ model: 'qwen' }, 'artifact-1');
      expect(res).toEqual({
        args: ['ninfer-serve', '--model', 'qwen'],
        dirty: false,
        portMatch: true,
      });
      expect(postSpy).toHaveBeenCalledWith(
        '/api/engine/args',
        { profile: { model: 'qwen' }, artifact: 'artifact-1' },
        8000,
      );
    });
  });

  describe('getLogs', () => {
    it('fetches logs with encoded n parameter', async () => {
      const getSpy = vi.spyOn(core, 'getJSON').mockResolvedValueOnce({
        lines: ['line 1', 'line 2'],
        size: 100,
      });

      const res = await getLogs(500);
      expect(res).toEqual({ lines: ['line 1', 'line 2'], size: 100 });
      expect(getSpy).toHaveBeenCalledWith('/api/logs?n=500', 6000);
    });
  });
});
