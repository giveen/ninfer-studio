import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getLogs } from './api';
import { getLogsState, LOG_TAIL_LINES, useEngineLogs } from './liveLogs';

vi.mock('./api', () => ({
  getLogs: vi.fn(),
}));

const mockGetLogs = vi.mocked(getLogs);

describe('liveLogs module', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetLogs.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exports LOG_TAIL_LINES constant as 1000', () => {
    expect(LOG_TAIL_LINES).toBe(1000);
  });

  it('initializes with empty default state', () => {
    const state = getLogsState();
    expect(state.lines).toEqual([]);
    expect(state.size).toBe(0);
    expect(state.lastOkAt).toBeNull();
    expect(state.error).toBeNull();
  });

  it('hook function is exported', () => {
    expect(typeof useEngineLogs).toBe('function');
  });
});
