import { describe, it, expect } from 'vitest';
import { extName, isImagePath, isBinaryPath, fileKind } from './fileKind';

describe('fileKind module', () => {
  describe('extName', () => {
    it('extracts lowercase extension including leading dot', () => {
      expect(extName('/src/index.ts')).toBe('.ts');
      expect(extName('APP.TSX')).toBe('.tsx');
      expect(extName('archive.tar.gz')).toBe('.gz');
    });

    it('handles dotfiles and folder paths with dots correctly', () => {
      expect(extName('.gitignore')).toBe('');
      expect(extName('.env')).toBe('');
      expect(extName('src/v1.2/README')).toBe('');
      expect(extName('C:\\v1.2\\App.py')).toBe('.py');
      expect(extName('C:\\v1.2\\README')).toBe('');
    });
  });

  describe('isImagePath', () => {
    it('identifies image extensions', () => {
      expect(isImagePath('logo.png')).toBe(true);
      expect(isImagePath('photo.JPEG')).toBe(true);
      expect(isImagePath('diagram.svg')).toBe(true);
      expect(isImagePath('icon.ico')).toBe(true);
    });

    it('rejects non-image extensions', () => {
      expect(isImagePath('main.rs')).toBe(false);
      expect(isImagePath('archive.zip')).toBe(false);
    });
  });

  describe('isBinaryPath', () => {
    it('identifies known binary extensions', () => {
      expect(isBinaryPath('archive.zip')).toBe(true);
      expect(isBinaryPath('app.exe')).toBe(true);
      expect(isBinaryPath('module.wasm')).toBe(true);
      expect(isBinaryPath('data.db')).toBe(true);
      expect(isBinaryPath('doc.pdf')).toBe(true);
      expect(isBinaryPath('compiled.pyc')).toBe(true);
    });

    it('rejects non-binary extensions', () => {
      expect(isBinaryPath('index.ts')).toBe(false);
      expect(isBinaryPath('image.png')).toBe(false);
      expect(isBinaryPath('README.md')).toBe(false);
    });
  });

  describe('fileKind', () => {
    it('classifies images as kind image', () => {
      expect(fileKind('hero.png')).toEqual({ kind: 'image', lang: 'plain' });
      expect(fileKind('vector.svg')).toEqual({ kind: 'image', lang: 'plain' });
    });

    it('classifies binary files as kind binary', () => {
      expect(fileKind('program.wasm')).toEqual({ kind: 'binary', lang: 'plain' });
      expect(fileKind('database.sqlite')).toEqual({ kind: 'binary', lang: 'plain' });
    });

    it('maps source files to their CodeMirror language ID', () => {
      expect(fileKind('app.ts')).toEqual({ kind: 'code', lang: 'typescript' });
      expect(fileKind('component.tsx')).toEqual({ kind: 'code', lang: 'tsx' });
      expect(fileKind('server.js')).toEqual({ kind: 'code', lang: 'javascript' });
      expect(fileKind('main.rs')).toEqual({ kind: 'code', lang: 'rust' });
      expect(fileKind('module.py')).toEqual({ kind: 'code', lang: 'python' });
      expect(fileKind('styles.css')).toEqual({ kind: 'code', lang: 'css' });
      expect(fileKind('config.json')).toEqual({ kind: 'code', lang: 'json' });
      expect(fileKind('query.sql')).toEqual({ kind: 'code', lang: 'sql' });
    });

    it('maps C# to java lang and TOML to yaml lang', () => {
      expect(fileKind('Program.cs')).toEqual({ kind: 'code', lang: 'java' });
      expect(fileKind('Cargo.toml')).toEqual({ kind: 'code', lang: 'yaml' });
    });

    it('maps shell scripts, logs, and unknown extensions to code kind with plain lang', () => {
      expect(fileKind('build.sh')).toEqual({ kind: 'code', lang: 'plain' });
      expect(fileKind('output.log')).toEqual({ kind: 'code', lang: 'plain' });
      expect(fileKind('script.rb')).toEqual({ kind: 'code', lang: 'plain' });
      expect(fileKind('UNKNOWN_FILE')).toEqual({ kind: 'code', lang: 'plain' });
    });
  });
});
