import { describe, it, expect, vi, afterEach } from 'vitest';
import { downloadModel, upgradeModel, convertModel } from './models';
import * as core from './core';

describe('models.ts API module', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('downloadModel', () => {
    it('posts repo, file, and optional localDir to /api/models/download', async () => {
      const postSpy = vi.spyOn(core, 'postJSON').mockResolvedValueOnce({ ok: true, id: 'dl_123' });

      const res = await downloadModel('Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', 'qwen2.5-coder-7b-instruct-q4_k_m.gguf', '/custom/dir');
      expect(res).toEqual({ ok: true, id: 'dl_123' });
      expect(postSpy).toHaveBeenCalledWith('/api/models/download', {
        repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
        file: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf',
        localDir: '/custom/dir',
      });
    });
  });

  describe('upgradeModel', () => {
    it('posts file path to /api/models/upgrade', async () => {
      const postSpy = vi.spyOn(core, 'postJSON').mockResolvedValueOnce({ ok: true });

      const res = await upgradeModel('/models/old_v2.gguf');
      expect(res).toEqual({ ok: true });
      expect(postSpy).toHaveBeenCalledWith('/api/models/upgrade', {
        file: '/models/old_v2.gguf',
      });
    });
  });

  describe('convertModel', () => {
    it('posts conversion parameters to /api/models/convert', async () => {
      const postSpy = vi.spyOn(core, 'postJSON').mockResolvedValueOnce({ ok: true, id: 'conv_456' });

      const res = await convertModel('/models/raw', 'llama', 'my-model', 'my-model-q4.gguf', '--quant q4_k');
      expect(res).toEqual({ ok: true, id: 'conv_456' });
      expect(postSpy).toHaveBeenCalledWith('/api/models/convert', {
        modelPath: '/models/raw',
        recipe: 'llama',
        name: 'my-model',
        outName: 'my-model-q4.gguf',
        extraArgs: '--quant q4_k',
      });
    });
  });
});
