/** Classify a workspace path into an editor/display kind + CodeMirror language. */
export type FileKind = 'code' | 'image' | 'binary';
export type LangId =
  | 'javascript' | 'typescript' | 'jsx' | 'tsx' | 'json' | 'python'
  | 'markdown' | 'html' | 'xml' | 'css' | 'rust' | 'cpp' | 'java'
  | 'sql' | 'php' | 'go' | 'yaml' | 'plain';

/** Extract lowercase extension (e.g. '.ts', '.png') from a path safely.
 *  Returns empty string if no extension is present or if the dot is in a folder name. */
export function extName(path: string): string {
  const slashIdx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const filename = slashIdx >= 0 ? path.slice(slashIdx + 1) : path;
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx <= 0) return '';
  return filename.slice(dotIdx).toLowerCase();
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
const BINARY_EXT = new Set([
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.obj',
  '.wasm', '.class', '.pyc', '.pyo',
  '.db', '.sqlite', '.sqlite3',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.bin', '.dat', '.iso', '.dmg',
]);

/** Image check wins first (.svg is text/XML-like by bytes, but recognized as an image here
 *  so tabModel routes to base64 preview rendering). */
export const isImagePath = (p: string): boolean => IMAGE_EXT.has(extName(p));

/** Known non-text binary formats that cannot be edited or previewed as plain text. */
export const isBinaryPath = (p: string): boolean => BINARY_EXT.has(extName(p));

export function fileKind(path: string): { kind: FileKind; lang: LangId } {
  if (isImagePath(path)) return { kind: 'image', lang: 'plain' };
  if (isBinaryPath(path)) return { kind: 'binary', lang: 'plain' };

  const ext = extName(path);
  switch (ext) {
    case '.ts': case '.mts': case '.cts': return { kind: 'code', lang: 'typescript' };
    case '.tsx': return { kind: 'code', lang: 'tsx' };
    case '.js': case '.mjs': case '.cjs': return { kind: 'code', lang: 'javascript' };
    case '.jsx': return { kind: 'code', lang: 'jsx' };
    case '.json': case '.jsonc': return { kind: 'code', lang: 'json' };
    case '.py': case '.pyi': return { kind: 'code', lang: 'python' };
    case '.md': case '.markdown': case '.mdx': return { kind: 'code', lang: 'markdown' };
    case '.html': case '.htm': case '.vue': case '.svelte': return { kind: 'code', lang: 'html' };
    case '.xml': case '.xsl': case '.xslt': return { kind: 'code', lang: 'xml' };
    case '.css': case '.less': case '.scss': return { kind: 'code', lang: 'css' };
    case '.rs': return { kind: 'code', lang: 'rust' };
    case '.c': case '.cpp': case '.cc': case '.cxx': case '.h': case '.hpp': return { kind: 'code', lang: 'cpp' };
    case '.cs': return { kind: 'code', lang: 'java' };
    case '.java': case '.kt': case '.kts': return { kind: 'code', lang: 'java' };
    case '.sql': return { kind: 'code', lang: 'sql' };
    case '.php': return { kind: 'code', lang: 'php' };
    case '.go': return { kind: 'code', lang: 'go' };
    case '.yml': case '.yaml': return { kind: 'code', lang: 'yaml' };
    case '.toml': return { kind: 'code', lang: 'yaml' };
    case '.sh': case '.bash': case '.zsh': case '.ps1': return { kind: 'code', lang: 'plain' };
    case '.txt': case '.csv': case '.log': case '.lua': case '.rb': case '.swift': case '.dart':
    default:
      return { kind: 'code', lang: 'plain' };
  }
}
