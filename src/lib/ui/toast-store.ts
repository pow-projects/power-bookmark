import { writable } from 'svelte/store';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration: number;
  count?: number;
  timerId?: ReturnType<typeof setTimeout>;
}

export const MAX_ACTIVE_TOASTS = 4;

export const DEFAULT_TOAST_DURATIONS: Record<ToastType, number> = {
  success: 3000,
  info: 3000,
  warning: 4000,
  error: 5000,
};

interface ToastTimerState {
  timerId?: ReturnType<typeof setTimeout>;
  startTime: number;
  remainingTime: number;
  isPaused: boolean;
}

const activeTimers = new Map<string, ToastTimerState>();

export const toasts = writable<Toast[]>([]);

/**
 * Calculates adaptive duration based on text length and type defaults.
 * Adds ~50ms per character beyond 20 characters, capped at 10,000ms.
 */
export function calculateToastDuration(message: string, type: ToastType = 'info'): number {
  const base = DEFAULT_TOAST_DURATIONS[type] ?? 3000;
  const additional = Math.max(0, message.length - 20) * 50;
  return Math.min(10000, base + additional);
}

function clearToastTimer(id: string, listToast?: Toast): void {
  const state = activeTimers.get(id);
  if (state?.timerId) {
    clearTimeout(state.timerId);
  }
  activeTimers.delete(id);

  if (listToast?.timerId) {
    clearTimeout(listToast.timerId);
  }
}

/**
 * Dismisses a toast by its id, clearing any active auto-dismiss timer.
 */
export function dismissToast(id: string): void {
  clearToastTimer(id);
  toasts.update(list => {
    const target = list.find(t => t.id === id);
    if (target?.timerId) {
      clearTimeout(target.timerId);
    }
    return list.filter(t => t.id !== id);
  });
}

/**
 * Clears all active toasts and cancels all pending auto-dismiss timers.
 */
export function clearToasts(): void {
  for (const [, state] of activeTimers.entries()) {
    if (state.timerId) {
      clearTimeout(state.timerId);
    }
  }
  activeTimers.clear();

  toasts.update(list => {
    for (const t of list) {
      if (t.timerId) {
        clearTimeout(t.timerId);
      }
    }
    return [];
  });
}

/**
 * Pauses auto-dismiss timer for a toast (e.g. on mouseenter).
 */
export function pauseToast(id: string): void {
  const state = activeTimers.get(id);
  if (!state || state.isPaused) return;

  if (state.timerId) {
    clearTimeout(state.timerId);
    state.timerId = undefined;
  }
  const elapsed = Date.now() - state.startTime;
  state.remainingTime = Math.max(500, state.remainingTime - elapsed);
  state.isPaused = true;

  toasts.update(list =>
    list.map(t => (t.id === id ? { ...t, timerId: undefined } : t))
  );
}

/**
 * Resumes auto-dismiss timer for a toast with remaining duration (e.g. on mouseleave).
 */
export function resumeToast(id: string): void {
  const state = activeTimers.get(id);
  if (!state || !state.isPaused) return;

  state.startTime = Date.now();
  state.timerId = setTimeout(() => {
    dismissToast(id);
  }, state.remainingTime);
  state.isPaused = false;

  toasts.update(list =>
    list.map(t => (t.id === id ? { ...t, timerId: state.timerId } : t))
  );
}

/**
 * Adds a global toast notification or deduplicates with active messages.
 * Automatically evicts oldest toasts if exceeding MAX_ACTIVE_TOASTS (FIFO).
 *
 * @returns {string} The unique id of the toast notification.
 */
export function showToast(
  message: string,
  type: ToastType = 'info',
  durationMs?: number
): string {
  const finalDuration =
    durationMs !== undefined && durationMs > 0
      ? durationMs
      : calculateToastDuration(message, type);

  let returnedId = '';

  toasts.update(list => {
    // 1. Deduplicate identical active messages with same message and type
    const existingIndex = list.findIndex(t => t.message === message && t.type === type);
    if (existingIndex !== -1) {
      const existing = list[existingIndex];
      returnedId = existing.id;

      clearToastTimer(existing.id, existing);

      const timerId = setTimeout(() => {
        dismissToast(existing.id);
      }, finalDuration);

      activeTimers.set(existing.id, {
        timerId,
        startTime: Date.now(),
        remainingTime: finalDuration,
        isPaused: false,
      });

      const updated = [...list];
      updated[existingIndex] = {
        ...existing,
        count: (existing.count || 1) + 1,
        duration: finalDuration,
        timerId,
      };
      return updated;
    }

    // 2. Create new toast
    const id = Math.random().toString(36).substring(2, 9);
    returnedId = id;

    const timerId = setTimeout(() => {
      dismissToast(id);
    }, finalDuration);

    activeTimers.set(id, {
      timerId,
      startTime: Date.now(),
      remainingTime: finalDuration,
      isPaused: false,
    });

    const newToast: Toast = {
      id,
      message,
      type,
      duration: finalDuration,
      count: 1,
      timerId,
    };

    const nextList = [...list, newToast];

    // 3. FIFO eviction when active toasts exceed MAX_ACTIVE_TOASTS
    while (nextList.length > MAX_ACTIVE_TOASTS) {
      const evicted = nextList.shift();
      if (evicted) {
        clearToastTimer(evicted.id, evicted);
      }
    }

    return nextList;
  });

  return returnedId;
}
