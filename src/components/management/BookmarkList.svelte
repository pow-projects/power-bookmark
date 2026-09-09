<script lang="ts">
  import BookmarkList from './bookmarks/BookmarkList.svelte';
  import type { FolderNode } from '../../lib/bookmarks/bookmark-manager';

  export let folders: FolderNode[] = [];
  let bookmarkListEl: BookmarkList;

  export async function loadBookmarks() {
    if (bookmarkListEl) {
      await bookmarkListEl.loadBookmarks();
    }
  }

  export async function handleBulkAiCategorize() {
    if (bookmarkListEl) {
      await bookmarkListEl.handleBulkAiCategorize();
    }
  }

  export async function handleBulkAiSummarize() {
    if (bookmarkListEl) {
      await bookmarkListEl.handleBulkAiSummarize();
    }
  }

  export async function deleteArchive(id: number) {
    if (bookmarkListEl) {
      await bookmarkListEl.deleteArchive(id);
    }
  }
</script>

<BookmarkList bind:this={bookmarkListEl} {folders} />
