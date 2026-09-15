import React from 'react';
import { HelpCircle, Shield } from 'lucide-react';
import { Button } from '../ui';
import { HitlDialog } from '../HitlDialog';
import { DiffReviewModal } from '../DiffReviewModal';
import { MemoryModal } from '../MemoryModal';
import { DirBrowser } from '../DirBrowser';
import { FilePickerModal } from './FilePickerModal';
import { redactSecrets } from '../toolResults';
import { FileNode, ChatAttachment } from '../../lib/types';
import { coderDiff, coderMemoryDropLearning, type CoderDiffResult } from '../../lib/api';
import { fetchFileDiff } from '../../lib/gitStatus';

export interface CoderModalsProps {
  pendingQuestion: string | null;
  askNote: string;
  setAskNote: (val: string) => void;
  resumeFromAsk: (note: string) => void;
  pendingApproval: { name: string; detail: string } | null;
  approvalResolveRef: React.MutableRefObject<((approved: boolean) => void) | null>;
  riskyApproval: { command: string; reason: string; fromSubagent?: boolean } | null;
  riskyResolveRef: React.MutableRefObject<((decision: 'deny' | 'once' | 'remember') => void) | null>;
  diffViewOpen: boolean;
  setDiffViewOpen: (open: boolean) => void;
  commitReviewOpen: boolean;
  commitApprovalFromSubagent: boolean;
  commitResolveRef: React.MutableRefObject<((approved: boolean) => void) | null>;
  fileDiffPath: string | null;
  setFileDiffPath: (path: string | null) => void;
  memOpen: boolean;
  setMemOpen: (open: boolean) => void;
  memory: any;
  adoptMemory: (m: any) => void;
  loadMemory: () => void;
  showDir: boolean;
  setShowDir: (show: boolean) => void;
  handleAddWorkspace: (path: string) => void;
  showPicker: boolean;
  setShowPicker: (show: boolean) => void;
  pickerNodes: FileNode[];
  pickerLoading: boolean;
  pickerExpanded: Record<string, boolean>;
  pickerSelected: Record<string, boolean>;
  toggleNode: (path: string) => void;
  setPickerSelected: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  attachSelected: (nodes: FileNode[]) => void;
  attachments: ChatAttachment[];
  ATTACH_MAX_BYTES: number;
}

