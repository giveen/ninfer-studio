import { ChevronDown, ChevronRight, File, Folder, Image, Paperclip, X } from 'lucide-react';
import { Button, cn } from '../ui';
import { isImagePath } from '../../lib/fileKind';
import type { ChatAttachment, FileNode } from '../../lib/types';

interface FilePickerModalProps {
  nodes: FileNode[];
  loading: boolean;
  expanded: Record<string, boolean>;
  selected: Record<string, boolean>;
  onToggle: (path: string) => void;
  onToggleSelect: (path: string) => void;
  onAttachSelected: (nodes: FileNode[]) => void;
  onClose: () => void;
  attached: ChatAttachment[];
  maxBytes: number;
}

export function FilePickerModal({
  nodes,
  loading,
  expanded,
  selected,
  onToggle,
  onToggleSelect,
  onAttachSelected,
  onClose,
  attached,
  maxBytes,
}: FilePickerModalProps) {
  const attachedPaths = new Set(attached.map((a) => a.path));
  const collectFiles = (list: FileNode[]): FileNode[] => {
    const out: FileNode[] = [];
    for (const n of list) {
      if (n.kind === 'file') out.push(n);
      if (n.children) out.push(...collectFiles(n.children));
    }
    return out;
  };
  const allFiles = collectFiles(nodes);
  const selectedNodes = allFiles.filter((n) => selected[n.path]);
  const renderNodes = (list: FileNode[], depth: number): React.ReactNode => (
    <div>
      {list.map((n) => (
        <div key={n.path}>
          <div className="flex items-center gap-1 py-0.5 hover:bg-panel2 rounded px-1" style={{ paddingLeft: depth * 12 }}>
            {n.kind === 'dir' ? (
              <button type="button" onClick={() => onToggle(n.path)} className="flex items-center gap-1 text-ink">
                {expanded[n.path] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Folder size={13} className="text-accent" /> {n.name}
              </button>
            ) : (
              <label className={cn('flex items-center gap-1 text-ink', attachedPaths.has(n.path) ? 'opacity-50' : '')}>
                <input
                  type="checkbox"
                  checked={!!selected[n.path]}
                  disabled={attachedPaths.has(n.path) || (n.size ?? 0) > maxBytes}
                  onChange={() => onToggleSelect(n.path)}
                />
                {isImagePath(n.path) ? <Image size={13} /> : <File size={13} />} {n.name}
                {n.size != null &&
                  (n.size > maxBytes ? (
                    <span className="text-danger text-[10px]">over 50 MB</span>
                  ) : (
                    <span className="text-faint text-[10px]">{Math.ceil(n.size / 1024)} KB</span>
                  ))}
              </label>
            )}
          </div>
          {n.kind === 'dir' && expanded[n.path] && n.children && renderNodes(n.children, depth + 1)}
        </div>
      ))}
    </div>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[520px] max-h-[70vh] flex flex-col rounded-xl border border-line bg-panel shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line p-3">
          <div className="text-sm font-semibold flex items-center gap-2"><Paperclip size={14} /> Attach workspace files</div>
          <button type="button" onClick={onClose} className="text-faint hover:text-ink"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-auto p-2 text-[12.5px]">
          {loading ? (
            <div className="p-3 text-faint">Loading tree…</div>
          ) : nodes.length ? (
            renderNodes(nodes, 0)
          ) : (
            <div className="p-3 text-faint">No files.</div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-line p-2">
          <span className="text-[11px] text-faint">Select files (≤50 MB each). Images embed as pictures; others inline as text.</span>
          <Button variant="primary" size="sm" disabled={selectedNodes.length === 0} onClick={() => onAttachSelected(selectedNodes)}>
            Attach {selectedNodes.length || ''} selected
          </Button>
        </div>
      </div>
    </div>
  );
}
