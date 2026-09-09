/**
 * Module that executes bulk AI categorization/summarization in the **background service worker**.
 *
 * Moves the bulk loop from the management page (BookmarkList) to SW, allowing tasks to continue
 * even if the page is refreshed or navigated away from.
 *
 * - Task start/resume: When management page sends `AI_BULK_CATEGORIZE` / `AI_BULK_SUMMARIZE` messages,
 *   background.ts executes this module fire-and-forget.
 * - State storage: Saves `aiStatus` per bookmark to DB (updateBookmark) — when page is reloaded,
 *   restores spinner state per card from DB. updateBookmark does not bump modifiedAt when only changing
 *   aiStatus, preventing LWW sync distortion.
 * - Progress: Updates {kind, total, done, status, at} in `storage.local`'s `ai_bulk_progress`,
 *   and page reflects real-time progress via storage.onChanged. On page reload,
 *   reads this key to restore in-progress tasks.
 * - Abort: `AI_ABORT_BULK` message -> AbortController.abort() -> loop stops and
 *   in-progress bookmarks revert to aiStatus=none.
 *
 * browser.* APIs are used only for update triggers (storage.local.set) and folder moves (move),
 * safely skipped in environments without browser globals like Node test environments.
 */
import { analyzeContent, isAiConfigured } from './ai-summarizer';
import { BookmarkManager, resolveSuggestedFolder, resolveSuggestedFolderWithRoot } from '../bookmarks/bookmark-manager';
import { fetchHtmlWithCharset } from '../archive/fetch-with-charset';
import { extractPagePayloadFromHtml } from '../archive/html-text-extractor';
import { decompressArchiveHtml } from '../archive/page-capture';
import db, { type Bookmark, type CrossRootReviewData } from '../db';
import { isNoBodyText, isGenericCategory, type ExtractedPagePayload, type FolderInfo } from './types';

export type BulkAiKind = 'categorize' | 'summarize';

export interface BulkProgress {
  kind: BulkAiKind;
  total: number;
  done: number;
  status: 'running' | 'done' | 'error';
  at: number;
}

/** Records progress in storage.local (no-op in absence of browser) */
async function saveProgress(progress: BulkProgress): Promise<void> {
  try {
    if (typeof browser !== 'undefined' && browser.storage?.local) {
      await browser.storage.local.set({ ai_bulk_progress: progress });
    }
  } catch (e) {
    console.warn('Failed to persist bulk AI progress:', e);
  }
}

/** Reads ai_bulk_progress from storage.local (undefined if absent). */
export async function getBulkProgress(): Promise<BulkProgress | undefined> {
  try {
    if (typeof browser !== 'undefined' && browser.storage?.local) {
      const res = await browser.storage.local.get('ai_bulk_progress');
      const p = res?.['ai_bulk_progress'];
      return p as BulkProgress | undefined;
    }
  } catch (e) {
    console.warn('Failed to read bulk AI progress:', e);
  }
  return undefined;
}

/** Removes ai_bulk_progress from storage.local. */
export async function clearBulkProgress(): Promise<void> {
  try {
    if (typeof browser !== 'undefined' && browser.storage?.local) {
      await browser.storage.local.remove('ai_bulk_progress');
    }
  } catch (e) {
    console.warn('Failed to clear bulk AI progress:', e);
  }
}

/** Notification key enabling management page to detect/restore bulk tasks (same contract as `ai_analysis_last_update`). */
async function notifyManagementPage(): Promise<void> {
  try {
    if (typeof browser !== 'undefined' && browser.storage?.local) {
      await browser.storage.local.set({ 'ai_analysis_last_update': Date.now() });
    }
  } catch (e) {
    console.warn('Failed to notify management page of bulk AI update:', e);
  }
}

