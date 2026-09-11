import { useEffect, useState } from 'react';
import { ChevronRight, Folder, X } from 'lucide-react';
import { coderDirs } from '../lib/api';

interface DirBrowserProps {
  initialPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}

/** Modal that navigates the host filesystem so the user can point a workspace
 *  at an existing directory (mirrors deepseek-harness's directory-picker flow).
 *  Starts at the user's home directory (`~` resolves server-side). */
export function DirBrowser({ initialPath = '~', onPick, onClose }: DirBrowserProps) {
  const [current, setCurrent] = useState(initialPath);
  const [dirs, setDirs] = useState<string[]>([]);
  const [exists, setExists] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = (root: string) => {
    const r = root.trim() || '~';
    setLoading(true);
    setError(null);
    coderDirs(r)
      .then((res) => {
        // The server resolves `~` and returns the absolute path — adopt it so
        // Up/child navigation and the footer preview use a real path.
        setCurrent(res.root || r);
        setExists(res.exists && res.isDir);
        setDirs(res.dirs || []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goUp = () => {
    const stripped = current.replace(/\/+$/, '');
    const idx = stripped.lastIndexOf('/');
    const up = idx <= 0 ? '/' : stripped.slice(0, idx) || '/';
    load(up);
  };

  const childPath = (name: string) => {
    const base = current.replace(/\/+$/, '');
    return `${base}/${name}`.replace(/\/+/g, '/');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm font-semibold">
          <Folder size={14} /> Select a workspace folder
          <button className="ml-auto text-faint hover:text-ink" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <button
            className="rounded border border-line px-2 py-1 text-[11px] hover:bg-panel2"
            onClick={goUp}
            title="Up one level"
          >
            ↑ Up
          </button>
          <input
            className="flex-1 rounded border border-line bg-inset px-2 py-1 font-mono text-[12px] outline-none focus:border-accent/50"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') load(current);
            }}
          />
          <button className="rounded border border-line px-2 py-1 text-[11px] hover:bg-panel2" onClick={() => load(current)}>
            Go
          </button>
        </div>

        <div className="min-h-[200px] flex-1 overflow-auto p-2">
          {error && <div className="p-2 text-[12px] text-danger">{error}</div>}
          {!error && !exists && (
            <div className="p-2 text-[12px] text-warn">Path does not exist or is not a directory — type a valid path or navigate up.</div>
          )}
          {loading && <div className="p-2 text-[12px] text-faint">Loading…</div>}
          {!loading &&
            dirs.map((d) => (
              <div
                key={d}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[12px] hover:bg-panel2"
                onClick={() => load(childPath(d))}
              >
                <Folder size={12} className="text-accent" />
                <span className="font-mono">{d}</span>
                <ChevronRight size={12} className="ml-auto text-faint" />
              </div>
            ))}
          {!loading && exists && dirs.length === 0 && <div className="p-2 text-[12px] text-faint">No subfolders here.</div>}
        </div>

        <div className="flex items-center gap-2 border-t border-line px-3 py-2">
          <span className="truncate font-mono text-[11px] text-mute">{current}</span>
          <button
            className="ml-auto rounded bg-accent/15 px-3 py-1 text-[12px] font-medium text-accent hover:bg-accent/25"
            onClick={() => onPick(current)}
          >
            Select this folder
          </button>
        </div>
      </div>
    </div>
  );
}
