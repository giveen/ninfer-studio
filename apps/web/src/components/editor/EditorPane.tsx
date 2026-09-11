import { useCallback, useEffect, useMemo, useRef } from 'react';
import ReactCodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { keymap, type ViewUpdate } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { xml } from '@codemirror/lang-xml';
import { css } from '@codemirror/lang-css';
import { rust } from '@codemirror/lang-rust';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { sql } from '@codemirror/lang-sql';
import { php } from '@codemirror/lang-php';
import { go } from '@codemirror/lang-go';
import { yaml } from '@codemirror/lang-yaml';
import { cn } from '../ui';
import { formatBytes } from '../../lib/format';
import type { LangId } from '../../lib/fileKind';
import { GIT_BADGE_CLASS, type EditorTab } from './tabModel';
import { editorTheme } from './EditorTheme';
import ImageViewer from './ImageViewer';

export interface EditorPaneProps {
  tab: EditorTab;
  active: boolean;
  /** Fires per keystroke; the hook keeps it in a ref (no state churn). */
  onDocChange(id: string, doc: string): void;
  onSave(id: string): void;
  onReload(id: string): void;
  onUndo(path: string): void;
  onDiff(path: string): void;
  onResolve(id: string, kind: 'reload' | 'keep'): void;
  /** Disable Undo while a run is in flight (matches the old preview-modal behavior). */
  undoDisabled?: boolean;
}

function langExtension(lang: LangId): Extension[] {
  switch (lang) {
    case 'javascript':
    case 'jsx':
      return [javascript({ jsx: true })];
    case 'typescript':
      return [javascript({ jsx: false, typescript: true })];
    case 'tsx':
      return [javascript({ jsx: true, typescript: true })];
    case 'json':
      return [json()];
    case 'python':
      return [python()];
    case 'markdown':
      return [markdown()];
    case 'html':
      return [html()];
    case 'xml':
      return [xml()];
    case 'css':
      return [css()];
    case 'rust':
      return [rust()];
    case 'cpp':
      return [cpp()];
    case 'java':
      return [java()];
    case 'sql':
      return [sql()];
    case 'php':
      return [php()];
    case 'go':
      return [go()];
    case 'yaml':
      return [yaml()];
    default:
      return [];
  }
}



/** Small button style matching CoderScreen's header buttons. */
const BTN = 'rounded border px-2 py-0.5 text-[11px] font-medium';

/** The file-tab pane: header + CodeMirror 6 / image viewer / message panes,
 *  diagnostics strip, and the conflict banner.
 *  Lazy-loaded (CM6 chunk) — chat-only sessions never pay for it. */
