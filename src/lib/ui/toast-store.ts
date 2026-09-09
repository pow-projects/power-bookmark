import { writable } from 'svelte/store';

export interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
  duration: number;
}

export const toasts = writable<Toast[]>([]);

/**
 * Adds a global toast notification.
 */
export function showToast(message: string, type: 'success' | 'error' | 'info' = 'info', durationMs = 3000): void {
  const id = Math.random().toString(36).substring(2, 9);
  toasts.update(list => [...list, { id, message, type, duration: durationMs }]);

  setTimeout(() => {
    toasts.update(list => list.filter(t => t.id !== id));
  }, durationMs);
}
