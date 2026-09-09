import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tick } from 'svelte';

// ─────────────────────────────────────────────────────────────────────────────
// Archive capture "prevent refresh/navigation cancellation" regression test (QA perspective)
//
// Target changes: lib/archive-capture-state.ts + BookmarkList.svelte
//  - split saveArchive -> performArchiveCapture (core) / runArchiveCapture (marker + guard + notification) /
//    resumeArchiveCapture (resume)
//  - write progress marker (archive_capture_state) to storage.local -> auto-resume on re-entry
//  - single-flight (ignore duplicate requests) / error notification on failure (notifyArchiveCaptureError)
//
// ⚠️ jsdom pitfall: BookmarkList's onMount does not fire in this harness (measured —
//   0 calls to storage.onChanged.addListener / loadBookmarks). Therefore, onMount's
//   "auto-resume (resumeArchiveCapture)" path cannot be verified in jsdom, and
//   auto-resume after reload is explicitly noted in the report as target for real browser (CDP) verification.
//   This file verifies orchestration testable without onMount (marker lifecycle, single-flight,
//   failure handling, cross-context single-flight) via actual "Archive" button clicks in DOM.
//
// Stub storage.local as an in-memory store that persists beyond component lifecycle,
// mimicking actual storage.local contract.
// ─────────────────────────────────────────────────────────────────────────────

const { mockData, dbMock, mockIsAiConfigured, archiveBookmark, fetchHtmlWithCharset, showToast, storageStore } = vi.hoisted(() => {
  const data = { bookmarks: [] as any[], archivedPages: [] as any[] };
  const storageStore: Record<string, any> = {};

  const db = {
    bookmarks: {
      toArray: vi.fn(async () => data.bookmarks),
      get: vi.fn(async (id: number) => data.bookmarks.find(b => b.id === id)),
      update: vi.fn(async () => {}),
      where: vi.fn(() => ({ equals: vi.fn(() => ({ first: async () => undefined, delete: async () => {} })) })),
      filter: vi.fn(() => ({ modify: vi.fn(async () => {}) })),
      delete: vi.fn(async () => {})
    },
    archivedPages: {
      toArray: vi.fn(async () => data.archivedPages),
      where: vi.fn(() => ({ equals: vi.fn(() => ({ delete: async () => {} })) }))
    },
    settings: {
      get: vi.fn(async () => undefined)
    }
  };

  return {
    mockData: data,
    dbMock: db,
    mockIsAiConfigured: vi.fn(async () => false),
    archiveBookmark: vi.fn(),
    fetchHtmlWithCharset: vi.fn(),
    showToast: vi.fn(),
    storageStore
  };
});

vi.mock('../../src/lib/db', () => ({ db: dbMock, default: dbMock }));
vi.mock('../../src/lib/ai/ai-summarizer', () => ({
  isAiConfigured: mockIsAiConfigured,
  analyzeContent: vi.fn(async () => ({ summary: '', category: '', suggestedFolderId: null, suggestedFolderName: '', isNewFolderRecommended: false, tags: [], confidence: 0 }))
}));
vi.mock('../../src/lib/ui/toast-store', () => ({ showToast }));
// Keep core capture logic real while stubbing archiveBookmark for controllability
vi.mock('../../src/lib/archive/page-capture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/archive/page-capture')>();
  return { ...actual, archiveBookmark };
});
vi.mock('../../src/lib/archive/fetch-with-charset', () => ({ fetchHtmlWithCharset }));

vi.stubGlobal('browser', {
  i18n: { getMessage: vi.fn((key: string) => key) },
  runtime: { sendMessage: vi.fn(async () => ({ ok: true })) },
  storage: {
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    },
    local: {
      get: vi.fn(async (key: string | string[]) => {
        if (Array.isArray(key)) return Object.fromEntries(key.map(k => [k, storageStore[k]]));
        return { [key]: storageStore[key] };
      }),
      set: vi.fn(async (obj: Record<string, any>) => { Object.assign(storageStore, obj); }),
      remove: vi.fn(async (key: string) => { delete storageStore[key]; })
    }
  },
  bookmarks: {
    getTree: vi.fn(async () => [{ id: '0', title: 'root', children: [] }]),
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() },
    onMoved: { addListener: vi.fn() }
  },
  tabs: {
    query: vi.fn(async () => []) // No open tabs -> proceed with fetch path
  }
});

import BookmarkList from '../../src/components/management/BookmarkList.svelte';

