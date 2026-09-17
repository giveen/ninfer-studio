import { describe, it, expect } from 'vitest';
import { parseCoderGitLogStdout } from './coder';

describe('coder.ts API helpers', () => {
  describe('parseCoderGitLogStdout', () => {
    it('parses valid git log records with unit separator and record separator', () => {
      const record1 = ['a1b2c3d4e5f6789', 'Author One', '2 hours ago', '2026-09-16T12:00:00Z', 'Commit Subject 1', 'Commit body line 1\nbody line 2'].join('\x1f') + '\x1e';
      const record2 = ['f9e8d7c6b5a4321', 'Author Two', '1 day ago', '2026-09-15T12:00:00Z', 'Commit Subject 2', ''].join('\x1f') + '\x1e';
      const stdout = record1 + '\n' + record2;

      const commits = parseCoderGitLogStdout(stdout);
      expect(commits.length).toBe(2);
      expect(commits[0]).toEqual({
        hash: 'a1b2c3d4e5f6789',
        author: 'Author One',
        relDate: '2 hours ago',
        date: '2026-09-16T12:00:00Z',
        subject: 'Commit Subject 1',
        body: 'Commit body line 1\nbody line 2',
      });
      expect(commits[1]).toEqual({
        hash: 'f9e8d7c6b5a4321',
        author: 'Author Two',
        relDate: '1 day ago',
        date: '2026-09-15T12:00:00Z',
        subject: 'Commit Subject 2',
        body: '',
      });
    });

    it('filters out records with invalid hash or arity mismatch', () => {
      const invalidHash = ['invalid_non_hex', 'Author One', '2 hours ago', '2026-09-16T12:00:00Z', 'Sub', 'Body'].join('\x1f') + '\x1e';
      const arityMismatch = ['a1b2c3d4e5f6789', 'Author One', '2 hours ago'].join('\x1f') + '\x1e';
      const valid = ['a1b2c3d4e5f6789', 'Author One', '2 hours ago', '2026-09-16T12:00:00Z', 'Sub', 'Body'].join('\x1f') + '\x1e';
      const stdout = [invalidHash, arityMismatch, valid].join('\n');

      const commits = parseCoderGitLogStdout(stdout);
      expect(commits.length).toBe(1);
      expect(commits[0].hash).toBe('a1b2c3d4e5f6789');
    });

    it('returns empty array on empty stdout', () => {
      expect(parseCoderGitLogStdout('')).toEqual([]);
      expect(parseCoderGitLogStdout('   \n  ')).toEqual([]);
    });
  });
});
