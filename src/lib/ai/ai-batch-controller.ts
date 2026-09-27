import type { Bookmark } from '../db';
import type { FolderNode } from '../bookmarks/bookmark-manager';
import { isUncategorizedBookmark } from '../bookmarks/folder-utils';
import { showToast } from '../ui/toast-store';
import { isAiConfigured } from './ai-summarizer';

export interface BulkAiOptions {
  autoSummarize?: boolean;
  autoTags?: boolean;
  autoFolder?: boolean;
}

export async function requestBulkAi(
  selectedIds: Set<number>,
  bookmarks: Bookmark[],
  folders: FolderNode[],
  options: BulkAiOptions
): Promise<{ started: boolean; total?: number }> {
  if (!(await isAiConfigured())) {
    showToast(i18n.t('ai.configFirst'), 'info');
    return { started: false };
  }

  if (!options.autoSummarize && !options.autoTags && !options.autoFolder) {
    showToast(i18n.t('ai.selectAtLeastOneOption'), 'info');
    return { started: false };
  }

  let targetIds: number[];
  if (selectedIds.size > 0) {
    targetIds = Array.from(selectedIds);
  } else if (options.autoFolder && !options.autoSummarize && !options.autoTags) {
    const uncat = bookmarks.filter((b) => isUncategorizedBookmark(b) || !b.folderPath || b.folderPath === '기타' || b.folderPath === 'Other bookmarks');
    targetIds = (uncat.length > 0 ? uncat : bookmarks)
      .map((b) => b.id)
      .filter((id): id is number => id !== undefined);
  } else {
    targetIds = bookmarks.map((b) => b.id).filter((id): id is number => id !== undefined);
  }

  if (targetIds.length === 0) {
    showToast(i18n.t('ai.noBookmarksToProcess'), 'info');
    return { started: false };
  }

  try {
    if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
      await browser.runtime.sendMessage({
        type: 'AI_BULK_PROCESS',
        bookmarkIds: targetIds,
        options,
        folders
      });
      showToast(i18n.t('ai.bulkStarted', { count: targetIds.length }), 'info');
      return { started: true, total: targetIds.length };
    }
  } catch (e: any) {
    showToast(i18n.t('ai.requestFailed', { error: e.message }), 'error');
  }
  return { started: false };
}

export async function requestBulkAiCategorize(
  selectedIds: Set<number>,
  bookmarks: Bookmark[],
  folders: FolderNode[]
): Promise<{ started: boolean; total?: number }> {
  if (!(await isAiConfigured())) {
    showToast(i18n.t('ai.configFirst'), 'info');
    return { started: false };
  }

  const targetIds = selectedIds.size > 0
    ? Array.from(selectedIds)
    : bookmarks.filter(b => !b.folderPath || b.folderPath === '기타' || b.folderPath === 'Other bookmarks').map(b => b.id).filter((id): id is number => id !== undefined);

  if (targetIds.length === 0) {
    showToast(i18n.t('ai.noBookmarksToClassify'), 'info');
    return { started: false };
  }

  try {
    if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
      await browser.runtime.sendMessage({
        type: 'AI_BULK_CATEGORIZE',
        bookmarkIds: targetIds,
        folders
      });
    }
    return { started: true, total: targetIds.length };
  } catch (e: any) {
    showToast(i18n.t('ai.requestFailed', { error: e.message }), 'error');
    return { started: false };
  }
}

export async function requestBulkAiSummarize(
  selectedIds: Set<number>,
  bookmarks: Bookmark[]
): Promise<{ started: boolean; total?: number }> {
  if (!(await isAiConfigured())) {
    showToast(i18n.t('ai.configFirst'), 'info');
    return { started: false };
  }

  const targetIds = selectedIds.size > 0
    ? Array.from(selectedIds)
    : bookmarks.map(b => b.id).filter((id): id is number => id !== undefined);

  if (targetIds.length === 0) return { started: false };
  try {
    if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
      await browser.runtime.sendMessage({
        type: 'AI_BULK_SUMMARIZE',
        bookmarkIds: targetIds
      });
      showToast(i18n.t('ai.bulkSummarizeStarted', { count: targetIds.length }), 'info');
      return { started: true, total: targetIds.length };
    }
  } catch (e: any) {
    showToast(i18n.t('ai.requestFailed', { error: e.message }), 'error');
  }
  return { started: false };
}

export async function retrySingleAi(
  bookmark: Bookmark,
  folders: FolderNode[],
  isAiRunning: boolean
): Promise<void> {
  if (!bookmark.id) return;
  if (isAiRunning) {
    showToast(i18n.t('ai.bulkInProgress'), 'info');
    return;
  }
  if (!(await isAiConfigured())) {
    showToast(i18n.t('ai.configFirst'), 'info');
    return;
  }
  try {
    if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
      await browser.runtime.sendMessage({
        type: 'AI_BULK_CATEGORIZE',
        bookmarkIds: [bookmark.id],
        folders
      });
    }
  } catch (e: any) {
    showToast(i18n.t('ai.requestFailed', { error: e.message }), 'error');
  }
}

export function cancelSingleAi(bookmarkId: number): void {
  try {
    if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
      browser.runtime.sendMessage({ type: 'AI_ABORT_BOOKMARK', bookmarkId });
      showToast(i18n.t('ai.analysisCancelled'), 'info');
    }
  } catch (e) {
    console.error(e);
  }
}

export async function cancelBulkAi(): Promise<void> {
  try {
    if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
      await browser.runtime.sendMessage({ type: 'AI_ABORT_BULK' });
      showToast(i18n.t('ai.analysisCancelled'), 'info');
    }
  } catch (e) {
    console.error(e);
  }
}
