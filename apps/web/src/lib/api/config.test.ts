import { describe, it, expect, vi, afterEach } from 'vitest';
import { getEngineContextSize, testCloudConnection, SECRET_MASK } from './config';
import * as core from './core';

describe('config.ts API module', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('SECRET_MASK', () => {
    it('exports the standard 8-asterisk secret mask constant', () => {
      expect(SECRET_MASK).toBe('********');
    });
  });

  describe('getEngineContextSize', () => {
    it('returns max_model_len when model is found in /v1/models', async () => {
      vi.spyOn(core, 'getJSON').mockResolvedValueOnce({
        data: [
          { id: 'qwen-coder', max_model_len: 32768 },
          { id: 'llama-3', max_model_len: 8192 },
        ],
      });

      const res = await getEngineContextSize('qwen-coder');
      expect(res).toBe(32768);
    });

    it('returns null when requested model is missing, even if other models exist', async () => {
      vi.spyOn(core, 'getJSON').mockResolvedValueOnce({
        data: [{ id: 'llama-3', max_model_len: 8192 }],
      });

      const res = await getEngineContextSize('qwen-coder');
      expect(res).toBeNull();
    });

    it('returns null on request failure', async () => {
      vi.spyOn(core, 'getJSON').mockRejectedValueOnce(new Error('Network error'));

      const res = await getEngineContextSize('qwen-coder');
      expect(res).toBeNull();
    });
  });

  describe('testCloudConnection', () => {
    it('returns response from control plane /api/cloud/test endpoint on success', async () => {
      vi.spyOn(core, 'postJSON').mockResolvedValueOnce({
        ok: true,
        latencyMs: 42,
        models: ['gpt-4o', 'gpt-4o-mini'],
      });

      const res = await testCloudConnection('https://api.openai.com/v1', 'key-123');
      expect(res).toEqual({
        ok: true,
        latencyMs: 42,
        models: ['gpt-4o', 'gpt-4o-mini'],
      });
    });

    it('bails out with error on non-404 backend failure instead of attempting direct browser fetch', async () => {
      vi.spyOn(core, 'postJSON').mockRejectedValueOnce(new Error('HTTP 500: Internal Server Error'));
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const res = await testCloudConnection('https://api.openai.com/v1', 'key-123');
      expect(res.ok).toBe(false);
      expect(res.error).toBe('HTTP 500: Internal Server Error');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('falls back to direct browser fetch when /api/cloud/test yields HTTP 404', async () => {
      vi.spyOn(core, 'postJSON').mockRejectedValueOnce(new Error('HTTP 404 Not Found'));
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] }),
      } as Response);

      const res = await testCloudConnection('https://api.openai.com/v1', 'key-123');
      expect(res.ok).toBe(true);
      expect(res.models).toEqual(['model-a', 'model-b']);
    });
  });
});
