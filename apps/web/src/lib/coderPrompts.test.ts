import { describe, it, expect } from 'vitest';
import { CODER_SYSTEM, WORKER_SYSTEM, CRITIC_SYSTEM } from './coderPrompts';
import { coderLensBlock, LINUS_LENS } from './coderLens';

describe('coderPrompts & coderLens', () => {
  describe('CODER_SYSTEM', () => {
    it('contains critical instructions for tool selection and thought process', () => {
      expect(CODER_SYSTEM).toContain('CRITICAL INSTRUCTION: TOOL SELECTION');
      expect(CODER_SYSTEM).toContain('prioritize these specific tools over the generic `bash` tool');
    });

    it('contains core directives for research, verify, todo tracking, and memory', () => {
      expect(CODER_SYSTEM).toContain('Research First');
      expect(CODER_SYSTEM).toContain('Verify Everything');
      expect(CODER_SYSTEM).toContain('todo_write');
      expect(CODER_SYSTEM).toContain('memory_update');
    });
  });

  describe('WORKER_SYSTEM', () => {
    it('restricts worker subagents from committing or asking user', () => {
      expect(WORKER_SYSTEM).toContain('Do NOT call: ask_user');
      expect(WORKER_SYSTEM).toContain('the supervisor owns version control');
    });
  });

  describe('CRITIC_SYSTEM', () => {
    it('defines explicit verdict structure for automated code review', () => {
      expect(CRITIC_SYSTEM).toContain('VERDICT: APPROVED');
      expect(CRITIC_SYSTEM).toContain('VERDICT: CHANGES_REQUESTED');
      expect(CRITIC_SYSTEM).toContain('LEARNING:');
      expect(CRITIC_SYSTEM).toContain('AVOID:');
    });
  });

  describe('coderLensBlock', () => {
    it('returns empty string when no review lens is selected', () => {
      expect(coderLensBlock(undefined)).toBe('');
      expect(coderLensBlock('')).toBe('');
      expect(coderLensBlock('unknown')).toBe('');
    });

    it('returns Linus review method distillation when "linus" lens is passed', () => {
      const block = coderLensBlock('linus');
      expect(block).toBe(LINUS_LENS);
      expect(block).toContain('Linus Torvalds method');
      expect(block).toContain('Level 1 — Global invariants');
      expect(block).toContain('Level 2 — Structural / architecture');
      expect(block).toContain('Level 3 — Tactical');
    });
  });
});