/**
 * If page body text is insufficient (< 50 chars), extracts page info via multi-tier strategy to construct AI analysis payload:
 * 1. If open tab exists for URL in browser, prioritized collection via EXTRACT_TEXT message
 * 2. Network direct fetch (fetchHtmlWithCharset) followed by SW-compatible HTML extractor (extractPagePayloadFromHtml)
 * 3. On network failure, extract from archived page stored in IndexedDB (db.archivedPages)
 * 4. Even if all body text extraction fails, always returns payload preserving title and url
 */
export async function buildPagePayload(bookmark: Bookmark): Promise<ExtractedPagePayload> {
  let contentText = (bookmark.description || '').trim();
  let pageTitle = bookmark.title || '';
  let metaDesc = '';

  if (!contentText || contentText.length < 50) {
    // 1. Check for open tab and attempt highest-priority extraction via EXTRACT_TEXT
    try {
      if (typeof browser !== 'undefined' && browser.tabs?.query && browser.tabs?.sendMessage) {
        const matchingTabs = await browser.tabs.query({ url: bookmark.url });
        const activeTab = matchingTabs?.find((t) => t.id && !t.discarded) || matchingTabs?.[0];
        if (activeTab?.id) {
          const tabPromise = browser.tabs.sendMessage(activeTab.id, { type: 'EXTRACT_TEXT' });
          const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 1500));
          const res = (await Promise.race([tabPromise, timeoutPromise])) as any;
          if (res && (res.textContent || res.content)) {
            const extractedText = ((res.textContent || res.content || '') as string).trim().slice(0, 3000);
            return {
              title: res.title || pageTitle,
              url: bookmark.url,
              metaDescription: res.metaDescription || '',
              content: extractedText,
              textContent: extractedText
            };
          }
        }
      }
    } catch (tabErr) {
      // On open tab query/message failure, proceed with direct fetch
    }

    // 2. Direct network fetch followed by SW-compatible extractPagePayloadFromHtml parsing
    let html = '';
    try {
      html = await fetchHtmlWithCharset(bookmark.url);
    } catch (fetchErr) {
      // On fetch failure, proceed with archive fallback
    }

    let parsedText = '';
    if (html) {
      try {
        const extracted = extractPagePayloadFromHtml(html, bookmark.url, pageTitle, 3000);
        if (extracted.textContent && extracted.textContent.length >= 50) {
          return extracted;
        }
        pageTitle = extracted.title || pageTitle;
        metaDesc = extracted.metaDescription || '';
        parsedText = extracted.textContent || '';
      } catch (extractErr) {
        // On parsing failure, proceed with archive fallback
      }
    }

    // 3. If fetch failed or body is under 50 chars (SPA, etc.), attempt recovery from saved archive page
    if (bookmark.id !== undefined && (!parsedText || parsedText.length < 50)) {
      try {
        const archived = await db.archivedPages.where('bookmarkId').equals(bookmark.id).first();
        if (archived?.htmlBlob) {
          const plainBlob = await decompressArchiveHtml(archived.htmlBlob);
          const archHtml = await plainBlob.text();
          const extracted = extractPagePayloadFromHtml(archHtml, bookmark.url, pageTitle, 3000);
          if (extracted.textContent) {
            return extracted;
          }
        }
      } catch (archErr) {
        // Fallback to basic payload on archive lookup failure
      }
    }

    contentText = parsedText || contentText;
  }

  return {
    title: pageTitle || bookmark.title,
    url: bookmark.url,
    metaDescription: metaDesc,
    content: contentText.slice(0, 3000),
    textContent: contentText.slice(0, 3000)
  };
}

export interface BulkAnalyzeResult {
  successCount: number;
  failCount: number;
}

/**
 * Bulk AI folder categorization — updates tags and folders (directories) only per bookmark without touching summary.
 * (Summaries are handled separately by 'Bulk AI Summarize' feature)
 */
