import React, { useEffect } from 'react';
import { Command, X } from 'lucide-react';
import { Button } from './ui';

export interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

const SHORTCUT_GROUPS = [
  {
    title: 'General & Navigation',
    shortcuts: [
      { keys: ['Ctrl', 'K'], label: 'New Chat / New Conversation' },
      { keys: ['Cmd', '/'], label: 'Toggle Keyboard Shortcuts' },
      { keys: ['Esc'], label: 'Cancel stream / Close popovers & modals' },
    ],
  },
  {
    title: 'Chat & Messaging',
    shortcuts: [
      { keys: ['Enter'], label: 'Send Message' },
      { keys: ['Shift', 'Enter'], label: 'New Line' },
      { keys: ['Up Arrow'], label: 'Cycle Previous Sent Prompts (when empty)' },
    ],
  },
  {
    title: 'Coder Harness',
    shortcuts: [
      { keys: ['Ctrl', 'Enter'], label: 'Send instruction to Coder Agent' },
      { keys: ['Middle Click'], label: 'Close Workspace File Tab' },
    ],
  },
];

export function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg rounded-xl border border-line bg-panel p-5 shadow-2xl">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div className="flex items-center gap-2 font-semibold text-ink">
            <Command size={16} className="text-accent" />
            <span>Keyboard Shortcuts</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-faint hover:bg-panel2 hover:text-ink transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mt-4 space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title} className="space-y-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-faint">
                {group.title}
              </h4>
              <div className="space-y-1.5">
                {group.shortcuts.map((sc) => (
                  <div
                    key={sc.label}
                    className="flex items-center justify-between rounded-lg border border-line/50 bg-panel2/50 px-3 py-2 text-[12px]"
                  >
                    <span className="text-mute">{sc.label}</span>
                    <div className="flex items-center gap-1 font-mono text-[10.5px]">
                      {sc.keys.map((k) => (
                        <kbd
                          key={k}
                          className="rounded border border-line bg-inset px-1.5 py-0.5 font-semibold text-ink shadow-xs"
                        >
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5 flex justify-end border-t border-line pt-3">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
