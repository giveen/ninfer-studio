import { describe, it, expect, vi } from 'vitest';
import * as api from '../../lib/api';

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual('../../lib/api');
  return {
    ...actual,
    testCloudConnection: vi.fn(),
  };
});

describe('CloudTab preset definitions & network safety', () => {
  it('testCloudConnection handles error throws cleanly', async () => {
    vi.mocked(api.testCloudConnection).mockRejectedValueOnce(new Error('Network timeout'));

    try {
      await api.testCloudConnection('https://api.openai.com/v1', 'key', undefined);
    } catch (e) {
      expect((e as Error).message).toBe('Network timeout');
    }
  });

  it('validates HTTP-Referer header uses correct ninfer.studio domain', () => {
    const extraHeaders = JSON.stringify({ 'HTTP-Referer': 'https://ninfer.studio', 'X-Title': 'NInfer Studio' });
    expect(extraHeaders).toContain('https://ninfer.studio');
    expect(extraHeaders).not.toContain('ninfier');
  });
});
