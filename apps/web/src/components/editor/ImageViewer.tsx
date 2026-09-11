import { formatBytes } from '../../lib/format';
import type { EditorTab } from './tabModel';

/** Image tab content: the dataUrl from /api/coder/fs/b64 (≤5 MB). */
export default function ImageViewer({ tab }: { tab: EditorTab }) {
  if (!tab.image) {
    return <div className="flex flex-1 items-center justify-center text-[11.5px] text-faint">Loading image…</div>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-inset p-4">
        <img src={tab.image.dataUrl} alt={tab.path} className="max-h-full max-w-full object-contain" />
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-1.5 font-mono text-[10.5px] text-faint">
        <span className="truncate">{tab.path}</span>
        <span className="ml-auto shrink-0">
          {tab.image.mime} · {formatBytes(tab.image.size)}
        </span>
      </div>
    </div>
  );
}
