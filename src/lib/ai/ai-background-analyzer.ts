import { analyzeContent, isAiConfigured } from './ai-summarizer';
import { BookmarkManager, resolveSuggestedFolder, resolveSuggestedFolderWithRoot } from '../bookmarks/bookmark-manager';
import db, { type Bookmark, type CrossRootReviewData } from '../db';
import { isNoBodyText, isGenericCategory, type ExtractedPagePayload, type FolderInfo, type AiAnalysisResult } from './types';

export type AiStatus = 'none' | 'pending' | 'running' | 'done' | 'error';

/** Flags for items to be processed by background auto-analysis (if false, leaves the field untouched to preserve existing DB values) */
export interface AiAutoOptions {
  autoSummarize?: boolean;
  autoTags?: boolean;
  autoFolder?: boolean;
}

/**
 * Background AI auto-analysis right after bookmark save — processes summary/tags/folder in a **single combined AI request** per bookmark
 * (rolled back the 3 parallel sub-jobs split on 2026-08-12).
 *
 * - Executes `analyzeContent(payload, folders, signal)` (kind='full') only once -> improved efficiency
 * - State transitions: aiStatus none -> running -> done/error (none on cancel)
 * - If autoFolder is ON, moves/creates actual folder with AI suggestions (suggestedFolderId/suggestedFolderName) + saves folderPath
 * - browser.* APIs are used only for update triggers (storage.local.set) and folder moves (move),
 *   safely skipped in environments without browser globals like Node test environments.
 */
export async function analyzeBookmarkInBackground(
  bookmarkId: number,
  payload: ExtractedPagePayload,
  folders: FolderInfo[] = [],
  options: AiAutoOptions = {},
  signal?: AbortSignal
): Promise<{ ok: boolean; result?: AiAnalysisResult; error?: string }> {
  const autoSummarize = options.autoSummarize ?? true;
  const autoTags = options.autoTags ?? true;
  const autoFolder = options.autoFolder ?? true;

  try {
    // 0. Defense guard for unconfigured AI: prevents pending freeze (-> transitions to none). Does not call notifyManagementPage -> no error toast
    if (!(await isAiConfigured())) {
      try {
        await BookmarkManager.updateBookmark(bookmarkId, { aiStatus: 'none' });
      } catch (dbErr) {
        console.error('Failed to clear aiStatus for not-configured bookmark:', dbErr);
      }
      return { ok: false, error: 'AI is not configured.' };
    }

    // 1. Transition to analysis started state
    await BookmarkManager.updateBookmark(bookmarkId, { aiStatus: 'running' });

    // 2. Single combined AI request (summary + tags + folder all at once)
    let finalPayload = payload;
    if (!finalPayload || (!finalPayload.textContent && !finalPayload.content)) {
      const bookmark = await db.bookmarks.get(bookmarkId);
      if (bookmark) {
        const { buildPagePayload } = await import('./ai-bulk-analyzer');
        finalPayload = await buildPagePayload(bookmark);
      }
    }
    const result = await analyzeContent(finalPayload, folders, signal);

    // 3. Commit only enabled items (if false, omits field -> preserves existing DB values)
    const commit: Partial<Bookmark> = {};

    if (autoSummarize && result.summary && !isNoBodyText(result.summary)) {
      commit.description = result.summary;
    }
    if (autoTags) {
      commit.tags = result.tags || [];
    }
    // If body text is insufficient (summary placeholder), do not touch folder move/creation
    if (autoFolder && !isNoBodyText(result.summary)) {
      const folderCandidate = (result.suggestedFolderName && result.suggestedFolderName.trim())
        ? result.suggestedFolderName.trim()
        : (result.category && !isGenericCategory(result.category) ? result.category : '');
      const bookmark = await db.bookmarks.get(bookmarkId);
      const resolved = await resolveSuggestedFolderWithRoot(
        result.suggestedFolderId,
        folderCandidate,
        folders,
        bookmark?.folderPath
      );

      if (resolved.action === 'cross-root') {
        // DO NOT move folder immediately. Save crossRootReview on DB bookmark
        commit.crossRootReview = {
          suggestedFolderId: resolved.targetFolder?.id,
          suggestedFolderName: folderCandidate,
          suggestedRoot: resolved.targetRoot,
          cleanPath: resolved.cleanPath
        };
      } else if (resolved.action === 'same-root' && resolved.targetFolder) {
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
                commit.folderPath = created.path;
              } catch (moveErr) {
                console.error(`Failed to move bookmark ${bookmarkId} to folder ${created.id}:`, moveErr);
              }
            } else {
              commit.folderPath = created.path;
            }
          }
        } catch (createErr) {
          console.error(`Failed to create folder ${folderCandidate}:`, createErr);
        }
      }
    }

    if (Object.keys(commit).length > 0) {
      await BookmarkManager.updateBookmark(bookmarkId, commit);
    }

    // 4. Transition to done + real-time management page refresh
    await BookmarkManager.updateBookmark(bookmarkId, { aiStatus: 'done' });
    await notifyManagementPage({ ok: true });

    return { ok: true, result };
  } catch (e: any) {
    // User cancellation (hover/click card spinner on management page): revert to none without error badge/toast and refresh page
    if (e?.name === 'AbortError') {
      console.log(`AI background analysis aborted for bookmark ${bookmarkId}`);
      try {
        await BookmarkManager.updateBookmark(bookmarkId, { aiStatus: 'none' });
      } catch (dbErr) {
        console.error('Failed to clear aiStatus on abort:', dbErr);
      }
      await notifyManagementPage({ ok: true });
      return { ok: false, error: 'aborted' };
    }
    // Error log for stack trace
    console.error(`AI background analysis failed for bookmark ${bookmarkId}:`, e);
    const errMsg = e?.message || String(e);
    try {
      // Failure: reflect error state (bookmark itself maintains saved state)
      await BookmarkManager.updateBookmark(bookmarkId, { aiStatus: 'error' });
    } catch (dbErr) {
      console.error('Failed to mark aiStatus=error:', dbErr);
    }
    // Notify management page of failure cause to inform user
    await notifyManagementPage({ ok: false, bookmarkId, error: errMsg });
    return { ok: false, error: errMsg };
  }
}

/**
 * Update notification for management page (BookmarkList) storage.onChanged listener.
 * - Success: ai_analysis_last_update (triggers card re-query)
 * - Failure: ai_analysis_error (informs user of error via toast)
 * Harmlessly ignored in test/Node environments without browser global.
 */
async function notifyManagementPage(info: { ok: boolean; bookmarkId?: number; error?: string }): Promise<void> {
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
