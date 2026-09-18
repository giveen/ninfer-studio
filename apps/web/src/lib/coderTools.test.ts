import { describe, it, expect } from 'vitest';
import {
  TOOLS,
  filterToolsByConfig,
  filterToolAllowList,
  isReadOnlyCommand,
  splitMcpName,
  mcpServerKey,
  mcpToolTier,
  mcpToolSchema,
  hashToolCall,
  isErrorResult,
  withNote,
  detectRisky,
  normalizeCommand,
  isApprovedCommand,
  READONLY_TOOL_NAMES,
  WORKER_TOOL_NAMES,
  MUTATING_TOOLS,
  PURE_DEDUP_TOOLS,
  READ_STREAK_TOOLS,
  type PermConfig,
} from './coderTools';

describe('coderTools', () => {
  describe('filterToolsByConfig', () => {
    it('returns all tools by default when config is empty', () => {
      const filtered = filterToolsByConfig(TOOLS, {});
      expect(filtered.length).toBe(TOOLS.length);
    });

    it('filters out udiff_edit when coderUdiffEditEnabled is false', () => {
      const filtered = filterToolsByConfig(TOOLS, { coderUdiffEditEnabled: false });
      expect(filtered.some((t) => t.function.name === 'udiff_edit')).toBe(false);
    });

    it('filters out repo_map when coderRepoMapEnabled is false', () => {
      const filtered = filterToolsByConfig(TOOLS, { coderRepoMapEnabled: false });
      expect(filtered.some((t) => t.function.name === 'repo_map')).toBe(false);
    });

    it('ensures every advertised tool in TOOLS is categorized', () => {
      const allCategoryTools = new Set([...READONLY_TOOL_NAMES, ...WORKER_TOOL_NAMES, ...MUTATING_TOOLS]);
      for (const tool of TOOLS) {
        expect(allCategoryTools.has(tool.function.name)).toBe(true);
      }
    });
  });

  describe('filterToolAllowList', () => {
    it('returns undefined when raw input is not an array', () => {
      expect(filterToolAllowList(null, READONLY_TOOL_NAMES)).toBeUndefined();
      expect(filterToolAllowList('read', READONLY_TOOL_NAMES)).toBeUndefined();
    });

    it('filters input array against allowed Set', () => {
      const raw = ['read', 'grep', 'bash', 'invalid_tool'];
      const filtered = filterToolAllowList(raw, READONLY_TOOL_NAMES);
      expect(filtered).toEqual(['read', 'grep']);
    });

    it('returns undefined when no tools survive filtering (avoids empty array trap)', () => {
      const raw = ['bash', 'write', 'edit'];
      const filtered = filterToolAllowList(raw, READONLY_TOOL_NAMES);
      expect(filtered).toBeUndefined();
    });

    it('does not strip write/edit/bash from a subagent allow-list checked against WORKER_TOOL_NAMES', () => {
      const raw = ['read', 'write', 'edit', 'bash', 'invalid_tool'];
      const filtered = filterToolAllowList(raw, WORKER_TOOL_NAMES);
      expect(filtered).toEqual(['read', 'write', 'edit', 'bash']);
    });
  });

  describe('isReadOnlyCommand', () => {
    it('allows simple inspection commands', () => {
      expect(isReadOnlyCommand('ls -la')).toBe(true);
      expect(isReadOnlyCommand('cat package.json')).toBe(true);
      expect(isReadOnlyCommand('head -n 20 src/index.ts')).toBe(true);
      expect(isReadOnlyCommand('git status')).toBe(true);
      expect(isReadOnlyCommand('git log -n 5')).toBe(true);
      expect(isReadOnlyCommand('git diff')).toBe(true);
      expect(isReadOnlyCommand('/bin/ls -la')).toBe(true);
      expect(isReadOnlyCommand('/usr/bin/cat file')).toBe(true);
    });

    it('rejects mutating or dangerous commands', () => {
      expect(isReadOnlyCommand('rm -rf /tmp/foo')).toBe(false);
      expect(isReadOnlyCommand('git commit -m "feat"')).toBe(false);
      expect(isReadOnlyCommand('pnpm build')).toBe(false);
      expect(isReadOnlyCommand('git branch -D feature')).toBe(false);
      expect(isReadOnlyCommand('git tag -a v1.0')).toBe(false);
      expect(isReadOnlyCommand('git remote add origin url')).toBe(false);
    });

    it('rejects shell chaining, piping, redirection, subshells, or newlines', () => {
      expect(isReadOnlyCommand('cat foo > bar')).toBe(false);
      expect(isReadOnlyCommand('ls | grep ts')).toBe(false);
      expect(isReadOnlyCommand('ls; rm -rf /')).toBe(false);
      expect(isReadOnlyCommand('echo $(whoami)')).toBe(false);
      expect(isReadOnlyCommand('echo `whoami`')).toBe(false);
      expect(isReadOnlyCommand('ls && rm -rf /')).toBe(false);
      expect(isReadOnlyCommand('ls\nrm -rf .')).toBe(false);
      expect(isReadOnlyCommand('cat file\r\nrm -rf .')).toBe(false);
    });

    it('rejects write or exec flags on allow-listed commands', () => {
      expect(isReadOnlyCommand('find . -delete')).toBe(false);
      expect(isReadOnlyCommand('find . -exec rm {} +')).toBe(false);
      expect(isReadOnlyCommand('find . -execdir rm {} ;')).toBe(false);
      expect(isReadOnlyCommand('find . -ok rm {} ;')).toBe(false);
      expect(isReadOnlyCommand('fd foo -x rm')).toBe(false);
      expect(isReadOnlyCommand('fd foo --exec-batch rm')).toBe(false);
      expect(isReadOnlyCommand('rg foo --pre ./script')).toBe(false);
      expect(isReadOnlyCommand('sort input.txt -o output.txt')).toBe(false);
      expect(isReadOnlyCommand('sort input.txt --output=output.txt')).toBe(false);
      expect(isReadOnlyCommand('uniq input.txt')).toBe(true);
      expect(isReadOnlyCommand('uniq input.txt output.txt')).toBe(false);
      expect(isReadOnlyCommand('git diff --output=patch.diff')).toBe(false);
    });
  });

  describe('MCP namespacing', () => {
    it('splitMcpName splits mcp__server__tool correctly', () => {
      expect(splitMcpName('mcp__context7__read_file')).toEqual({
        server: 'context7',
        tool: 'read_file',
      });
      expect(splitMcpName('mcp__filesystem__dir__list')).toEqual({
        server: 'filesystem',
        tool: 'dir__list',
      });
      expect(splitMcpName('read')).toBeNull();
      expect(splitMcpName('mcp__invalid')).toBeNull();
    });

    it('mcpServerKey produces mcp__server key', () => {
      expect(mcpServerKey('mcp__context7__read_file')).toBe('mcp__context7');
      expect(mcpServerKey('bash')).toBeNull();
    });

    it('mcpToolTier respects tool tier precedence', () => {
      const perms: PermConfig = {
        tools: {
          mcp__context7: 'ask',
          'mcp__context7__read_file': 'allow',
          'mcp__context7__write_file': 'deny',
        },
        denyPaths: [],
      };

      expect(mcpToolTier(perms, 'mcp__context7__read_file')).toBe('allow');
      expect(mcpToolTier(perms, 'mcp__context7__write_file')).toBe('deny');
      expect(mcpToolTier(perms, 'mcp__context7__other_tool')).toBe('ask');
      expect(mcpToolTier(perms, 'mcp__other__tool')).toBe('allow');
    });
  });

  describe('utility functions', () => {
    it('hashToolCall produces stable sorted JSON representation', () => {
      const hash1 = hashToolCall('read', '{"b":2,"a":1}');
      const hash2 = hashToolCall('read', '{"a":1,"b":2}');
      expect(hash1).toBe(hash2);
      expect(hash1).toBe('read|{"a":1,"b":2}');
    });

    it('isErrorResult detects error in JSON string', () => {
      expect(isErrorResult('{"error":"File not found"}')).toBe(true);
      expect(isErrorResult('{"content":"hello"}')).toBe(false);
      expect(isErrorResult('plain text')).toBe(false);
    });

    it('withNote attaches _note property to JSON string or appends note text', () => {
      const jsonRes = withNote('{"ok":true}', 'Truncated output');
      expect(JSON.parse(jsonRes)).toEqual({ ok: true, _note: 'Truncated output' });

      const textRes = withNote('raw text', 'Note');
      expect(textRes).toBe('raw text\n\n[SYSTEM] Note');
    });
  });

  describe('detectRisky & isApprovedCommand', () => {
    it('detectRisky flags destructive commands', () => {
      expect(detectRisky('rm -rf /')).toContain('deletes root');
      expect(detectRisky('docker run -it ubuntu')).toContain('runs containers');
      expect(detectRisky('ssh user@host')).toContain('opens an SSH connection');
      expect(detectRisky('npm install -g typescript')).toContain('installs a global package');
      expect(detectRisky('ls -la')).toBeNull();
    });

    it('normalizeCommand collapses whitespace', () => {
      expect(normalizeCommand('  pnpm   test   --filter   web ')).toBe('pnpm test --filter web');
    });

    it('isApprovedCommand checks exact or prefix matches', () => {
      const approved = ['pnpm test', 'cargo build'];
      expect(isApprovedCommand('pnpm test', approved)).toBe(true);
      expect(isApprovedCommand('pnpm test --filter web', approved)).toBe(true);
      expect(isApprovedCommand('pnpm test-all', approved)).toBe(false);
      expect(isApprovedCommand('rm -rf /', approved)).toBe(false);
    });
  });

  describe('mcpToolSchema', () => {
    it('wraps an MCP catalog entry in the same shape as a TOOLS entry', () => {
      const schema = mcpToolSchema({ name: 'mcp__context7__read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } });
      expect(schema).toEqual({
        type: 'function',
        function: {
          name: 'mcp__context7__read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      });
    });

    it('falls back to a default description and empty-object parameters when missing', () => {
      const schema = mcpToolSchema({ name: 'mcp__foo__bar', description: '', parameters: null as any });
      expect(schema.function.description).toBe('MCP tool mcp__foo__bar');
      expect(schema.function.parameters).toEqual({ type: 'object', properties: {} });
    });
  });

  describe('tool sets', () => {
    it('MUTATING_TOOLS contains only workspace-mutating or code-running tools', () => {
      expect(MUTATING_TOOLS.has('write')).toBe(true);
      expect(MUTATING_TOOLS.has('bash')).toBe(true);
      expect(MUTATING_TOOLS.has('git_commit')).toBe(true);
      expect(MUTATING_TOOLS.has('read')).toBe(false);
      expect(MUTATING_TOOLS.has('grep')).toBe(false);
    });

    it('PURE_DEDUP_TOOLS and READ_STREAK_TOOLS exclude every mutating tool', () => {
      for (const t of PURE_DEDUP_TOOLS) expect(MUTATING_TOOLS.has(t)).toBe(false);
      for (const t of READ_STREAK_TOOLS) expect(MUTATING_TOOLS.has(t)).toBe(false);
    });
  });
});
