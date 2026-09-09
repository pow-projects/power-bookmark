<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import db, { type Bookmark } from '../../../lib/db';
  import { BookmarkManager, type FolderNode, normalizeFolderPath } from '../../../lib/bookmarks/bookmark-manager';
  import { showToast } from '../../../lib/ui/toast-store';
  import CrossRootBanner from './CrossRootBanner.svelte';
  import CrossRootFolderModal, { type CrossRootItem } from '../CrossRootFolderModal.svelte';

  export let bookmarks: Bookmark[] = [];
  export let folders: FolderNode[] = [];

  const dispatch = createEventDispatcher<{
    updated: { processedCount: number };
  }>();

  let crossRootModalOpen = false;
  let crossRootReviewItems: CrossRootItem[] = [];

  $: pendingCrossRootBookmarks = bookmarks.filter((b) => b.crossRootReview);
  $: totalPendingCrossRoot = crossRootReviewItems.length > 0 ? crossRootReviewItems.length : pendingCrossRootBookmarks.length;

  export async function sync(autoOpen = false, overrideItems?: any[]) {
    const itemsMap = new Map<number, CrossRootItem>();
    for (const b of bookmarks) {
      if (b.crossRootReview && b.id !== undefined) {
        itemsMap.set(b.id, {
          bookmarkId: b.id,
          browserBookmarkId: b.bookmarkId,
          title: b.title,
          url: b.url,
          currentFolderPath: b.crossRootReview.currentFolderPath || b.folderPath || '',
          currentRoot: b.crossRootReview.currentRoot || (b.folderPath ? b.folderPath.split('/')[0] : 'Other bookmarks'),
          suggestedFolderId: b.crossRootReview.suggestedFolderId,
          suggestedFolderPath: b.crossRootReview.suggestedFolderPath || b.crossRootReview.suggestedFolderName,
          suggestedFolderName: b.crossRootReview.suggestedFolderName,
          suggestedRoot: b.crossRootReview.suggestedRoot || 'Bookmarks bar',
          cleanPath: b.crossRootReview.cleanPath || normalizeFolderPath(b.crossRootReview.suggestedFolderPath || b.crossRootReview.suggestedFolderName || '')
        });
      }
    }

    try {
      let storedItems = overrideItems;
      if (!storedItems && typeof browser !== 'undefined' && browser.storage?.local) {
        const res = await browser.storage.local.get('ai_bulk_cross_root_review');
        storedItems = res?.['ai_bulk_cross_root_review'] as any[] | undefined;
      }
      if (storedItems && Array.isArray(storedItems)) {
        for (const item of storedItems) {
          const bId = typeof item.id === 'number' ? item.id : (typeof item.bookmarkId === 'number' ? item.bookmarkId : undefined);
          if (bId !== undefined) {
            const matchedBm = bookmarks.find((b) => b.id === bId);
            itemsMap.set(bId, {
              bookmarkId: bId,
              browserBookmarkId: item.browserBookmarkId || (typeof item.bookmarkId === 'string' ? item.bookmarkId : matchedBm?.bookmarkId),
              title: item.title || matchedBm?.title || '',
              url: item.url || matchedBm?.url || '',
              currentFolderPath: item.currentFolderPath || matchedBm?.folderPath || '',
              currentRoot: item.currentRoot || (matchedBm?.folderPath ? matchedBm.folderPath.split('/')[0] : 'Other bookmarks'),
              suggestedFolderId: item.suggestedFolderId,
              suggestedFolderPath: item.suggestedFolderPath || item.suggestedFolderName,
              suggestedFolderName: item.suggestedFolderName,
              suggestedRoot: item.suggestedRoot || 'Bookmarks bar',
              cleanPath: item.cleanPath || normalizeFolderPath(item.suggestedFolderPath || item.suggestedFolderName || '')
            });
          }
        }
      }
    } catch (e) {}

    crossRootReviewItems = Array.from(itemsMap.values());
    if (autoOpen && crossRootReviewItems.length > 0) {
      crossRootModalOpen = true;
    }
  }

  export function openAll() {
    sync(false);
    crossRootModalOpen = true;
  }

  export function openSingle(bookmark: Bookmark) {
    if (bookmark.crossRootReview && bookmark.id !== undefined) {
      crossRootReviewItems = [{
        bookmarkId: bookmark.id,
        browserBookmarkId: bookmark.bookmarkId,
        title: bookmark.title,
        url: bookmark.url,
        currentFolderPath: bookmark.crossRootReview.currentFolderPath || bookmark.folderPath || '',
        currentRoot: bookmark.crossRootReview.currentRoot || (bookmark.folderPath ? bookmark.folderPath.split('/')[0] : 'Other bookmarks'),
        suggestedFolderId: bookmark.crossRootReview.suggestedFolderId,
        suggestedFolderPath: bookmark.crossRootReview.suggestedFolderPath || bookmark.crossRootReview.suggestedFolderName,
        suggestedFolderName: bookmark.crossRootReview.suggestedFolderName,
        suggestedRoot: bookmark.crossRootReview.suggestedRoot || 'Bookmarks bar',
        cleanPath: bookmark.crossRootReview.cleanPath || normalizeFolderPath(bookmark.crossRootReview.suggestedFolderPath || bookmark.crossRootReview.suggestedFolderName || '')
      }];
    }
    crossRootModalOpen = true;
  }

  async function handleApplyCrossRootReview(
    event: CustomEvent<{
      results: Array<{
        bookmarkId: number;
        action: 'create-here' | 'move-recommended' | 'skip';
        cleanPath: string;
        targetFolderId?: string;
        targetRoot: string;
        currentRoot: string;
      }>;
    }>
  ) {
    const { results } = event.detail;
    if (!results || results.length === 0) {
      crossRootModalOpen = false;
      return;
    }

    let processedCount = 0;
    for (const res of results) {
      const bookmark = await db.bookmarks.get(res.bookmarkId);
      if (!bookmark) continue;

      if (res.action === 'create-here') {
        const folder = await BookmarkManager.ensureFolderPath(res.cleanPath, res.currentRoot);
        if (folder) {
          if (bookmark.bookmarkId && typeof browser !== 'undefined' && browser.bookmarks?.move) {
            try {
              await browser.bookmarks.move(bookmark.bookmarkId, { parentId: folder.id });
            } catch (e) {
              console.error('Failed to move bookmark to new folder in current root:', e);
            }
          }
          await BookmarkManager.updateBookmark(bookmark.id!, {
            folderPath: folder.path,
            crossRootReview: undefined
          });
        } else {
          await BookmarkManager.updateBookmark(bookmark.id!, {
            crossRootReview: undefined
          });
        }
        processedCount++;
      } else if (res.action === 'move-recommended') {
        let targetParentId = res.targetFolderId;
        let targetPath = '';
        if (targetParentId) {
          const f = folders.find(fd => fd.id === targetParentId);
          targetPath = f ? f.path : '';
        } else {
          const folder = await BookmarkManager.ensureFolderPath(res.cleanPath, res.targetRoot);
          if (folder) {
            targetParentId = folder.id;
            targetPath = folder.path;
          }
        }

        if (targetParentId && bookmark.bookmarkId && typeof browser !== 'undefined' && browser.bookmarks?.move) {
          try {
            await browser.bookmarks.move(bookmark.bookmarkId, { parentId: targetParentId });
          } catch (e) {
            console.error('Failed to move bookmark to recommended root:', e);
          }
        }

        await BookmarkManager.updateBookmark(bookmark.id!, {
          folderPath: targetPath || bookmark.folderPath,
          crossRootReview: undefined
        });
        processedCount++;
      } else if (res.action === 'skip') {
        await BookmarkManager.updateBookmark(bookmark.id!, {
          crossRootReview: undefined
        });
        processedCount++;
      }
    }

    try {
      if (typeof browser !== 'undefined' && browser.storage?.local?.remove) {
        await browser.storage.local.remove('ai_bulk_cross_root_review');
      }
    } catch (e) {}

    crossRootReviewItems = [];
    crossRootModalOpen = false;
    showToast(i18n.t('folders.crossRootBatchApplied', { count: processedCount }), 'success');
    dispatch('updated', { processedCount });
  }

  function handleStorageChanged(changes: any, area: string) {
    if (area === 'local' && changes['ai_bulk_cross_root_review']) {
      const newVal = changes['ai_bulk_cross_root_review'].newValue;
      if (newVal && Array.isArray(newVal) && newVal.length > 0) {
        sync(true, newVal);
        dispatch('updated', { processedCount: 0 });
      } else {
        sync(false);
      }
    }
  }

  onMount(() => {
    if (typeof browser !== 'undefined' && browser.storage?.onChanged) {
      browser.storage.onChanged.addListener(handleStorageChanged);
    }
  });

  onDestroy(() => {
    if (typeof browser !== 'undefined' && browser.storage?.onChanged) {
      browser.storage.onChanged.removeListener(handleStorageChanged);
    }
  });
</script>

<CrossRootBanner
  count={totalPendingCrossRoot}
  on:review={openAll}
/>

<CrossRootFolderModal
  isOpen={crossRootModalOpen}
  items={crossRootReviewItems}
  on:apply={handleApplyCrossRootReview}
  on:close={() => { crossRootModalOpen = false; }}
/>
