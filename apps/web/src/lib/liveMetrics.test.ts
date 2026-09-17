import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setLatestRequestMetrics,
  clearLatestRequestMetrics,
  getLatestRequestMetrics,
  isLiveMetricsStale,
  subscribeLatestRequestMetrics,
  useLatestRequestMetrics,
  LIVE_METRICS_STALE_AFTER_MS,
  type LiveRequestMetrics,
} from './liveMetrics';
import type { MessageMeta } from './types';

describe('liveMetrics module', () => {
  const dummyMeta: MessageMeta = {
    ttftMs: 120,
    promptTokPerSec: 450.5,
    decodeTokPerSec: 32.1,
    draftN: 4,
    draftNAccepted: 3,
  };

  beforeEach(() => {
    clearLatestRequestMetrics();
  });

  it('exports LIVE_METRICS_STALE_AFTER_MS as 15000', () => {
    expect(LIVE_METRICS_STALE_AFTER_MS).toBe(15000);
  });

  it('starts with null metrics', () => {
    expect(getLatestRequestMetrics()).toBeNull();
  });

  it('sets and retrieves latest request metrics with shallow-copied meta', () => {
    const metaCopy = { ...dummyMeta };
    setLatestRequestMetrics(metaCopy, 'llama-3');

    const metrics = getLatestRequestMetrics();
    expect(metrics).not.toBeNull();
    expect(metrics?.model).toBe('llama-3');
    expect(metrics?.meta).toEqual(dummyMeta);
    expect(metrics?.meta).not.toBe(metaCopy); // immutable copy check

    // Mutating original object should not alter stored metrics
    metaCopy.ttftMs = 999;
    expect(getLatestRequestMetrics()?.meta.ttftMs).toBe(120);
  });

  it('clears metrics and notifies subscribers with null', () => {
    setLatestRequestMetrics(dummyMeta, 'llama-3');
    expect(getLatestRequestMetrics()).not.toBeNull();

    const listener = vi.fn();
    const unsubscribe = subscribeLatestRequestMetrics(listener);

    clearLatestRequestMetrics();
    expect(getLatestRequestMetrics()).toBeNull();
    expect(listener).toHaveBeenCalledWith(null);

    unsubscribe();
  });

  it('notifies subscribers on setLatestRequestMetrics', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLatestRequestMetrics(listener);

    setLatestRequestMetrics(dummyMeta, 'qwen-2.5');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]?.model).toBe('qwen-2.5');

    unsubscribe();
  });

  it('unsubscribes correctly', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLatestRequestMetrics(listener);
    unsubscribe();

    setLatestRequestMetrics(dummyMeta, 'test-model');
    expect(listener).not.toHaveBeenCalled();
  });

  it('checks staleness accurately', () => {
    expect(isLiveMetricsStale(null)).toBe(true);

    const now = 100000;
    const freshMetrics: LiveRequestMetrics = {
      meta: dummyMeta,
      model: 'model-a',
      at: now - 5000,
    };
    expect(isLiveMetricsStale(freshMetrics, now)).toBe(false);

    const staleMetrics: LiveRequestMetrics = {
      meta: dummyMeta,
      model: 'model-a',
      at: now - 16000,
    };
    expect(isLiveMetricsStale(staleMetrics, now)).toBe(true);
  });

  it('exports useLatestRequestMetrics hook', () => {
    expect(typeof useLatestRequestMetrics).toBe('function');
  });
});
