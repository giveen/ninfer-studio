import { useSyncExternalStore } from 'react';

export type ToastTone = 'error' | 'info' | 'success';
export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  retry?: () => void;
  retryLabel?: string;
}

type Listener = () => void;

const toasts: Toast[] = [];
const listeners = new Set<Listener>();
let nextId = 1;

function emit() {
  for (const l of listeners) l();
}

export function pushToast(input: Omit<Toast, 'id'> & { id?: number }) {
  const toast: Toast = { id: input.id ?? nextId++, message: input.message, tone: input.tone ?? 'info', retry: input.retry, retryLabel: input.retryLabel };
  // Dedupe identical consecutive toasts by message.
  if (toasts.length && toasts[toasts.length - 1].message === toast.message) return toasts[toasts.length - 1].id;
  toasts.push(toast);
  // Cap to a small number of visible toasts.
  while (toasts.length > 4) toasts.shift();
  emit();
  return toast.id;
}

export function dismissToast(id: number) {
  const i = toasts.findIndex((t) => t.id === id);
  if (i >= 0) {
    toasts.splice(i, 1);
    emit();
  }
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => toasts,
    () => toasts,
  );
}