import { analyzeContent, isAiConfigured } from './ai-summarizer';
import { BookmarkManager, resolveSuggestedFolderWithRoot } from '../bookmarks/bookmark-manager';
import { getRootFolderName } from '../bookmarks/folder-utils';
import { buildPagePayload } from './ai-bulk-analyzer';
import db, { type Bookmark, type CrossRootReviewData } from '../db';
import { isPermanentAiError } from './llama-safety';
import type { AiJob, AiJobKind } from './queue-types';
import { isNoBodyText, isGenericCategory, type AiAnalysisResult, type FolderInfo } from './types';

export interface ProcessOutcome {
  ok: boolean; // true: done / skip
  aborted?: boolean; // User cancellation
  skipped?: boolean; // Insufficient body text (summary placeholder) — treated as done, but counted in failCount
  error?: string;
  retryable?: boolean; // false: Permanent error (token soup, etc.) — retrying is meaningless, finalize as error without exhausting attempts
  crossRootReview?: CrossRootReviewData; // For batch list collection in categorize (bulk)
}

/**
 * Update notification for management page (BookmarkList) storage.onChanged listener (shared).
 * - Success: ai_analysis_last_update (triggers card re-query)
 * - Failure: ai_analysis_error (informs user of error via toast)
 * Harmlessly ignored in test/Node environments without browser global.
 */
export async function notifyManagementPage(info: { ok: boolean; bookmarkId?: number; error?: string }): Promise<void> {
  try {
    if (typeof browser !== 'undefined' && browser.storage?.local) {
      if (info.ok) {
        await browser.storage.local.set({ 'ai_analysis_last_update': Date.now() });
      } else {
        await browser.storage.local.set({
          'ai_analysis_error': { bookmarkId: info.bookmarkId, error: info.error, at: Date.now() }
        });
      }
    }
  } catch (e) {
    console.warn('Failed to notify management page of AI analysis update:', e);
  }
}

/**
 * Single bookmark AI processing — invoked by drain loop of unified queue (ai-queue).
 * Both entry points (auto-apply auto / bulk categorize/summarize) share the same processing path.
 *
 * AI core (analyzeContent) and commit (BookmarkManager.updateBookmark) are unchanged.
 * Since the queue (ai-queue) handles state transitions, this module does not directly mutate job status.
 */
export async function processAiJob(job: AiJob, signal: AbortSignal): Promise<ProcessOutcome> {
  const { bookmarkId, kind, options } = job;

  // Double defense: already checked in enqueue, but skips on direct call (legacy/recovery) without notification
  if (!(await isAiConfigured())) {
    return { ok: true };
  }
  const bookmark = await db.bookmarks.get(bookmarkId);
  if (!bookmark) {
    return { ok: true }; // Skip deleted bookmark
  }

  // Immediately show in-progress card spinner
  await BookmarkManager.updateBookmark(bookmarkId, { aiStatus: 'running' });
  await notifyManagementPage({ ok: true });

  try {
    // Unified payload: popup passed payload prioritized, falls back to buildPagePayload on insufficient body
    let finalPayload = job.payload;
    if (!finalPayload || (!finalPayload.textContent && !finalPayload.content)) {
      finalPayload = await buildPagePayload(bookmark);
    }

    // Freshly load folders (eliminates staleness from earlier job folder creations)
    const freshFolders = await BookmarkManager.getFolders().catch(() => null);
    const folders = (freshFolders && freshFolders.length > 0) ? freshFolders : (job.folders ?? []);
    const currentRoot = getRootFolderName(bookmark.folderPath, folders);

    const taskKind = kind === 'summarize' ? 'summary' : kind === 'categorize' ? 'folder' : 'full';
    const result = await analyzeContent(finalPayload, folders, signal, taskKind, currentRoot);

    // Check if bookmark was deleted/aborted after analysis completion (race condition defense)
    if (signal.aborted || !(await db.bookmarks.get(bookmarkId))) {
      return { ok: false, aborted: true };
    }

    const crossRootReview = await commitByKind(bookmarkId, kind, options, result, bookmark, folders);

    if (!(await db.bookmarks.get(bookmarkId))) {
      return { ok: false, aborted: true };
    }

    await BookmarkManager.updateBookmark(bookmarkId, { aiStatus: 'done' });
    await notifyManagementPage({ ok: true });
    return {
      ok: true,
      skipped: (kind === 'summarize' && isNoBodyText(result.summary)) || undefined,
      ...(crossRootReview ? { crossRootReview } : {})
    };
  } catch (err: any) {
    const isBookmarkDeleted = !(await db.bookmarks.get(bookmarkId));
    if (signal.aborted || err?.name === 'AbortError' || isBookmarkDeleted) {
      // User cancellation or bookmark deleted: exit without error badge/toast
      if (!isBookmarkDeleted) {
        await BookmarkManager.updateBookmark(bookmarkId, { aiStatus: 'none' });
        await notifyManagementPage({ ok: true });
      }
      return { ok: false, aborted: true };
    }
    const errMsg = err?.message || String(err);
    // Permanent error (token soup, etc.) has retryable=false — pass so queue immediately finalizes error without exhausting attempts
    const retryable = !isPermanentAiError(err);
    // Failure: reflect error state (bookmark itself maintains saved state)
    await BookmarkManager.updateBookmark(bookmarkId, { aiStatus: 'error' });
    await notifyManagementPage({ ok: false, bookmarkId, error: errMsg });
    return { ok: false, error: errMsg, retryable };
  }
}