export default function EditorPane(props: EditorPaneProps) {
  const { tab, active, onDocChange, onSave, onReload, onUndo, onDiff, onResolve, undoDisabled } = props;

  const cmRef = useRef<ReactCodeMirrorRef>(null);
  // CM6 in a `display: none` container keeps stale measurements — force a
  // re-measure pass on activation (requestMeasure; `refresh` was removed in
  // newer @codemirror/view).
  useEffect(() => {
    if (active) cmRef.current?.view?.requestMeasure();
  }, [active]);

  // Stable identity for the CM6 pieces (the @uiw wrapper reconfigures the view
  // when extensions/onUpdate identity change, so keep them stable and read
  // the live tab via refs).
  const handlersRef = useRef({ tab, onSave });
  handlersRef.current = { tab, onSave };
  const docCbRef = useRef(onDocChange);
  docCbRef.current = onDocChange;

  const extensions = useMemo<Extension[]>(
    () => [
      ...langExtension(tab.lang),
      syntaxHighlighting(editorTheme),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            const { tab: t, onSave: save } = handlersRef.current;
            if (t.dirty && !t.truncated) {
              save(t.id);
              return true;
            }
            return false;
          },
        },
      ]),
      // eslint-disable-next-line react-hooks/exhaustive-deps
    ],
    [tab.lang],
  );
  const handleUpdate = useCallback(
    (u: ViewUpdate) => {
      if (u.docChanged) docCbRef.current(tab.id, u.state.doc.toString());
    },
    [tab.id],
  );

  const isCode = tab.kind === 'code';
  const showEditor = isCode && (tab.status === 'ready' || tab.status === 'conflict' || (tab.status === 'notfound' && tab.doc.length > 0));
  const saveEnabled = isCode && tab.dirty && !tab.truncated;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={tab.path}>
          {tab.path}
        </span>
        {tab.gitStatus && (
          <span className={cn('shrink-0 font-mono text-[10.5px] font-bold', GIT_BADGE_CLASS[tab.gitStatus])} title={`git status: ${tab.gitStatus}`}>
            {tab.gitStatus}
          </span>
        )}
        {tab.baseBytes != null && <span className="shrink-0 font-mono text-[10.5px] text-faint">{formatBytes(tab.baseBytes)}</span>}
        {tab.truncated && (
          <span className="shrink-0 rounded border border-warn/40 bg-warn/10 px-1.5 text-[10px] text-warn" title="File exceeds the 256 KB read cap — shown read-only; saving would destroy the tail">
            read-only (&gt;256 KB)
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {isCode && (
            <>
              <button
                type="button"
                className={cn(BTN, saveEnabled ? 'border-accent/50 bg-accent/15 text-accent hover:bg-accent/25' : 'border-line text-mute hover:bg-panel2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40')}
                disabled={!saveEnabled}
                onClick={() => onSave(tab.id)}
                title="Save (Ctrl/Cmd+S)"
              >
                Save
              </button>
              <button type="button" className={cn(BTN, 'border-line text-mute hover:bg-panel2 hover:text-ink')} onClick={() => onReload(tab.id)} title="Reload from disk">
                Reload
              </button>
              <button
                type="button"
                className={cn(BTN, 'border-line text-mute hover:bg-panel2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40')}
                disabled={undoDisabled}
                onClick={() => onUndo(tab.path)}
                title="Undo the last edit to this file (reverts it to its previous committed state)"
              >
                Undo
              </button>
            </>
          )}
          <button type="button" className={cn(BTN, 'border-line text-mute hover:bg-panel2 hover:text-ink')} onClick={() => onDiff(tab.path)} title="Diff vs HEAD (staged changes included)">
            Diff
          </button>
        </span>
      </div>

      {/* conflict banner */}
      {tab.status === 'conflict' && (
        <div className="flex shrink-0 items-center gap-2 border-b border-warn/40 bg-warn/10 px-3 py-1.5 text-[11.5px] text-warn">
          <span className="min-w-0 flex-1 truncate">Changed elsewhere since you opened this file.</span>
          <button type="button" className={cn(BTN, 'border-warn/50 bg-warn/15 text-warn hover:bg-warn/25')} onClick={() => onResolve(tab.id, 'reload')}>
            Reload
          </button>
          <button type="button" className={cn(BTN, 'border-warn/50 bg-warn/15 text-warn hover:bg-warn/25')} onClick={() => onResolve(tab.id, 'keep')}>
            Keep mine
          </button>
        </div>
      )}

      {/* inline error (read failure / save failure / >5 MB image) */}
      {tab.error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[11.5px] text-danger">
          <span className="min-w-0 flex-1 truncate font-mono" title={tab.path}>
            {tab.path}
          </span>
          <span className="min-w-0 truncate">{tab.error}</span>
        </div>
      )}

      {/* content */}
      {tab.kind === 'image' && tab.status !== 'error' && <ImageViewer tab={tab} />}
      {tab.kind === 'image' && tab.status === 'error' && (
        <div className="flex flex-1 items-center justify-center text-[11.5px] text-danger">{tab.error}</div>
      )}
      {showEditor && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <ReactCodeMirror
            ref={cmRef}
            value={tab.doc}
            readOnly={tab.truncated}
            theme="none"
            height="100%"
            basicSetup={{ foldGutter: true, highlightActiveLine: true, autocompletion: true }}
            extensions={extensions}
            onCreateEditor={(view) => {
              if (active) view.requestMeasure();
            }}
            onUpdate={handleUpdate}
          />
        </div>
      )}
      {tab.status === 'loading' && (
        <div className="flex flex-1 items-center justify-center text-[11.5px] text-faint">Loading…</div>
      )}
      {tab.status === 'binary' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 text-[11.5px] text-faint">
          <span>binary file — not previewable</span>
          <span className="font-mono text-[10.5px]">{tab.path}</span>
        </div>
      )}
      {tab.status === 'notfound' && !tab.doc && isCode && (
        <div className="flex flex-1 items-center justify-center text-[11.5px] text-faint">File not found on disk</div>
      )}
      {tab.status === 'error' && !showEditor && (
        <div className="flex flex-1 items-center justify-center text-[11.5px] text-danger">
          <span className="font-mono text-[10.5px]">{tab.path}</span>
        </div>
      )}

      {/* diagnostics strip (save-and-lint) */}
      {(tab.diags.length > 0 || tab.linting) && (
        <div className="max-h-24 shrink-0 overflow-auto border-t border-line bg-panel2 px-3 py-1.5">
          {tab.linting && <div className="mb-1 text-[11px] text-faint">Running lint…</div>}
          {tab.diags.map((d, i) => (
            <div key={i} className={cn('font-mono text-[11px]', d.severity === 'warning' ? 'text-warn' : 'text-danger')}>
              {d.severity || 'error'}
              {d.file ? ` ${d.file}${d.line != null ? `:${d.line}` : ''}${d.col != null ? `:${d.col}` : ''}` : ''} — {d.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
