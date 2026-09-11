/**
 * useFileTabs — the Coder screen's VS Code-style tab model.
 *
 * UI-free (no JSX): owns the tab list, live docs (ref map — see the doc-churn
 * note below), dirty/conflict tracking, the mid-run sidecar-hold gate, the
 * workspace-switch generation guard, save-and-lint, and git status badges.
 *
 * Doc-churn control: the hook lives inside CoderScreen (a ~4700-line
 * component), so per-keystroke React state would re-render the whole screen on
 * every `docChanged`. The pane calls `onDocChange(id, doc)` on every
 * `docChanged`; this hook stores it in a ref map and touches state ONLY on
 * transitions (dirty false→true, external doc push, conflict set/clear,
 * save). `tab.doc` is pushed to the pane only on those transitions;
 * @uiw/react-codemirror skips the replace-dispatch when `value` equals the
 * current doc, so typing never re-dispatches and undo history is preserved.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { coderRead, coderReadBase64, coderWrite, coderExec } from '../../lib/api';
import { fileKind, type FileKind, type LangId } from '../../lib/fileKind';
import { fetchGitStatusMap, type GitFileStatus } from '../../lib/gitStatus';
import { parseDiagnostics } from '../../lib/diagnostics';

export interface TabDiag {
  file?: string;
  line?: number;
  col?: number;
  severity?: string;
  message: string;
}

export interface EditorTab {
  id: string;
  path: string;
  kind: FileKind;
  lang: LangId;
  /** Last doc PUSHED to the pane (initial load / adopt / save / conflict
   *  resolution). The live doc while typing lives in the internal ref map;
   *  this field must NOT be updated per keystroke. */
  doc: string;
  /** Last-known disk text. */
  base: string;
  baseBytes: number | null;
  dirty: boolean;
  status: 'loading' | 'ready' | 'error' | 'notfound' | 'binary' | 'conflict';
  error?: string;
  /** >256 KB → read-only (saving truncated content would destroy the tail). */
  truncated: boolean;
  /** Disk != base (set by refresh/poll/activation re-check). */
  diskChanged: boolean;
  diags: TabDiag[];
  linting: boolean;
  gitStatus?: GitFileStatus;
  image?: { dataUrl: string; size: number; mime: string } | null;
}

export interface FileTabsOptions {
  activeWsDir: string | null;
  running: boolean;
  /** Mid-run sidecar-hold gate: CoderScreen passes
   *  `() => wsAppliedDirRef.current === activeWsDir`. While false, every
   *  sidecar-touching op refuses / no-ops (reads would resolve against the
   *  running workspace). */
  sidecarReady?: () => boolean;
  getLintCommand?: () => string | null;
  onUndoEdit?: (path: string) => void;
}

export interface FileTabsApi {
  tabs: EditorTab[];
  activeTabId: string | null;
  /** Inline warning (e.g. tab cap reached). */
  notice: string | null;
  openFile(path: string): boolean;
  closeTab(id: string): void;
  setActive(id: string | null): void;
  /** Live doc from the ref map (current text, not just the last push). */
  getDoc(id: string): string;
  /** Pane → hook: per-keystroke doc update, kept in a ref (no state churn). */
  onDocChange(id: string, doc: string): void;
  saveTab(id?: string): Promise<void>;
  reloadTab(id: string): Promise<void>;
  resolveConflict(id: string, kind: 'reload' | 'keep'): void;
  undoEdit(id: string): void;
  refreshOpenTabs(): Promise<void>;
  refreshGitStatus(): Promise<void>;
  statusMap: Map<string, GitFileStatus>;
}

const MAX_TABS = 24;
const POLL_MS = 8000;
const NOTFOUND_RE = /not found|ENOENT|HTTP 404/i;

/** `postJSON` resolves the body even on 4xx/5xx (it has no `r.ok` check,
 *  unlike `getJSON`) — so an HTTP error that carries a JSON body arrives here
 *  as a "successful" result. Return the error string when the body is an
 *  API error object (error string, none of the success fields), else null. */
