/**
 * useFileTabs — the Coder screen's VS Code-style tab model.
 *
 * UI-free (no JSX): owns the tab list, live docs (ref map — see the doc-churn
 * note below), dirty/conflict tracking, the mid-run sidecar-hold gate, the
 * workspace-switch generation guard + per-workspace tab snapshots (open tabs
 * and unsaved docs persist across a workspace round-trip), save-and-lint,
 * and git status badges.
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
  /** Bumped on every EXTERNAL doc push (load/adopt/save-ack/restore/resolve).
   *  The pane keys the CodeMirror instance on this: within one mount cycle
   *  the controlled `value` prop is constant, so a metadata re-render can
   *  never dispatch the (stale) pushed doc over the live editor content;
   *  a remount only ever happens with the new external content. */
  docRev: number;
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
/** Cap on remembered per-workspace tab sets (LRU-ish: first-inserted evicted). */
const MAX_WS_SNAPSHOTS = 8;
const POLL_MS = 8000;

/** Serializable per-workspace tab state, restored on workspace round-trip. */
interface WsSnapshot {
  tabs: EditorTab[];
  /** Live (unsaved) docs: tab id → current editor text. */
  docs: Map<string, string>;
  activeTabId: string | null;
}
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
  /** Per-tab lint seq — saving in another tab must not supersede this tab's
   *  in-flight lint (a global seq would strand its `linting` spinner). */
  const lintSeqRef = useRef(new Map<string, number>());
  /** Live docs: tab id → current editor text (updated per keystroke). */
  const docRef = useRef(new Map<string, string>());
  /** Per-workspace snapshots of the open tab set (see the switch effect
   *  below) + the last-seen activeWsDir, so a switch can snapshot the
   *  workspace being left and restore the one being entered. */
  const perWsRef = useRef(new Map<string, WsSnapshot>());
  const prevWsRef = useRef<string | null>(null);

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

  /** Every EXTERNAL doc push bumps docRev (see EditorTab.docRev): the pane
   *  remounts CodeMirror on it, so `value` only ever changes together with a
   *  fresh mount — never under a live doc. Only bumps when `doc` actually
   *  changes (a conflict transition must NOT remount over unsaved edits).
   *  Kept OUT of per-keystroke paths. */
  const pushDocTab = useCallback(
    (id: string, patch: (t: EditorTab) => EditorTab | null) => {
      patchTab(id, (t) => {
        const p = patch(t);
        if (!p) return null;
        return p.doc !== t.doc ? { ...p, docRev: t.docRev + 1 } : p;
      });
    },
    [patchTab],
  );

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
      // Defensive sidecar-hold gate: callers are gated too (openFile, restore,
      // polls), but a relative read must never fly while the sidecar still
      // points at another workspace — e.g. setActive's activation re-check.
      if (!ready()) return;
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
        if (kind === 'image') {
          // Image tabs ALWAYS take the base64 path — the sidecar marks a file
          // binary only on a NUL byte, so text-readable formats (SVG) reach
          // here with r.binary === false and would spin on "Loading image…".
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
          return;
        }
        if (r.binary) {
          patchTab(id, (t) => ({ ...t, status: 'binary' }));
          return;
        }
        const content = r.content ?? '';
        if (r.truncated) {
          // External doc push on the adopt path (read-only view); the
          // conflict path keeps the live doc and no doc change → no remount.
          pushDocTab(id, (t) => {
            // Dirty + disk grew past the cap → conflict: keep the live doc,
            // never silently discard unsaved edits for a read-only view.
            if (t.dirty && !forceAdopt && !t.truncated) return { ...t, diskChanged: true, status: 'conflict' };
            // Read-only view of the first 256 KB; save is disabled for these.
            docRef.current.set(id, content);
            return { ...t, status: 'ready', doc: content, base: content, truncated: true, dirty: false, diskChanged: false, diags: [], linting: false, error: undefined };
          });
          return;
        }
        pushDocTab(id, (t) => {
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

  // ---- Workspace switch: snapshot the tabs of the workspace being left
  // (VS Code-style: open tabs AND unsaved docs persist per workspace),
  // restore the target workspace's snapshot if it has one, and re-read every
  // restored tab against disk — the existing compare/adopt/conflict logic
  // means a file edited while we were away is adopted (clean tab) or raises
  // the conflict banner (dirty tab), never a silent overwrite. In-flight
  // reads from the old generation are invalidated as before (known
  // stale-content bug class — do not reintroduce).
  useEffect(() => {
    genRef.current += 1;
    const prevWs = prevWsRef.current;
    const curTabs = tabsRef.current;
    // Snapshot even with ZERO open tabs: otherwise a workspace that was
    // snapshotted once and then fully closed would restore the STALE tab set
    // on the next round-trip.
    if (prevWs && prevWs !== opts.activeWsDir) {
      const docs = new Map<string, string>();
      const snap: EditorTab[] = curTabs.map((t) => {
        const live = docRef.current.get(t.id) ?? t.doc;
        docs.set(t.id, live);
        return {
          ...t,
          doc: live,
          // A mid-load tab re-reads on restore; 'ready' lets readDisk take
          // the compare/adopt path instead of the unconditional-adopt path.
          status: t.status === 'loading' ? 'ready' : t.status,
          // Drop the image payload: a 50 MB image is a ~67 MB base64 string.
          // Restore always re-reads image tabs (readDisk refetches fs/b64), so
          // caching the dataUrl in the snapshot is pure memory retention —
          // with 8 ws × several image tabs this is O(hundreds of MB). The
          // pane shows "Loading image…" until the re-read lands (immediately
          // when the sidecar is ready, next refresh while a run holds it).
          image: null,
          // Stale across a round-trip — refreshed by the restore re-read / CoderScreen's git poll.
          linting: false,
          diags: [],
          gitStatus: undefined,
        };
      });
      perWsRef.current.set(prevWs, { tabs: snap, docs, activeTabId: activeTabIdRef.current });
      if (perWsRef.current.size > MAX_WS_SNAPSHOTS) {
        const oldest = perWsRef.current.keys().next().value;
        if (oldest != null) perWsRef.current.delete(oldest);
      }
    }
    prevWsRef.current = opts.activeWsDir;
    readSeqRef.current.clear();
    docRef.current.clear();
    setStatusMap(new Map());
    setNotice(null);
    const snap = opts.activeWsDir ? perWsRef.current.get(opts.activeWsDir) : undefined;
    if (!snap) {
      setTabs([]);
      setActiveTabId(null);
      return;
    }
    perWsRef.current.delete(opts.activeWsDir!);
    for (const [id, doc] of snap.docs) docRef.current.set(id, doc);
    setTabs(snap.tabs);
    setActiveTabId(snap.activeTabId);
    // Sidecar-hold gate: while a run pins the sidecar elsewhere, show the
    // snapshot as-is; the next refresh (activation re-check / run poll /
    // wsFlushed git poll) picks up the disk state.
    if (ready()) {
      void Promise.all(
        snap.tabs
          .filter((t) => (t.kind === 'code' ? !t.truncated : true))
          .map((t) => readDisk(t.id, t.path, t.kind)),
      );
    }
  }, [opts.activeWsDir, readDisk]);

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
        if (gen !== genRef.current || (lintSeqRef.current.get(id) || 0) !== seq) return;
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
        if (gen === genRef.current && (lintSeqRef.current.get(id) || 0) === seq) {
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
      // Sidecar-hold gate, same as the read paths: a held A→B switch must not
      // let a visible B tab write its relative path into A. Stay dirty and
      // surface why instead of silently firing.
      if (!ready()) {
        patchTab(targetId, (x) => ({ ...x, error: 'Save held — the sidecar is still on another workspace (run in flight). Try again once the switch completes.' }));
        return;
      }
      const gen = genRef.current;
      const seq = (lintSeqRef.current.get(targetId) || 0) + 1;
      lintSeqRef.current.set(targetId, seq);
      try {
        const wRaw: unknown = await coderWrite(t.path, doc);
        const wErr = apiErrorBody(wRaw);
        if (wErr) throw new Error(wErr);
        if (gen !== genRef.current) return;
        const bytes = new TextEncoder().encode(doc).length;
        // The editor kept taking input while the write was in flight: if the
        // live doc diverged from the saved one, keep it dirty. `tab.doc`
        // tracks the LIVE doc either way (so the controlled `value` content
        // always equals the editor's content and @uiw's replace-dispatch is
        // a no-op), while `base` tracks the saved-on-disk content the next
        // save diffs against. Plain patchTab on purpose: no docRev bump, so
        // the pane never remounts over the live editor content (undo history
        // survives a save).
        const live = docRef.current.get(targetId);
        const diverged = live != null && live !== doc;
        docRef.current.set(targetId, diverged ? live : doc);
        patchTab(targetId, (x) => ({ ...x, dirty: diverged, doc: live ?? doc, base: doc, baseBytes: bytes, diskChanged: false, status: 'ready', diags: [], error: undefined }));
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
      // a previously-inactive tab must not survive silently. Image tabs are
      // re-fetched too (they can reach here with `image: null` after a
      // workspace-restore while the sidecar was held — the snapshot drops
      // dataUrls and the restore re-read was gated off).
      if (t && (t.kind === 'code' || t.kind === 'image') && !t.truncated && (t.status === 'ready' || t.status === 'conflict' || t.status === 'notfound')) {
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
        doc: '', base: '', baseBytes: null, docRev: 0,
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

  /** Re-fetch disk content for all open code tabs AND image tabs (parallel,
   *  per-tab seq). Called after every agent mutation (onMutated composite)
   *  and after a held workspace switch's sidecar re-point flushes (CoderScreen
   *  flush effect) — image tabs need it because the per-workspace snapshot
   *  drops their payload and a held switch skips the restore re-read. */
  const refreshOpenTabs = useCallback(async () => {
    const o = optsRef.current;
    if (!o.activeWsDir) return;
    if (o.sidecarReady && !o.sidecarReady()) return;
    const ids = tabsRef.current.filter((t) => (t.kind === 'code' ? !t.truncated : t.kind === 'image') && (t.status === 'ready' || t.status === 'conflict' || t.status === 'notfound')).map((t) => t.id);
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
