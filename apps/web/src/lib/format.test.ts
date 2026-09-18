import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  formatTokens,
  formatRate,
  formatMs,
  formatUptime,
  formatTime,
  formatPct,
  uid,
  estimateTokens,
  CHARS_PER_TOKEN_PROSE,
  CHARS_PER_TOKEN_CODE,
} from './format';

describe('format module', () => {
  describe('formatTime', () => {
    it('returns fallback dash for null, undefined, NaN, and invalid timestamps', () => {
      expect(formatTime(null)).toBe('—');
      expect(formatTime(undefined)).toBe('—');
      expect(formatTime(NaN)).toBe('—');
      expect(formatTime(Infinity)).toBe('—');
      expect(formatTime(-100)).toBe('—');
    });

    it('formats valid timestamp into short localized string', () => {
      const ts = new Date('2026-09-16T12:00:00Z').getTime();
      const formatted = formatTime(ts);
      expect(formatted).not.toBe('—');
      expect(formatted).not.toBe('Invalid Date');
    });
  });

  describe('formatBytes', () => {
    it('handles fallback dash for null, undefined, NaN, negative, and non-finite values', () => {
      expect(formatBytes(null)).toBe('—');
      expect(formatBytes(undefined)).toBe('—');
      expect(formatBytes(NaN)).toBe('—');
      expect(formatBytes(Infinity)).toBe('—');
      expect(formatBytes(-1024)).toBe('—');
    });

    it('rounds sub-1024 float byte values', () => {
      expect(formatBytes(523.4)).toBe('523 B');
      expect(formatBytes(0)).toBe('0 B');
    });

    it('formats KiB, MiB, GiB, TiB, and PiB units with smooth precision boundaries', () => {
      expect(formatBytes(1500)).toBe('1.5 KiB');
      expect(formatBytes(1024 * 1024 * 2.5)).toBe('2.5 MiB');
      expect(formatBytes(1024 * 1024 * 99.96)).toBe('100 MiB');
      expect(formatBytes(1024 * 1024 * 1024 * 5)).toBe('5.0 GiB');
      expect(formatBytes(1024 * 1024 * 1024 * 1024 * 1.2)).toBe('1.2 TiB');
      expect(formatBytes(1024 * 1024 * 1024 * 1024 * 1024 * 3.4)).toBe('3.4 PiB');
    });
  });

  describe('formatTokens', () => {
    it('handles null, undefined, and non-finite values', () => {
      expect(formatTokens(null)).toBe('—');
      expect(formatTokens(undefined)).toBe('—');
      expect(formatTokens(NaN)).toBe('—');
    });

    it('formats token counts', () => {
      expect(formatTokens(500)).toBe('500');
      expect(formatTokens(1500)).toBe('1.5k');
      expect(formatTokens(2_500_000)).toBe('2.50M');
    });
  });

  describe('formatRate', () => {
    it('formats tokens per second', () => {
      expect(formatRate(null)).toBe('—');
      expect(formatRate(45.67)).toBe('45.7 tks/s');
      expect(formatRate(1250)).toBe('1.25k tks/s');
    });
  });


  describe('formatMs', () => {
    it('formats millisecond durations', () => {
      expect(formatMs(null)).toBe('—');
      expect(formatMs(45.4)).toBe('45 ms');
      expect(formatMs(1500)).toBe('1.50 s');
    });
  });

  describe('formatUptime', () => {
    it('formats elapsed uptime durations from timestamp', () => {
      expect(formatUptime(null)).toBe('—');
      const now = 1_000_000_000;
      expect(formatUptime(now - 45_000, now)).toBe('45s');
      expect(formatUptime(now - 330_000, now)).toBe('5m 30s');
      expect(formatUptime(now - 8100_000, now)).toBe('2h 15m');
      expect(formatUptime(now - 273_600_000, now)).toBe('3d 4h');
    });
  });

  describe('formatPct', () => {
    it('clamps percentages between 0% and 100%', () => {
      expect(formatPct(null, 100)).toBe('—');
      expect(formatPct(50, 0)).toBe('—');
      expect(formatPct(50, 100)).toBe('50%');
      expect(formatPct(150, 100)).toBe('100%');
      expect(formatPct(-10, 100)).toBe('0%');
    });
  });

  describe('uid', () => {
    it('generates valid UUID v4 string', () => {
      const id1 = uid();
      const id2 = uid();
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });

  describe('estimateTokens', () => {
    it('estimates token counts for prose and code', () => {
      const text = 'abcdefghij'; // 10 chars
      expect(estimateTokens(text, false)).toBe(Math.ceil(10 / CHARS_PER_TOKEN_PROSE));
      expect(estimateTokens(text, true)).toBe(Math.ceil(10 / CHARS_PER_TOKEN_CODE));
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens(null)).toBe(0);
    });
  });
});
