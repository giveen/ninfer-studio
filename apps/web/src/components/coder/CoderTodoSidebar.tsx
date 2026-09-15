import React from 'react';
import { CheckSquare, Plus, X } from 'lucide-react';
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
  return (
    <div className={cn('flex w-64 flex-col border-l border-line bg-panel', todosJustCreated && 'todo-flash')}>
      <div className="p-2 border-b border-line text-sm font-semibold flex items-center gap-2">
        <CheckSquare size={14} /> Todos
        {todosUpdatedAt != null && (
          <span className="ml-auto font-mono text-[10px] font-normal text-faint" title="Last updated (agent todo_write or your edit)">
            {new Date(todosUpdatedAt).toLocaleTimeString([], { hour12: false })}
          </span>
        )}
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
