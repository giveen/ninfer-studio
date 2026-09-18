import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getUsageStats, resetUsageStats } from './usage';
import * as core from './core';

vi.mock('./core', () => ({
  getJSON: vi.fn(),
  postJSON: vi.fn(),
}));

describe('getUsageStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('encodes days and source query parameters cleanly', async () => {
    const mockData = { totals: {}, dailySeries: [], modelBreakdown: [] };
    vi.mocked(core.getJSON).mockResolvedValueOnce(mockData as any);

    const result = await getUsageStats(14, 'local');
    expect(core.getJSON).toHaveBeenCalledWith('/api/usage?days=14&source=local', 8000, undefined);
    expect(result).toBe(mockData);
  });

  it('passes AbortSignal to getJSON when provided', async () => {
    const controller = new AbortController();
    vi.mocked(core.getJSON).mockResolvedValueOnce({} as any);

    await getUsageStats(30, 'all', controller.signal);
    expect(core.getJSON).toHaveBeenCalledWith('/api/usage?days=30&source=all', 8000, controller.signal);
  });
});

describe('resetUsageStats', () => {
  it('invokes postJSON on /api/usage/reset', async () => {
    vi.mocked(core.postJSON).mockResolvedValueOnce({ ok: true });
    const res = await resetUsageStats();
    expect(core.postJSON).toHaveBeenCalledWith('/api/usage/reset', {}, 8000);
    expect(res).toEqual({ ok: true });
  });
});
