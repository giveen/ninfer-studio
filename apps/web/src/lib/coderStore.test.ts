import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getConfig, coderRead } from './api';

vi.mock('./api', () => ({
  getConfig: vi.fn(),
  coderRead: vi.fn(),
}));

import {
  normalizeStore,
  loadStore,
  todoSystemBlock,
  loadDefaultPerms,
  saveDefaultPerms,
  baseName,
  relTime,
  emptyConv,
  newConvId,
  detectCommands,
  CONV_KEY,
  type CoderStore,
  type TodoItem,
} from './coderStore';

const mockGetConfig = vi.mocked(getConfig);
const mockCoderRead = vi.mocked(coderRead);

/** coderRead resolves per-path from a map; any path not in `files` is "not found" (matches a real 404/ENOENT -> caught -> null in detectCommands). */
function mockFiles(files: Record<string, string>) {
  mockCoderRead.mockImplementation(async (path: string) => {
    if (path in files) return { path, content: files[path], binary: false } as any;
    throw new Error('not found');
  });
}

// In Node environment Vitest, global.localStorage may be undefined. Mock simple storage map.
const storageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value.toString(); },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { value: storageMock });
}

describe('coderStore', () => {
  beforeEach(() => {
    localStorage.clear();
    mockGetConfig.mockReset();
    mockCoderRead.mockReset();
  });

  describe('normalizeStore', () => {
    it('normalizes empty store cleanly', () => {
      const empty: CoderStore = { activeWs: '', activeConv: '', workspaces: {} };
      const norm = normalizeStore(empty);
      expect(norm).toEqual({ activeWs: '', activeConv: '', workspaces: {} });
    });

    it('strips extended-length path prefixes (\\\\?\\ and \\\\?/) from Windows paths and merges twin workspaces', () => {
      const conv1 = emptyConv('c1');
      conv1.title = 'Extended workspace conv';
      const conv2 = emptyConv('c2');
      conv2.title = 'Plain workspace conv';

      const raw: CoderStore = {
        activeWs: '\\\\?\\C:\\projects\\my-app',
        activeConv: 'c1',
        workspaces: {
          '\\\\?\\C:\\projects\\my-app': {
            expanded: true,
            conversations: { c1: conv1 },
            order: ['c1'],
            activeConv: 'c1',
          },
          'C:\\projects\\my-app': {
            expanded: false,
            conversations: { c2: conv2 },
            order: ['c2'],
            activeConv: 'c2',
          },
        },
      };

      const norm = normalizeStore(raw);
      expect(norm.activeWs).toBe('C:\\projects\\my-app');
      expect(Object.keys(norm.workspaces)).toEqual(['C:\\projects\\my-app']);

      const mergedWs = norm.workspaces['C:\\projects\\my-app'];
      expect(mergedWs.order).toEqual(['c2', 'c1']);
      expect(mergedWs.conversations['c1'].title).toBe('Extended workspace conv');
      expect(mergedWs.conversations['c2'].title).toBe('Plain workspace conv');
    });

    it('falls back activeWs and activeConv when current selection is invalid', () => {
      const conv = emptyConv('c1');
      const raw: CoderStore = {
        activeWs: 'nonexistent',
        activeConv: 'invalid',
        workspaces: {
          '/home/user/project': {
            expanded: true,
            conversations: { c1: conv },
            order: ['c1'],
            activeConv: 'c1',
          },
        },
      };

      const norm = normalizeStore(raw);
      expect(norm.activeWs).toBe('/home/user/project');
      expect(norm.activeConv).toBe('c1');
    });
  });

  describe('loadStore', () => {
    it('returns empty store when localStorage is empty', () => {
      const store = loadStore();
      expect(store).toEqual({ activeWs: '', activeConv: '', workspaces: {} });
    });

    it('loads and normalizes store from localStorage', () => {
      const conv = emptyConv('conv-123');
      const storeData: CoderStore = {
        activeWs: '/tmp/repo',
        activeConv: 'conv-123',
        workspaces: {
          '/tmp/repo': {
            expanded: true,
            conversations: { 'conv-123': conv },
            order: ['conv-123'],
            activeConv: 'conv-123',
          },
        },
      };
      localStorage.setItem(CONV_KEY, JSON.stringify(storeData));

      const loaded = loadStore();
      expect(loaded.activeWs).toBe('/tmp/repo');
      expect(loaded.activeConv).toBe('conv-123');
      expect(loaded.workspaces['/tmp/repo'].conversations['conv-123'].id).toBe('conv-123');
    });
  });

  describe('todoSystemBlock', () => {
    it('formats populated todo list as markdown checklist', () => {
      const todos: TodoItem[] = [
        { content: 'Write tests', status: 'completed' },
        { content: 'Run linter', status: 'in_progress' },
        { content: 'Deploy app', status: 'pending' },
      ];
      const block = todoSystemBlock(todos);
      expect(block).toContain('1. [x] Write tests');
      expect(block).toContain('2. [~] Run linter');
      expect(block).toContain('3. [ ] Deploy app');
    });

    it('formats empty todo list with explicit clear marker', () => {
      const block = todoSystemBlock([]);
      expect(block).toContain('(no active tasks');
    });
  });

  describe('loadDefaultPerms and saveDefaultPerms', () => {
    it('loads default perms fallback when unset', () => {
      const perms = loadDefaultPerms();
      expect(perms).toBeDefined();
      expect(perms.tools).toBeDefined();
      expect(Array.isArray(perms.denyPaths)).toBe(true);
    });

    it('round-trips custom perms through localStorage', () => {
      const custom = {
        tools: { bash: 'ask' as const, write: 'allow' as const },
        denyPaths: ['.env', 'secrets/'],
      };
      saveDefaultPerms(custom);
      const reloaded = loadDefaultPerms();
      expect(reloaded.tools.bash).toBe('ask');
      expect(reloaded.tools.write).toBe('allow');
      expect(reloaded.denyPaths).toEqual(['.env', 'secrets/']);
    });
  });

  describe('helpers', () => {
    it('baseName extracts basename from path', () => {
      expect(baseName('/foo/bar/baz.txt')).toBe('baz.txt');
      expect(baseName('C:\\foo\\bar\\')).toBe('bar');
      expect(baseName('')).toBe('(root)');
    });

    it('relTime computes human readable relative timestamps', () => {
      const now = Date.now();
      expect(relTime(now)).toBe('now');
      expect(relTime(now - 120_000)).toBe('2m');
      expect(relTime(now - 7_200_000)).toBe('2h');
      expect(relTime(now - 172_800_000)).toBe('2d');
    });

    it('newConvId produces prefix conv-', () => {
      expect(newConvId()).toMatch(/^conv-/);
    });
  });

  describe('detectCommands', () => {
    it('prefers explicit lint/test/build commands from project config', async () => {
      mockGetConfig.mockResolvedValue({ lintCommand: 'biome lint', testCommand: 'vitest run', buildCommand: 'vite build' } as any);
      const cmds = await detectCommands();
      expect(cmds).toEqual({ lint: 'biome lint', test: 'vitest run', build: 'vite build' });
      expect(mockCoderRead).not.toHaveBeenCalled();
    });

    it('falls back to package.json scripts when config has no commands', async () => {
      mockGetConfig.mockResolvedValue({} as any);
      mockFiles({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'jest', build: 'tsc' } }) });
      const cmds = await detectCommands();
      expect(cmds).toEqual({ lint: 'eslint .', test: 'jest', build: 'tsc' });
    });

    it('falls back to fixed Cargo commands when no package.json exists', async () => {
      mockGetConfig.mockResolvedValue({} as any);
      mockFiles({ 'Cargo.toml': '[package]\nname = "foo"' });
      const cmds = await detectCommands();
      expect(cmds).toEqual({ build: 'cargo build', test: 'cargo test', lint: 'cargo clippy -- -D warnings' });
    });

    it('falls back to Makefile targets, detecting only the targets that exist', async () => {
      mockGetConfig.mockResolvedValue({} as any);
      mockFiles({ Makefile: 'build:\n\tgo build ./...\n\ntest:\n\tgo test ./...\n' });
      const cmds = await detectCommands();
      expect(cmds).toEqual({ lint: undefined, test: 'make test', build: 'make build' });
    });

    it('falls back to pytest/ruff when only pyproject.toml exists', async () => {
      mockGetConfig.mockResolvedValue({} as any);
      mockFiles({ 'pyproject.toml': '[tool.poetry]\nname = "foo"' });
      const cmds = await detectCommands();
      expect(cmds).toEqual({ test: 'pytest', lint: 'ruff check .' });
    });

    it('returns an empty object when getConfig throws and no manifest is found', async () => {
      mockGetConfig.mockRejectedValue(new Error('network error'));
      mockFiles({});
      const cmds = await detectCommands();
      expect(cmds).toEqual({});
    });
  });
});