function apiErrorBody(v: unknown): string | null {
  const o = v as { error?: string; content?: unknown; binary?: unknown; dataUrl?: unknown } | null;
  if (o && typeof o === 'object' && typeof o.error === 'string' && o.content == null && o.binary == null && o.dataUrl == null) return o.error;
  return null;
}

/** Git status badge color per letter (M=green, A=info, U/D/R=warn). */
export const GIT_BADGE_CLASS: Record<string, string> = {
  M: 'text-ok',
  A: 'text-info',
  U: 'text-warn',
  D: 'text-warn',
  R: 'text-warn',
};

export function useFileTabs(opts: FileTabsOptions): FileTabsApi {
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Map<string, GitFileStatus>>(() => new Map());
  const [notice, setNotice] = useState<string | null>(null);

  // Latest values for interval callbacks / async continuations.
  const optsRef = useRef(opts);
  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => {
    optsRef.current = opts;
    tabsRef.current = tabs;
    activeTabIdRef.current = activeTabId;
  });

  /** Workspace generation — bumped on every activeWsDir change; in-flight
   *  reads from an older generation are dropped. */
  const genRef = useRef(0);
  /** Per-tab read seq — a superseded read for the same tab is dropped
   *  (parallel refreshes of different tabs don't invalidate each other). */
  const readSeqRef = useRef(new Map<string, number>());
  const gitSeqRef = useRef(0);
  const lintSeqRef = useRef(0);
  /** Live docs: tab id → current editor text (updated per keystroke). */
  const docRef = useRef(new Map<string, string>());

  const ready = (): boolean => {
    const o = optsRef.current;
    if (!o.activeWsDir) return false;
    return o.sidecarReady ? o.sidecarReady() : true;
  };

  /** Functional tab patch; null = no change (avoids state churn). */
  const patchTab = useCallback(
    (id: string, patch: (t: EditorTab) => EditorTab | null) => {
      setTabs((prev) => {
        let changed = false;
        const next = prev.map((t) => {
          if (t.id !== id) return t;
          const p = patch(t);
          if (!p) return t;
          changed = true;
          return p;
        });
        return changed ? next : prev;
      });
    },
    [],
  );

  // ---- Workspace switch: close ALL tabs, invalidate in-flight reads, reset
  // the git-status map (known stale-content bug class — do not reintroduce).
  useEffect(() => {
    genRef.current += 1;
    readSeqRef.current.clear();
    docRef.current.clear();
    setTabs([]);
    setActiveTabId(null);
    setStatusMap(new Map());
    setNotice(null);
  }, [opts.activeWsDir]);

  /** Read disk for one tab and apply the compare/adopt/conflict logic
   *  (spec 3.6). `path`/`kind` are passed in (they are stable per tab) because
   *  `tabsRef.current` is only refreshed in a post-render effect — a fresh tab
   *  created in the same event is NOT in the ref yet. `forceAdopt`: after an
   *  explicit reload / conflict-reload the user has already chosen to take the
   *  disk content, so skip the dirty gate.
   *  NOTE: `postJSON` resolves the body even on 4xx/5xx (no `r.ok` check), so
   *  API error bodies ({"error": …}) are normalized into throws here — that is
   *  what drives the notfound / conflict / error paths below. */
  const readDisk = useCallback(
    async (id: string, path: string, kind: FileKind, forceAdopt = false) => {
      const gen = genRef.current;
      const seq = (readSeqRef.current.get(id) || 0) + 1;
      readSeqRef.current.set(id, seq);
      const stillValid = (): boolean => gen === genRef.current && (readSeqRef.current.get(id) || 0) === seq;
      try {
        const rRaw: unknown = await coderRead(path);
        const rErr = apiErrorBody(rRaw);
        if (rErr) throw new Error(rErr);
        const r = rRaw as { content?: string; binary?: boolean; truncated?: boolean };
        if (!stillValid()) return;
        if (r.binary) {
          if (kind === 'image') {
            let img: { dataUrl?: string; size?: number; mime?: string; error?: string };
            try {
              const raw: unknown = await coderReadBase64(path);
              const imgErr = apiErrorBody(raw);
              if (imgErr) throw new Error(imgErr);
              img = raw as { dataUrl?: string; size?: number; mime?: string; error?: string };
              if (!img.dataUrl) throw new Error('image read failed');
            } catch (e) {
              if (!stillValid()) return;
              // e.g. >5 MB image — show the error text in the pane.
              patchTab(id, (t) => ({ ...t, status: 'error', error: e instanceof Error ? e.message : String(e) }));
              return;
            }
            if (!stillValid()) return;
            patchTab(id, (t) => ({ ...t, status: 'ready', image: { dataUrl: img.dataUrl!, size: img.size ?? 0, mime: img.mime ?? '' }, baseBytes: img.size ?? 0 }));
          } else {
            patchTab(id, (t) => ({ ...t, status: 'binary' }));
          }
          return;
        }
        const content = r.content ?? '';
        if (r.truncated) {
          // Read-only view of the first 256 KB; save is disabled for these.
          docRef.current.set(id, content);
          patchTab(id, (t) => ({ ...t, status: 'ready', doc: content, base: content, truncated: true, dirty: false, diskChanged: false, diags: [], linting: false, error: undefined }));
          return;
        }
        patchTab(id, (t) => {
          if (t.truncated) {
            // Disk shrank under the cap — re-open as a normal editable tab.
            docRef.current.set(id, content);
            return { ...t, status: 'ready', doc: content, base: content, truncated: false, dirty: false, diskChanged: false, diags: [], linting: false, error: undefined };
          }
          if (t.status === 'loading') {
            docRef.current.set(id, content);
            return { ...t, status: 'ready', doc: content, base: content, diskChanged: false, error: undefined };
          }
          // Compare/adopt/conflict (3.6):
          if (content === t.base || forceAdopt || !t.dirty) {
            docRef.current.set(id, content);
            return { ...t, doc: content, base: content, diskChanged: false, status: 'ready', dirty: forceAdopt ? false : t.dirty, error: undefined, linting: false };
          }
          // Dirty + disk changed → explicit conflict; never a silent overwrite.
          return { ...t, diskChanged: true, status: 'conflict' };
        });
      } catch (e) {
        if (!stillValid()) return;
        const msg = e instanceof Error ? e.message : String(e);
        patchTab(id, (t) => {
          if (NOTFOUND_RE.test(msg)) {
            // Agent may have deleted it — keep `doc` editable if present.
            return { ...t, status: 'notfound', error: undefined };
          }
          if (t.status === 'loading') return { ...t, status: 'error', error: msg };
          return { ...t, diskChanged: true, status: t.status === 'conflict' ? 'conflict' : t.status };
        });
      }
    },
    [patchTab],
  );

  const refreshGitStatus = useCallback(async () => {
    const o = optsRef.current;
    if (!o.activeWsDir) return;
    if (o.sidecarReady && !o.sidecarReady()) return;
    const gen = genRef.current;
    const seq = ++gitSeqRef.current;
    try {
      const map = await fetchGitStatusMap();
      if (gen !== genRef.current || seq !== gitSeqRef.current) return;
      setStatusMap(map);
      setTabs((prev) => {
        let changed = false;
        const next = prev.map((t) => {
          const s = map.get(t.path);
          if (s === t.gitStatus) return t;
          changed = true;
          return { ...t, gitStatus: s };
        });
        return changed ? next : prev;
      });
    } catch {
      /* not a git repo / exec failed — no badges, no error shown */
    }
  }, []);

  /** Save-and-lint (3.5): background, never blocks the UI, spinner in the pane. */
  const runLint = useCallback(
    async (id: string, path: string, lintCmd: string, gen: number, seq: number) => {
      patchTab(id, (t) => ({ ...t, linting: true }));
      try {
        const r = await coderExec(lintCmd, undefined, 120000);
        if (gen !== genRef.current || seq !== lintSeqRef.current) return;
        if (r.exitCode !== 0) {
          const all = parseDiagnostics(lintCmd, r.stderr || r.stdout || '');
          const norm = (s: string) => s.replace(/\\/g, '/');
          const p = norm(path);
          const diags = all.filter((d) => {
            if (!d.file) return false;
            const f = norm(d.file);
            return f === p || f.endsWith('/' + p) || p.endsWith('/' + f);
          });
          patchTab(id, (t) => ({ ...t, linting: false, diags }));
        } else {
          patchTab(id, (t) => ({ ...t, linting: false, diags: [] }));
        }
      } catch {
        if (gen === genRef.current && seq === lintSeqRef.current) {
          patchTab(id, (t) => ({ ...t, linting: false }));
        }
      }
    },
    [patchTab],
  );

  const saveTab = useCallback(
    async (id?: string) => {
      const o = optsRef.current;
      const targetId = id ?? activeTabIdRef.current;
      if (!targetId) return;
      const t = tabsRef.current.find((x) => x.id === targetId);
      if (!t || t.kind !== 'code' || t.truncated || !t.dirty) return;
      const doc = docRef.current.get(targetId) ?? t.doc;
      if (doc === t.base) {
        patchTab(targetId, (x) => ({ ...x, dirty: false }));
        return;
      }
      const gen = genRef.current;
      const seq = ++lintSeqRef.current;
      try {
        const wRaw: unknown = await coderWrite(t.path, doc);
        const wErr = apiErrorBody(wRaw);
        if (wErr) throw new Error(wErr);
        if (gen !== genRef.current) return;
        const bytes = new TextEncoder().encode(doc).length;
        patchTab(targetId, (x) => ({ ...x, dirty: false, base: doc, baseBytes: bytes, diskChanged: false, status: 'ready', diags: [], error: undefined }));
        void refreshGitStatus();
        const lintCmd = o.getLintCommand?.();
        if (lintCmd) void runLint(targetId, t.path, lintCmd, gen, seq);
      } catch (e) {
        if (gen !== genRef.current) return;
        // Stay dirty; show the error inline.
        patchTab(targetId, (x) => ({ ...x, error: `Save failed: ${e instanceof Error ? e.message : String(e)}` }));
      }
    },
    [patchTab, refreshGitStatus, runLint],
  );

  const setActive = useCallback(
    (id: string | null) => {
      setActiveTabId(id);
      setNotice(null);
      if (!id) return;
      const t = tabsRef.current.find((x) => x.id === id);
      // Activation re-check (3.6): re-fetch disk content for the activated
      // code tab with the same compare/adopt/conflict logic — a `bash` edit to
      // a previously-inactive tab must not survive silently.
      if (t && t.kind === 'code' && !t.truncated && (t.status === 'ready' || t.status === 'conflict' || t.status === 'notfound')) {
        void readDisk(t.id, t.path, t.kind);
      }
      void refreshGitStatus();
    },
    [readDisk, refreshGitStatus],
  );

  const openFile = useCallback(
    (path: string): boolean => {
      const o = optsRef.current;
      if (!o.activeWsDir) return false;
      if (o.sidecarReady && !o.sidecarReady()) return false; // wsHeld chip explains why
      const existing = tabsRef.current.find((t) => t.path === path);
      if (existing) {
        setActive(existing.id);
        return true;
      }
      let list = [...tabsRef.current];
      if (list.length >= MAX_TABS) {
        const victim = list.find((t) => t.id !== activeTabIdRef.current && !t.dirty);
        if (!victim) {
          setNotice(`Too many open tabs (${MAX_TABS}) — close a dirty tab first.`);
          return false;
        }
        docRef.current.delete(victim.id);
        readSeqRef.current.delete(victim.id);
        list = list.filter((t) => t.id !== victim.id);
      }
      const fk = fileKind(path);
      const id = crypto.randomUUID();
      const tab: EditorTab = {
        id, path,
        kind: fk.kind, lang: fk.lang,
        doc: '', base: '', baseBytes: null,
        dirty: false, status: 'loading',
        truncated: false, diskChanged: false,
        diags: [], linting: false, image: null,
      };
      docRef.current.set(id, '');
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(id);
      setNotice(null);
      void refreshGitStatus();
      void readDisk(id, path, fk.kind);
      return true;
    },
    [setActive, refreshGitStatus, readDisk],
  );

  const closeTab = useCallback(
    (id: string) => {
      const t = tabsRef.current.find((x) => x.id === id);
      if (!t) return;
      if (t.dirty && !window.confirm(`Discard unsaved changes in ${t.path}?`)) return;
      docRef.current.delete(id);
      readSeqRef.current.delete(id);
      setTabs((prev) => prev.filter((x) => x.id !== id));
      setActiveTabId((cur) => (cur === id ? null : cur));
    },
    [],
  );

  const getDoc = useCallback(
    (id: string): string => docRef.current.get(id) ?? '',
    [],
  );

  const onDocChange = useCallback(
    (id: string, doc: string) => {
      const prev = docRef.current.get(id);
      if (prev === doc) return;
      docRef.current.set(id, doc);
      const t = tabsRef.current.find((x) => x.id === id);
      if (!t || t.truncated) return;
      // Transition only: dirty false→true. No per-keystroke state otherwise.
      if (!t.dirty && doc !== t.base) {
        patchTab(id, (x) => (x.dirty || x.truncated ? null : { ...x, dirty: true }));
      }
    },
    [patchTab],
  );

  const reloadTab = useCallback(
    async (id: string, skipConfirm = false) => {
      const t = tabsRef.current.find((x) => x.id === id);
      if (!t || !ready()) return;
      if (!skipConfirm && t.dirty && !window.confirm('Discard unsaved changes?')) return;
      await readDisk(id, t.path, t.kind, true);
    },
    [readDisk],
  );

  const resolveConflict = useCallback(
    (id: string, kind: 'reload' | 'keep') => {
      if (kind === 'keep') {
        // Discard the disk content, keep the editor doc; the next save
        // overwrites (an explicit user choice).
        patchTab(id, (t) => ({ ...t, diskChanged: false, status: 'ready' }));
      } else {
        // Take the disk, discard mine (confirm already implied by the banner).
        void reloadTab(id, true);
      }
    },
    [patchTab, reloadTab],
  );

  /** Re-fetch disk content for all open code tabs (parallel, per-tab seq).
   *  Called after every agent mutation (onMutated composite). */
  const refreshOpenTabs = useCallback(async () => {
    const o = optsRef.current;
    if (!o.activeWsDir) return;
    if (o.sidecarReady && !o.sidecarReady()) return;
    const ids = tabsRef.current.filter((t) => t.kind === 'code' && !t.truncated && (t.status === 'ready' || t.status === 'conflict' || t.status === 'notfound')).map((t) => t.id);
    if (ids.length === 0) return;
    await Promise.all(
      ids.map((id) => {
        const t = tabsRef.current.find((x) => x.id === id);
        return t ? readDisk(id, t.path, t.kind) : Promise.resolve();
      }),
    );
  }, [readDisk]);

  // 8 s poll while a run is active: active code tab only (covers `bash` edits
  // between tool passes) + git-status refresh (3.4).
  useEffect(() => {
    if (!opts.running) return;
    const timer = setInterval(() => {
      const o = optsRef.current;
      if (!o.activeWsDir || (o.sidecarReady && !o.sidecarReady())) return;
      void refreshGitStatus();
      const id = activeTabIdRef.current;
      if (!id) return;
      const t = tabsRef.current.find((x) => x.id === id);
      if (t && t.kind === 'code' && !t.truncated && (t.status === 'ready' || t.status === 'conflict')) {
        void readDisk(t.id, t.path, t.kind);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [opts.running, readDisk, refreshGitStatus]);

  // Undo wiring (the pane's Undo button calls this; CoderScreen's undoFileEdit
  // is a git-based per-file undo).
  const undoEdit = useCallback(
    (id: string) => {
      const t = tabsRef.current.find((x) => x.id === id);
      if (!t) return;
      optsRef.current.onUndoEdit?.(t.path);
    },
    [],
  );

  return {
    tabs,
    activeTabId,
    notice,
    openFile,
    closeTab,
    setActive,
    getDoc,
    onDocChange,
    saveTab,
    reloadTab,
    resolveConflict,
    undoEdit,
    refreshOpenTabs,
    refreshGitStatus,
    statusMap,
  };
}