export async function runBulkCategorize(
  bookmarkIds: number[],
  folders: FolderInfo[] = [],
  signal?: AbortSignal,
  onProgress?: (progress: BulkProgress) => void
): Promise<BulkAnalyzeResult> {
  let progress: BulkProgress = {
    kind: 'categorize',
    total: bookmarkIds.length,
    done: 0,
    status: 'running',
    at: Date.now()
  };
  let successCount = 0;
  let failCount = 0;

  if (!(await isAiConfigured())) {
    return { successCount: 0, failCount: 0 };
  }

  // Notify page immediately on start for instant loading display (ensures progress is visible even if first AI request is slow)
  await saveProgress(progress);
  await notifyManagementPage();

  const crossRootReviewList: any[] = [];

  for (const id of bookmarkIds) {
    if (signal?.aborted) break;
    const bookmark = await db.bookmarks.get(id);
    if (!bookmark) { progress.done++; await saveProgress(progress); continue; }

    // State for in-progress card display (saved to DB — restored on page reload)
    await BookmarkManager.updateBookmark(id, { aiStatus: 'running' });
    // Notify page of running transition for this bookmark so card spinner is visible immediately
    await notifyManagementPage();

    try {
      const pagePayload = await buildPagePayload(bookmark);
      const result = await analyzeContent(pagePayload, folders, signal);

      // Resolve AI recommended folder to actual browser folder
      const folderCandidate = (result.suggestedFolderName && result.suggestedFolderName.trim())
        ? result.suggestedFolderName.trim()
        : (result.category && !isGenericCategory(result.category) ? result.category : '');

      const resolved = await resolveSuggestedFolderWithRoot(
        result.suggestedFolderId,
        folderCandidate,
        folders,
        bookmark.folderPath
      );

      if (resolved.action === 'same-root' && resolved.targetFolder) {
        const targetFolderId = resolved.targetFolder.id;
        const targetFolderPath = resolved.targetFolder.path;

        if (targetFolderId && bookmark.bookmarkId && typeof browser !== 'undefined' && browser.bookmarks?.move) {
          try {
            await browser.bookmarks.move(bookmark.bookmarkId, { parentId: targetFolderId });
          } catch (moveErr) {
            console.error(`Failed to move bookmark ${bookmark.id} to folder ${targetFolderId}:`, moveErr);
          }
        }

        const updatePayload: Partial<Bookmark> = {
          tags: result.tags || [],
          folderPath: targetFolderPath,
          aiStatus: 'done'
        };
        await BookmarkManager.updateBookmark(id, updatePayload);
      } else if (resolved.action === 'create-new') {
        let targetFolderId: string | null = null;
        let targetFolderPath: string | undefined = undefined;

        if (folderCandidate) {
          try {
            const created = await BookmarkManager.ensureFolderPath(folderCandidate, resolved.currentRoot);
            if (created) {
              targetFolderId = created.id;
              targetFolderPath = created.path;
              // Refresh folder list in case new folder was created so subsequent targets can match it
              folders = await BookmarkManager.getFolders();

              if (targetFolderId && bookmark.bookmarkId && typeof browser !== 'undefined' && browser.bookmarks?.move) {
                try {
                  await browser.bookmarks.move(bookmark.bookmarkId, { parentId: targetFolderId });
                } catch (moveErr) {
                  console.error(`Failed to move bookmark ${bookmark.id} to folder ${targetFolderId}:`, moveErr);
                }
              }
            }
          } catch (createErr) {
            console.error(`Failed to create folder ${folderCandidate}:`, createErr);
          }
        }

        const updatePayload: Partial<Bookmark> = {
          tags: result.tags || [],
          ...(targetFolderPath ? { folderPath: targetFolderPath } : {}),
          aiStatus: 'done'
        };
        await BookmarkManager.updateBookmark(id, updatePayload);
      } else if (resolved.action === 'cross-root') {
        // DO NOT move folder immediately. Update tags, set crossRootReview, push to crossRootReviewList
        const crossRootReview: CrossRootReviewData = {
          suggestedFolderId: resolved.targetFolder?.id,
          suggestedFolderName: folderCandidate,
          suggestedRoot: resolved.targetRoot,
          cleanPath: resolved.cleanPath
        };

        const reviewItem = {
          id,
          bookmarkId: bookmark.bookmarkId,
          title: bookmark.title,
          url: bookmark.url,
          currentRoot: resolved.currentRoot,
          suggestedFolderId: resolved.targetFolder?.id,
          suggestedFolderName: folderCandidate,
          suggestedRoot: resolved.targetRoot,
          cleanPath: resolved.cleanPath
        };
        crossRootReviewList.push(reviewItem);

        const updatePayload: Partial<Bookmark> = {
          tags: result.tags || [],
          crossRootReview,
          aiStatus: 'done'
        };
        await BookmarkManager.updateBookmark(id, updatePayload);
      }

      successCount++;
    } catch (err: any) {
      if (signal?.aborted) {
        await BookmarkManager.updateBookmark(id, { aiStatus: 'none' });
        break;
      }
      console.error(`AI categorization failed for bookmark ${bookmark.id}:`, err);
      await BookmarkManager.updateBookmark(id, { aiStatus: 'error' });
      failCount++;
    }

    progress.done++;
    progress.at = Date.now();
    await saveProgress(progress);
    onProgress?.(progress);
    await notifyManagementPage();
  }

  if (crossRootReviewList.length > 0) {
    try {
      if (typeof browser !== 'undefined' && browser.storage?.local) {
        await browser.storage.local.set({ ai_bulk_cross_root_review: crossRootReviewList });
      }
    } catch (e) {
      console.warn('Failed to persist cross root review list:', e);
    }
    await notifyManagementPage();
  }

  progress.status = signal?.aborted ? 'error' : 'done';
  progress.at = Date.now();
  await saveProgress(progress);

  return { successCount, failCount };
}