export function CoderModals({
  pendingQuestion,
  askNote,
  setAskNote,
  resumeFromAsk,
  pendingApproval,
  approvalResolveRef,
  riskyApproval,
  riskyResolveRef,
  diffViewOpen,
  setDiffViewOpen,
  commitReviewOpen,
  commitApprovalFromSubagent,
  commitResolveRef,
  fileDiffPath,
  setFileDiffPath,
  memOpen,
  setMemOpen,
  memory,
  adoptMemory,
  loadMemory,
  showDir,
  setShowDir,
  handleAddWorkspace,
  showPicker,
  setShowPicker,
  pickerNodes,
  pickerLoading,
  pickerExpanded,
  pickerSelected,
  toggleNode,
  setPickerSelected,
  attachSelected,
  attachments,
  ATTACH_MAX_BYTES,
}: CoderModalsProps) {
  return (
    <>
      {pendingQuestion && (
        <HitlDialog
          tone="accent"
          icon={<HelpCircle size={15} />}
          title="Agent is waiting for your input"
          subtitle="Review the request, then approve or disapprove to continue the run."
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => resumeFromAsk(askNote.trim() ? `Disapproved. ${askNote.trim()}` : 'Disapproved.')}>
                Disapprove
              </Button>
              <Button variant="primary" size="sm" onClick={() => resumeFromAsk(askNote.trim() ? `Approved. ${askNote.trim()}` : 'Approved.')}>
                Approve
              </Button>
            </>
          }
        >
          <div className="whitespace-pre-wrap text-ink/90">{pendingQuestion}</div>
          <textarea
            value={askNote}
            onChange={(e) => setAskNote(e.target.value)}
            placeholder="Optional note to send back with your decision…"
            rows={2}
            className="mt-2 w-full resize-y rounded-md border border-line bg-inset px-2 py-1.5 text-[12px] outline-none focus:border-accent/50"
          />
        </HitlDialog>
      )}
      {pendingApproval && (
        <HitlDialog
          tone="warn"
          width={480}
          icon={<Shield size={15} />}
          title="Agent requests approval"
          subtitle={
            <span>
              <span className="font-mono text-accent">{pendingApproval.name}</span> is set to <span className="font-mono">ask</span> in this workspace.
            </span>
          }
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => approvalResolveRef.current?.(false)}>
                Deny
              </Button>
              <Button variant="primary" size="sm" onClick={() => approvalResolveRef.current?.(true)}>
                Approve once
              </Button>
            </>
          }
        >
          <pre className="m-0 whitespace-pre-wrap break-all font-mono text-[12px] text-ink">{redactSecrets(pendingApproval.detail) || '(no details)'}</pre>
        </HitlDialog>
      )}
      {riskyApproval && (
        <HitlDialog
          tone="warn"
          icon={<Shield size={15} />}
          title="Risky command — approval required"
          subtitle={
            <span>
              {riskyApproval.fromSubagent && <strong className="text-accent">A subagent is requesting permission to run this command. </strong>}
              This command {riskyApproval.reason}. Approve it for this run, or remember it for this workspace so it won&apos;t prompt again.
            </span>
          }
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => riskyResolveRef.current?.('deny')}>
                Deny
              </Button>
              <Button variant="ghost" size="sm" onClick={() => riskyResolveRef.current?.('once')}>
                Approve once
              </Button>
              <Button variant="primary" size="sm" onClick={() => riskyResolveRef.current?.('remember')}>
                Approve &amp; remember
              </Button>
            </>
          }
        >
          <pre className="m-0 whitespace-pre-wrap break-all font-mono text-[12px] text-ink">{redactSecrets(riskyApproval.command) || '(no command)'}</pre>
        </HitlDialog>
      )}

      {/* Diff-review viewer: working-tree vs HEAD */}
      <DiffReviewModal open={diffViewOpen} mode="view" title="Working tree vs HEAD" onClose={() => setDiffViewOpen(false)} fetchDiff={coderDiff} />
      {/* Commit-approval gate: the agent asked to commit while the gate is ON. */}
      <DiffReviewModal
        open={commitReviewOpen}
        mode="approve"
        title="Approve commit?"
        banner={commitApprovalFromSubagent ? 'A subagent is requesting permission to commit.' : undefined}
        onClose={() => commitResolveRef.current?.(false)}
        onApprove={() => commitResolveRef.current?.(true)}
        fetchDiff={coderDiff}
      />
      {/* Per-file diff vs HEAD */}
      <DiffReviewModal
        open={fileDiffPath !== null}
        mode="view"
        title={fileDiffPath ?? undefined}
        onClose={() => setFileDiffPath(null)}
        fetchDiff={() => (fileDiffPath ? fetchFileDiff(fileDiffPath) : Promise.resolve({ files: [], diff: '' }))}
      />
      {/* Self-improving memory: intent continuity rules */}
      <MemoryModal
        open={memOpen}
        onClose={() => setMemOpen(false)}
        memory={memory}
        onDropLearning={(id) => coderMemoryDropLearning(id).then((m) => adoptMemory(m))}
        onChanged={() => loadMemory()}
      />
      {showDir && <DirBrowser initialPath="~" onPick={(p) => { handleAddWorkspace(p); setShowDir(false); }} onClose={() => setShowDir(false)} />}

      {showPicker && (
        <FilePickerModal
          nodes={pickerNodes}
          loading={pickerLoading}
          expanded={pickerExpanded}
          selected={pickerSelected}
          onToggle={toggleNode}
          onToggleSelect={(p) => setPickerSelected((s) => ({ ...s, [p]: !s[p] }))}
          onAttachSelected={attachSelected}
          onClose={() => setShowPicker(false)}
          attached={attachments}
          maxBytes={ATTACH_MAX_BYTES}
        />
      )}
    </>
  );
}
