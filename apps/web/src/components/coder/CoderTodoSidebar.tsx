import React, { useState, useRef, useCallback } from 'react';
import { CheckSquare, Plus, X, ChevronRight, ChevronLeft } from 'lucide-react';
import { Button, cn } from '../ui';
import { TodoItem } from '../../lib/coderStore';

export interface CoderTodoSidebarProps {
  todos: TodoItem[];
  todosUpdatedAt: number | null;
  todosJustCreated: boolean;
  todoDraft: string;
  setTodoDraft: (draft: string) => void;
  cycleTodo: (index: number) => void;
  removeTodo: (index: number) => void;
  addTodo: (content: string) => void;
}

export function CoderTodoSidebar({
  todos,
  todosUpdatedAt,
  todosJustCreated,
  todoDraft,
  setTodoDraft,
  cycleTodo,
  removeTodo,
  addTodo,
}: CoderTodoSidebarProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    return localStorage.getItem('ninfer_coder_todo_collapsed') === 'true';
  });

  const [todoWidth, setTodoWidth] = useState<number>(() => {
    const saved = localStorage.getItem('ninfer_coder_todo_width');
    const num = saved ? Number(saved) : NaN;
    return !isNaN(num) ? Math.min(Math.max(180, num), 500) : 256;
  });

  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  const toggleCollapsed = (val: boolean) => {
    setCollapsed(val);
    localStorage.setItem('ninfer_coder_todo_collapsed', String(val));
  };

  const startResizing = useCallback(
    (mouseDownEvent: React.MouseEvent) => {
      mouseDownEvent.preventDefault();
      setIsResizing(true);
      const startX = mouseDownEvent.clientX;
      const startWidth = sidebarRef.current?.getBoundingClientRect().width ?? todoWidth;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX;
        const newWidth = Math.min(Math.max(180, startWidth + delta), 500);
        setTodoWidth(newWidth);
      };

      const onMouseUp = () => {
        setIsResizing(false);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        setTodoWidth((w) => {
          localStorage.setItem('ninfer_coder_todo_width', String(w));
          return w;
        });
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [todoWidth]
  );

  if (collapsed) {
    return (
      <div className="flex w-9 shrink-0 flex-col items-center border-l border-line bg-panel py-2 transition-colors">
        <button
          type="button"
          onClick={() => toggleCollapsed(false)}
          className="flex flex-col items-center gap-1.5 rounded p-1.5 text-faint hover:bg-panel2 hover:text-ink transition-colors cursor-pointer"
          title="Expand Todos"
        >
          <ChevronLeft size={14} />
          <CheckSquare size={16} />
          {todos.length > 0 && (
            <span
              className="rounded-full bg-accent/20 px-1 py-0.2 font-mono text-[9px] font-bold text-accent"
              title={`${todos.length} task(s)`}
            >
              {todos.length}
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div
      ref={sidebarRef}
      style={{ width: `${todoWidth}px` }}
      className={cn(
        'relative flex shrink-0 flex-col border-l border-line bg-panel',
        todosJustCreated && 'todo-flash',
        isResizing && 'select-none cursor-col-resize'
      )}
    >
      {/* Left-edge resize handle */}
      <div
        onMouseDown={startResizing}
        onDoubleClick={() => {
          setTodoWidth(256);
          localStorage.setItem('ninfer_coder_todo_width', '256');
        }}
        className="absolute top-0 left-[-3px] bottom-0 w-2 cursor-col-resize hover:bg-accent/40 active:bg-accent transition-colors z-10"
        title="Drag to resize Todos (Double-click to reset)"
      />

      <div className="p-2 border-b border-line text-sm font-semibold flex items-center gap-2">
        <CheckSquare size={14} /> Todos
        {todosUpdatedAt != null && (
          <span className="font-mono text-[10px] font-normal text-faint" title="Last updated (agent todo_write or your edit)">
            {new Date(todosUpdatedAt).toLocaleTimeString([], { hour12: false })}
          </span>
        )}
        <button
          type="button"
          onClick={() => toggleCollapsed(true)}
          className="ml-auto rounded p-0.5 text-faint hover:bg-panel2 hover:text-ink transition-colors cursor-pointer"
          title="Collapse Todos"
        >
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="flex-1 p-2 text-[11.5px] text-mute overflow-auto">
        {todos.length === 0 ? (
          'No pending tasks.'
        ) : (
          <div className="space-y-1.5">
            {todos.map((t, i) => (
              <div key={i} className={cn('group flex items-start gap-2', t.status === 'completed' ? 'opacity-50 line-through' : '')}>
                <button
                  type="button"
                  className="mt-0.5 shrink-0 cursor-pointer hover:opacity-70"
                  title={`${t.status} — click to advance to ${t.status === 'pending' ? 'in_progress' : t.status === 'in_progress' ? 'completed' : 'pending'}`}
                  onClick={() => cycleTodo(i)}
                >
                  {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '⏳' : '☐'}
                </button>
                <span className={cn('min-w-0 flex-1 break-words', t.status === 'in_progress' ? 'text-accent font-medium' : '')}>{t.content}</span>
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 text-faint opacity-0 group-hover:opacity-100 hover:text-danger"
                  title="Remove task (takes effect on the agent's next step)"
                  onClick={() => removeTodo(i)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-line p-2">
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            addTodo(todoDraft);
            setTodoDraft('');
          }}
        >
          <input
            value={todoDraft}
            onChange={(e) => setTodoDraft(e.target.value)}
            placeholder="add a task…"
            className="min-w-0 flex-1 rounded border border-line bg-inset px-2 py-1 text-[11px] outline-none focus:border-accent/50"
          />
          <Button size="sm" variant="ghost" type="submit" disabled={!todoDraft.trim()} title="Add a task to the agent's plan — visible to it on its next step">
            <Plus size={13} /> add
          </Button>
        </form>
        <p className="mt-1 text-[10px] text-faint">Click a status to cycle it · your edits reach the agent on its next step</p>
      </div>
    </div>
  );
}
