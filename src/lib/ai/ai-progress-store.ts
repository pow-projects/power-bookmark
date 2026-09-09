import { writable } from 'svelte/store';

export interface AiBulkProgress {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  active?: boolean;
}

export interface AiProgressState {
  progress: AiBulkProgress | null;
  lastUpdate: number | null;
  error: string | null;
  crossRootReviewItems: any[] | null;
}

const initialState: AiProgressState = {
  progress: null,
  lastUpdate: null,
  error: null,
  crossRootReviewItems: null
};

export const aiProgressStore = writable<AiProgressState>(initialState);

let isListening = false;
let storageListener: ((changes: Record<string, any>, areaName: string) => void) | null = null;

export function initAiProgressStore(): () => void {
  if (typeof browser === 'undefined' || !browser.storage?.local || isListening) {
    return () => {};
  }

  // Initial local storage data load
  browser.storage.local.get(['ai_bulk_progress', 'ai_bulk_cross_root_review']).then((res: Record<string, any>) => {
    aiProgressStore.update((s) => ({
      ...s,
      progress: (res.ai_bulk_progress as AiBulkProgress) || null,
      crossRootReviewItems: (res.ai_bulk_cross_root_review as any[]) || null
    }));
  }).catch(() => {});

  storageListener = (changes: Record<string, any>, areaName: string) => {
    if (areaName !== 'local') return;

    aiProgressStore.update((s) => {
      let next = { ...s };
      if (changes['ai_bulk_progress']) {
        next.progress = changes['ai_bulk_progress'].newValue || null;
      }
      if (changes['ai_analysis_last_update']) {
        next.lastUpdate = changes['ai_analysis_last_update'].newValue || Date.now();
      }
      if (changes['ai_bulk_cross_root_review']) {
        next.crossRootReviewItems = changes['ai_bulk_cross_root_review'].newValue || null;
      }
      if (changes['ai_analysis_error']) {
        const err = changes['ai_analysis_error'].newValue;
        next.error = err ? err.error || i18n.t('ai.analysisError') : null;
      }
      return next;
    });
  };

  try {
    browser.storage.onChanged.addListener(storageListener);
    isListening = true;
  } catch (e) {
    console.warn('Failed to add aiProgressStore storage listener:', e);
  }

  return () => {
    if (storageListener && typeof browser !== 'undefined' && browser.storage?.onChanged) {
      try {
        browser.storage.onChanged.removeListener(storageListener);
      } catch (e) {
        // ignore
      }
      storageListener = null;
      isListening = false;
    }
  };
}
