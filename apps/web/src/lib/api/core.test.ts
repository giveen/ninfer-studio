import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getJSON,
  postJSON,
  combinedSignal,
  StreamIdleController,
  fetchStream,
  isAbortError,
  isTimeoutError,
} from './core';

describe('core.ts API infrastructure module', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isAbortError & isTimeoutError', () => {
    it('correctly classifies AbortError from DOMException and Error', () => {
      const domAbort = new DOMException('The operation was aborted', 'AbortError');
      const errAbort = new Error('aborted');
      errAbort.name = 'AbortError';
      const ctrl = new AbortController();
      ctrl.abort();

      expect(isAbortError(domAbort)).toBe(true);
      expect(isAbortError(errAbort)).toBe(true);
      expect(isAbortError(new Error('other'), ctrl.signal)).toBe(true);
      expect(isAbortError(new Error('other'))).toBe(false);
    });

    it('correctly classifies TimeoutError from DOMException and Error', () => {
      const domTimeout = new DOMException('Timed out', 'TimeoutError');
      const errTimeout = new Error('request timed out after 5000ms');
      errTimeout.name = 'TimeoutError';

      expect(isTimeoutError(domTimeout)).toBe(true);
      expect(isTimeoutError(errTimeout)).toBe(true);
      expect(isTimeoutError(new Error('other error'))).toBe(false);
    });
  });

  describe('combinedSignal', () => {
    it('returns a signal that aborts on timeout or caller abort', () => {
      const ctrl = new AbortController();
      const signal = combinedSignal(10_000, ctrl.signal);
      expect(signal.aborted).toBe(false);
      ctrl.abort();
      expect(signal.aborted).toBe(true);
    });
  });

  describe('getJSON & postJSON', () => {
    it('extracts server JSON error message on non-200 responses for GET', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'no workspace configured' }),
      } as Response);

      await expect(getJSON('/api/coder/memory')).rejects.toThrow(
        '/api/coder/memory → HTTP 400: no workspace configured',
      );
    });

    it('extracts nested error.message on non-200 responses for POST', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({ error: { message: 'Invalid payload schema' } }),
      } as Response);

      await expect(postJSON('/api/config', { key: 'val' })).rejects.toThrow(
        '/api/config → HTTP 422: Invalid payload schema',
      );
    });

    it('decorates network errors with path', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await expect(getJSON('/api/status')).rejects.toThrow('/api/status → Failed to fetch');
    });

    it('reports non-JSON 200 OK response as unparseable instead of HTTP error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '<html>Not JSON</html>',
      } as Response);

      await expect(getJSON('/api/status')).rejects.toThrow(
        '/api/status → unparseable response (HTTP 200): <html>Not JSON</html>',
      );
    });

    it('handles empty 200 OK body safely as empty object', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
      } as Response);

      const res = await getJSON('/api/ping');
      expect(res).toEqual({});
    });
  });

  describe('StreamIdleController & fetchStream', () => {
    it('resets idle timer on touch and disposes cleanly', () => {
      const idle = new StreamIdleController(5000);
      expect(idle.signal.aborted).toBe(false);
      idle.touch();
      expect(idle.signal.aborted).toBe(false);
      idle.dispose();
    });

    it('wraps fetch with response and idle controller', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        body: {} as ReadableStream,
      } as Response);

      const { response, idle } = await fetchStream('/v1/chat/completions', { method: 'POST' });
      expect(response.ok).toBe(true);
      expect(idle.signal.aborted).toBe(false);
      idle.dispose();
    });
  });
});
