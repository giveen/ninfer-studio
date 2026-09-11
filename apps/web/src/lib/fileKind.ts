/** Classify a workspace path into an editor/display kind + CodeMirror language. */
export type FileKind = 'code' | 'image' | 'binary' | 'plain';
export type LangId =
  | 'javascript' | 'typescript' | 'jsx' | 'tsx' | 'json' | 'python'
  | 'markdown' | 'html' | 'xml' | 'css' | 'rust' | 'cpp' | 'java'
  | 'sql' | 'php' | 'go' | 'yaml' | 'plain';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
export const isImagePath = (p: string) => IMAGE_EXT.has((p.split('.').pop() || '').toLowerCase());

/** Image check wins first (.svg is xml-ish by extension but an image here). */
export function fileKind(path: string): { kind: FileKind; lang: LangId } {
  if (isImagePath(path)) return { kind: 'image', lang: 'plain' };
  const ext = ('.' + (path.split('.').pop() || '')).toLowerCase();
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
    case '.java': case '.kt': case '.kts': return { kind: 'code', lang: 'java' };
    case '.sql': return { kind: 'code', lang: 'sql' };
    case '.php': return { kind: 'code', lang: 'php' };
    case '.go': return { kind: 'code', lang: 'go' };
    case '.yml': case '.yaml': return { kind: 'code', lang: 'yaml' };
    default:
      // .rb (no official @codemirror/lang-ruby on npm) and anything else: plain text.
      return { kind: 'code', lang: 'plain' };
  }
}