/**
 * Bulk AI description summarization — updates only description per bookmark (tags/folders untouched).
 */
export async function runBulkSummarize(
  bookmarkIds: number[],
  folders: FolderInfo[] = [],
  signal?: AbortSignal,
  onProgress?: (progress: BulkProgress) => void
): Promise<BulkAnalyzeResult> {
  let progress: BulkProgress = {
    kind: 'summarize',
    total: bookmarkIds.length,
    done: 0,
    status: 'running',
    at: Date.now()
  };
  let successCount = 0;
  let failCount = 0;

  if (!(await isAiConfigured())) {
    return { successCount: 0, failCount: 0 };
  }

  // Notify page immediately on start for instant loading display
  await saveProgress(progress);
  await notifyManagementPage();

  for (const id of bookmarkIds) {
    if (signal?.aborted) break;
    const bookmark = await db.bookmarks.get(id);
    if (!bookmark) { progress.done++; await saveProgress(progress); continue; }

    await BookmarkManager.updateBookmark(id, { aiStatus: 'running' });
    // Notify page of running transition for this bookmark so card spinner is visible immediately
    await notifyManagementPage();

    try {
      const pagePayload = await buildPagePayload(bookmark);
      const result = await analyzeContent(pagePayload, folders, signal);

      if (result.summary && !isNoBodyText(result.summary)) {
        await BookmarkManager.updateBookmark(id, { description: result.summary, aiStatus: 'done' });
        successCount++;
      } else {
        console.warn(`[ai-bulk-analyzer] AI summarization failed (no body text extracted): ${bookmark.title}`);
        await BookmarkManager.updateBookmark(id, { aiStatus: 'done' });
        failCount++;
      }
    } catch (err: any) {
      if (signal?.aborted) {
        await BookmarkManager.updateBookmark(id, { aiStatus: 'none' });
        break;
      }
      console.error(`AI summarization failed for bookmark ${bookmark.id}:`, err);
      await BookmarkManager.updateBookmark(id, { aiStatus: 'error' });
      failCount++;
    }

    progress.done++;
    progress.at = Date.now();
    await saveProgress(progress);
    onProgress?.(progress);
    await notifyManagementPage();
  }

  progress.status = signal?.aborted ? 'error' : 'done';
  progress.at = Date.now();
  await saveProgress(progress);

  return { successCount, failCount };
}