/**
 * Commit by kind: auto is options-gated, categorize commits tags+folder (does not touch description),
 * summarize commits description only. Returns skipped=true on insufficient body (placeholder) for summarize.
 * If crossRootReview is generated, returns it so queue can collect the batch list.
 */
async function commitByKind(
  bookmarkId: number,
  kind: AiJobKind,
  options: AiJob['options'],
  result: AiAnalysisResult,
  bookmark: Bookmark,
  folders: FolderInfo[]
): Promise<CrossRootReviewData | undefined> {
  const hasBody = !isNoBodyText(result.summary);
  const commit: Partial<Bookmark> = {};

  if (kind === 'auto') {
    if (options?.autoSummarize !== false && hasBody) commit.description = result.summary;
    if (options?.autoTags !== false) commit.tags = result.tags || [];
    // If body text is insufficient, do not touch folder move/creation
    if (options?.autoFolder !== false && hasBody) {
      await applyFolder(bookmarkId, result, folders, bookmark, commit);
    }
    if (Object.keys(commit).length) await BookmarkManager.updateBookmark(bookmarkId, commit);
    return undefined;
  }

  if (kind === 'categorize') {
    // Update tags with AI-generated tags (replace with fresh tags generated by AI)
    if (Array.isArray(result.tags) && result.tags.length > 0) {
      commit.tags = result.tags;
    }
    const crr = await applyFolder(bookmarkId, result, folders, bookmark, commit);
    await BookmarkManager.updateBookmark(bookmarkId, commit);
    return crr;
  }

  // summarize — description only (tags/folder unchanged)
  if (hasBody) {
    await BookmarkManager.updateBookmark(bookmarkId, { description: result.summary });
  }
  return undefined;
}

/**
 * Resolves AI recommended folder to actual browser folder, moves/creates, and reflects folderPath or crossRootReview in commit.
 * If cross-root, saves crossRootReview without moving folder immediately.
 */
async function applyFolder(
  bookmarkId: number,
  result: AiAnalysisResult,
  folders: FolderInfo[],
  bookmark: Bookmark,
  commit: Partial<Bookmark>
): Promise<CrossRootReviewData | undefined> {
  const folderCandidate = (result.suggestedFolderName?.trim())
    || (result.category && !isGenericCategory(result.category) ? result.category : '');

  const resolved = await resolveSuggestedFolderWithRoot(
    result.suggestedFolderId,
    folderCandidate,
    folders,
    bookmark?.folderPath
  );

  if (resolved.action === 'same-root' && resolved.targetFolder) {
    const canMove = bookmark?.bookmarkId && typeof browser !== 'undefined' && browser.bookmarks?.move;
    if (canMove) {
      try {
        await browser.bookmarks.move(bookmark.bookmarkId, { parentId: resolved.targetFolder.id });
        // Only record folderPath on successful move -> maintain consistency between DB and actual browser location
        commit.folderPath = resolved.targetFolder.path;
      } catch (moveErr) {
        console.error(`Failed to move bookmark ${bookmarkId} to folder ${resolved.targetFolder.id}:`, moveErr);
      }
    } else {
      // Record based on DB for environments without browser move support (Node tests)
      commit.folderPath = resolved.targetFolder.path;
    }
  } else if (resolved.action === 'create-new' && folderCandidate) {
    try {
      const created = await BookmarkManager.ensureFolderPath(folderCandidate, resolved.currentRoot);
      if (created) {
        const canMove = bookmark?.bookmarkId && typeof browser !== 'undefined' && browser.bookmarks?.move;
        if (canMove) {
          try {
            await browser.bookmarks.move(bookmark.bookmarkId, { parentId: created.id });
            // Only record folderPath on successful move
            commit.folderPath = created.path;
          } catch (moveErr) {
            console.error(`Failed to move bookmark ${bookmarkId} to folder ${created.id}:`, moveErr);
          }
        } else {
          // Record based on DB for environments without browser move support (Node tests)
          commit.folderPath = created.path;
        }
      }
    } catch (createErr) {
      console.error(`Failed to create folder ${folderCandidate}:`, createErr);
    }
  } else if (resolved.action === 'cross-root') {
    // DO NOT move folder immediately. Save crossRootReview on DB bookmark
    const crossRootReview: CrossRootReviewData = {
      suggestedFolderId: resolved.targetFolder?.id,
      suggestedFolderName: folderCandidate,
      suggestedRoot: resolved.targetRoot,
      cleanPath: resolved.cleanPath
    };
    commit.crossRootReview = crossRootReview;
    return crossRootReview;
  }
  return undefined;
}