const flush = () => new Promise<void>(r => setTimeout(r, 0));
function makeDeferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
function makeBookmark(id: number) {
  return { id, title: `Item ${id}`, url: `https://example.com/${id}`, folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: `b${id}` };
}
/** Click archive (save) button — trigger capture via actual user path */
function archiveButton(): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('.card-actions button')).find(
    b => b.textContent?.includes('아카이브') && !b.textContent?.includes('보기')
  ) as HTMLButtonElement | undefined;
  expect(btn).toBeTruthy();
  return btn!;
}

describe('아카이브 캡처 새로고침/이탈 취소 방지 회귀 테스트', () => {
  let target: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
    mockData.bookmarks = [];
    mockData.archivedPages = [];
    Object.keys(storageStore).forEach(k => delete storageStore[k]);
    archiveBookmark.mockReset();
    fetchHtmlWithCharset.mockReset();
    showToast.mockReset();
    mockIsAiConfigured.mockResolvedValue(false);
  });

  afterEach(() => {
    // Note: browser stub is installed only once at module top level. Calling unstubAllGlobals
    // here removes browser from 2nd test onward, making archive-capture-state a no-op.
    vi.restoreAllMocks();
  });

  // When capture is in progress, progress marker is recorded, and cleaned up after completion (success).
  //  -> Premise that re-entry right after refresh / right before completion can be identified by marker (core invariant).
  it('아카이브 실행 직후: 진행 마커가 기록되고, 완료 후 정리된다', async () => {
    mockData.bookmarks = [makeBookmark(5)];
    fetchHtmlWithCharset.mockResolvedValue('<html>arch</html>');
    const deferred = makeDeferred<string>();
    archiveBookmark.mockImplementation(async () => { await deferred.promise; });

    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await flush(); await tick();

    const btn = archiveButton();
    btn.click();                       // Start capture
    await flush(); await tick();

    // While capture is running, progress marker must be recorded in storage.local (resume premise)
    expect(storageStore['archive_capture_state']).toBeDefined();
    expect(storageStore['archive_capture_state'].bookmarkId).toBe(5);

    deferred.resolve('ok');
    await flush(); await tick();
    // Clean up marker after normal completion -> no duplicate resume on re-entry
    expect(storageStore['archive_capture_state']).toBeUndefined();

    comp.$destroy();
  });

  // Refresh right before completion: marker cleaned up even on failure, preventing infinite retries on re-entry.
  it('아카이브 실패(완료 직전 새로고침 대응): 마커가 정리되고 에러 토스트/통지가 남는다', async () => {
    mockData.bookmarks = [makeBookmark(6)];
    fetchHtmlWithCharset.mockRejectedValue(new Error('net err')); // fetch failure -> no html -> capture fails

    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await flush(); await tick();

    archiveButton().click();
    await flush(); await tick();

    // Display error toast
    expect(showToast.mock.calls.some(c => c[0].includes('저장 실패'))).toBe(true);
    // Record cross-page error notification (notifyArchiveCaptureError)
    expect(storageStore['archive_capture_error']).toBeDefined();
    expect(storageStore['archive_capture_error'].bookmarkId).toBe(6);
    expect(storageStore['archive_capture_error'].error).toContain('페이지 HTML');
    // Marker cleaned up even after failure -> no auto-resume (infinite retry) on re-entry
    expect(storageStore['archive_capture_state']).toBeUndefined();

    comp.$destroy();
  });

  // Duplicate clicks (single-flight): button changes to "Saving..." (disabled) while running,
  // preventing 2nd capture execution -> capture performed only once.
  it('중복 클릭: 진행 중이면 저장 중 버튼으로 바뀌어 캡처를 1회만 실행한다', async () => {
    mockData.bookmarks = [makeBookmark(7)];
    fetchHtmlWithCharset.mockResolvedValue('<html>arch</html>');
    const deferred = makeDeferred<void>();
    archiveBookmark.mockImplementation(async () => { await deferred.promise; });

    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await flush(); await tick();

    archiveButton().click();
    await flush(); await tick(); // Set savingId + capture in-flight

    // single-flight UI: replaced with saving button (disabled) -> user cannot re-archive
    const savingBtn = Array.from(document.querySelectorAll('.card-actions button')).find(
      b => b.textContent?.includes('저장 중')
    ) as HTMLButtonElement | undefined;
    expect(savingBtn).toBeTruthy();
    expect(savingBtn!.disabled).toBe(true);
    // "Archive" button is not rendered while in progress
    expect(Array.from(document.querySelectorAll('.card-actions button')).some(b => b.textContent?.includes('아카이브') && !b.textContent?.includes('보기'))).toBe(false);
    expect(archiveBookmark).toHaveBeenCalledTimes(1);

    deferred.resolve();
    await flush(); await tick();
    expect(storageStore['archive_capture_state']).toBeUndefined();

    comp.$destroy();
  });

  // Cross-context single-flight (T4): if another page is in progress (fresh marker),
  // archive request on this page is ignored and only info toast is displayed.
  it('다른 페이지 진행 중(신선한 마커): 이 페이지의 아카이브 요청을 무시하고 안내 토스트를 표시한다', async () => {
    mockData.bookmarks = [makeBookmark(8)];
    fetchHtmlWithCharset.mockResolvedValue('<html>arch</html>');
    archiveBookmark.mockResolvedValue(undefined);
    // Pre-seed fresh marker indicating another context is in progress
    storageStore['archive_capture_state'] = { bookmarkId: 99, startedAt: Date.now() };

    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await flush(); await tick();

    archiveButton().click();
    await flush(); await tick();

    // Fresh marker exists -> no new capture execution + info toast
    expect(archiveBookmark).not.toHaveBeenCalled();
    expect(showToast.mock.calls.some(c => c[0].includes('다른 아카이브가 진행 중입니다'))).toBe(true);

    comp.$destroy();
  });

  // Normal refresh/back: do not leave marker if no archive is in progress.
  it('일반 새로고침(진행 중 아카이브 없음): 자동 캡처·마커가 없다', async () => {
    mockData.bookmarks = [makeBookmark(9)];
    fetchHtmlWithCharset.mockResolvedValue('<html>arch</html>');
    archiveBookmark.mockResolvedValue(undefined);

    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await flush(); await tick();

    expect(archiveBookmark).not.toHaveBeenCalled();
    expect(storageStore['archive_capture_state']).toBeUndefined();

    comp.$destroy();
  });

  // When new capture is manually executed with no marker after successful save, it runs once normally.
  it('정상 완료 후 재아카이브: 마커가 없어 새 캡처를 1회 수행한다', async () => {
    mockData.bookmarks = [makeBookmark(10)];
    fetchHtmlWithCharset.mockResolvedValue('<html>arch</html>');
    archiveBookmark.mockResolvedValue(undefined);

    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await flush(); await tick();

    archiveButton().click();
    await flush(); await tick();

    expect(archiveBookmark).toHaveBeenCalledTimes(1);
    expect(storageStore['archive_capture_state']).toBeUndefined();

    comp.$destroy();
  });

  // ── Ownership clear fix verification ──────────────────────────────────────────────
  // reviewer t_a08a10b9 Finding 2 (major): single-flight clear did not check ownership.
  // If two management pages archive different bookmarks, they overwrite the same single marker,
  // and clearArchiveCaptureState() in finally of the first to finish removes the peer's in-progress marker
  // -> quietly lost if peer refreshes (the exact bug this feature aimed to prevent).
  // Spec: clear must only execute when matching its own bookmarkId.
  it('다른 페이지가 진행 마커를 덮어쓴 뒤 내 캡처가 끝나면 상대 마커가 유지된다 (소유권 clear 수정 검증)', async () => {
    mockData.bookmarks = [makeBookmark(5)];
    fetchHtmlWithCharset.mockResolvedValue('<html>arch</html>');
    const deferred = makeDeferred<string>();
    archiveBookmark.mockImplementation(async () => { await deferred.promise; });

    const comp: any = new BookmarkList({ target, props: { folders: [] } });
    await comp.loadBookmarks();
    await flush(); await tick();

    archiveButton().click();            // Start my (A) capture -> marker = {bookmarkId:5}
    await flush(); await tick();
    expect(storageStore['archive_capture_state'].bookmarkId).toBe(5);

    // B (another management page) overwrites same single marker with its own (concurrent progress)
    storageStore['archive_capture_state'] = { bookmarkId: 99, startedAt: Date.now() };

    deferred.resolve('ok');             // A capture finishes -> A finally executes clear
    await flush(); await tick();

    // Spec: even when A finishes, B (99) is still running so marker must remain.
    // Actual (bug): A's clearArchiveCaptureState() removed ignoring ownership -> undefined
    expect(storageStore['archive_capture_state']).toBeDefined();

    comp.$destroy();
  });
});
