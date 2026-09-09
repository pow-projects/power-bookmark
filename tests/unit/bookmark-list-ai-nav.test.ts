import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tick } from 'svelte';

/**
 * Regression tests related to frontend AI analysis state cleanup and navigation handling (t_c68bedbe).
 * - Self-heal orphaned pending/running states upon entering management page
 * - Prevent ai_analysis_error toast storm (once per 2s window)
 * - Abort edit modal AI summary request when component is destroyed
 * - Block individual retry while bulk AI is in progress
 *
 * Note: This file is a lightweight harness dedicated to BookmarkList.svelte,
 * independent of shared mocks in bookmark-list.test.ts.
 */

const { mockData, dbMock, mockIsAiConfigured, mockAnalyzeContent } = vi.hoisted(() => {
  const data = { bookmarks: [] as any[], archivedPages: [] as any[], settings: {} as Record<string, any> };
  const mockIsAiConfigured = vi.fn(async () => true);
  const mockAnalyzeContent = vi.fn(async () => ({
    summary: 'mock summary',
    category: '개발',
    suggestedFolderId: null,
    suggestedFolderName: '',
    isNewFolderRecommended: false,
    tags: [],
    confidence: 0.9
  }));
  const mock = {
    bookmarks: {
      toArray: vi.fn(async () => data.bookmarks),
      get: vi.fn(async (id: number) => data.bookmarks.find(b => b.id === id)),
      update: vi.fn(async (id: number, payload: any) => {
        const idx = data.bookmarks.findIndex(b => b.id === id);
        if (idx !== -1) {
          data.bookmarks[idx] = { ...data.bookmarks[idx], ...payload };
        }
      }),
      where: vi.fn(() => ({ equals: vi.fn(() => ({ first: async () => undefined, delete: async () => {} })) })),
      filter: vi.fn(() => ({ modify: vi.fn(async () => {}), toArray: async () => [] })),
      delete: vi.fn(async () => {})
    },
    archivedPages: {
      toArray: vi.fn(async () => data.archivedPages),
      where: vi.fn(() => ({
        equals: vi.fn((val: any) => ({
          first: async () => data.archivedPages.find(a => a.bookmarkId === val),
          delete: async () => {}
        }))
      }))
    },
    settings: {
      get: vi.fn(async (key: string) => data.settings[key] !== undefined ? { key, value: data.settings[key] } : undefined),
      put: vi.fn(async (item: { key: string; value: any }) => { data.settings[item.key] = item.value; })
    }
  };
  return { mockData: data, dbMock: mock, mockIsAiConfigured, mockAnalyzeContent };
});

vi.mock('../../src/lib/db', () => ({
  db: dbMock,
  default: dbMock
}));

vi.mock('../../src/lib/ai/ai-summarizer', () => ({
  isAiConfigured: mockIsAiConfigured,
  analyzeContent: mockAnalyzeContent
}));

vi.mock('../../src/lib/archive/page-capture', () => ({
  archiveBookmark: vi.fn(async () => {}),
  decompressArchiveHtml: vi.fn(async (blob: Blob) => blob)
}));

// Replace buildPagePayload with immediately resolving mock to avoid actual network (fetch) calls
vi.mock('../../src/lib/ai/ai-bulk-analyzer', () => ({
  buildPagePayload: vi.fn(async (b: any) => ({ title: b?.title || 't', url: b?.url || 'u', content: '본문', textContent: '본문' })),
  getBulkProgress: vi.fn(async () => undefined),
  clearBulkProgress: vi.fn(async () => {})
}));

const storageListeners: any[] = [];

vi.stubGlobal('browser', {
  i18n: { getMessage: vi.fn((key: string) => key) },
  runtime: { sendMessage: vi.fn(async () => ({ ok: true })) },
  storage: {
    onChanged: {
      addListener: vi.fn((cb: any) => { storageListeners.push(cb); }),
      removeListener: vi.fn((cb: any) => {
        const idx = storageListeners.indexOf(cb);
        if (idx !== -1) storageListeners.splice(idx, 1);
      })
    },
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {})
    }
  },
  bookmarks: {
    getTree: vi.fn(async () => [{ id: '0', title: 'root', children: [] }]),
    get: vi.fn(async () => ({ id: 'b1', parentId: '1' })),
    move: vi.fn(async () => ({})),
    create: vi.fn(async () => ({ id: 'new' })),
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() },
    onMoved: { addListener: vi.fn() }
  },
  tabs: { query: vi.fn(async () => []) }
});

import BookmarkList from '../../src/components/management/BookmarkList.svelte';
import { BookmarkManager } from '../../src/lib/bookmarks/bookmark-manager';

// Track mounted components — prevent listener accumulation / state pollution between tests
let mountedComps: any[] = [];

beforeEach(() => {
  document.body.innerHTML = '';
  mockData.bookmarks = [];
  mockData.archivedPages = [];
  mockData.settings = {};
  storageListeners.length = 0;
  mountedComps.forEach((c) => { try { c.$destroy(); } catch { /* ignore */ } });
  mountedComps = [];
  mockIsAiConfigured.mockReset().mockResolvedValue(true);
  mockAnalyzeContent.mockReset().mockResolvedValue({
    summary: 'mock summary',
    category: '개발',
    suggestedFolderId: null,
    suggestedFolderName: '',
    isNewFolderRecommended: false,
    tags: [],
    confidence: 0.9
  });
  vi.clearAllMocks();
});

afterEach(() => {
  mountedComps.forEach((c) => { try { c.$destroy(); } catch { /* ignore */ } });
  mountedComps = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function mountList(folders: any[] = []): Promise<any> {
  const comp: any = new BookmarkList({ target: document.body, props: { folders } });
  mountedComps.push(comp);
  // Wait until onMount finishes registering 3 storage listeners (onAiStatus/onBulkProgress/onArchiveCapture)
  const deadline = Date.now() + 1500;
  while (storageListeners.length < 3 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10));
  }
  await tick();
  return comp;
}

/** Find and invoke AI error handling listener among storage.onChanged listeners in BookmarkList */
function fireStorageChange(changes: Record<string, any>, areaName = 'local') {
  for (const cb of storageListeners) {
    cb(changes, areaName);
  }
}

describe('BookmarkList 개별 AI 재시도/에러 토스트 (t_c68bedbe)', () => {
  it('일괄 AI 진행 중(isAiCategorizing)에는 단일 재시도를 차단한다', async () => {
    const toastModule = await import('../../src/lib/ui/toast-store');
    const toastSpy = vi.spyOn(toastModule, 'showToast').mockImplementation(() => {});
    const sendSpy = (globalThis as any).browser.runtime.sendMessage as ReturnType<typeof vi.fn>;

    mockData.bookmarks = [
      { id: 1, title: 'A', url: 'https://a', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b1', aiStatus: 'error' }
    ];
    const comp: any = await mountList();
    await comp.loadBookmarks();
    await tick();

    // Force bulk in-progress state (activate isAiCategorizing via progress storage event)
    (globalThis as any).browser.storage.local.get = vi.fn(async () => ({ ai_bulk_progress: { kind: 'categorize', total: 2, done: 0, status: 'running', at: Date.now() } }));
    fireStorageChange({ ai_bulk_progress: { newValue: { kind: 'categorize', total: 2, done: 0, status: 'running', at: Date.now() } } });
    await tick();

    sendSpy.mockClear();
    const badge = document.querySelector('.ai-error-badge.retryable') as HTMLButtonElement;
    expect(badge).not.toBeNull();
    badge.click();
    await new Promise(r => setTimeout(r, 30));
    await tick();

    // Block: do not send AI_BULK_CATEGORIZE message, show info toast only
    expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'AI_BULK_CATEGORIZE' }));
    expect(toastSpy.mock.calls.some(c => String(c[0]).includes('일괄 AI 분석이 진행 중'))).toBe(true);
  });

  it('ai_analysis_error 연속 발생 시 2s 창 안에서는 토스트가 1회만 노출된다', async () => {
    const toastModule = await import('../../src/lib/ui/toast-store');
    const toastSpy = vi.spyOn(toastModule, 'showToast').mockImplementation(() => {});
    await mountList();

    // 3 consecutive failures in the same window -> 1 toast
    fireStorageChange({ ai_analysis_error: { newValue: { bookmarkId: 1, error: 'boom 1', at: Date.now() } } });
    fireStorageChange({ ai_analysis_error: { newValue: { bookmarkId: 2, error: 'boom 2', at: Date.now() } } });
    fireStorageChange({ ai_analysis_error: { newValue: { bookmarkId: 3, error: 'boom 3', at: Date.now() } } });
    await tick();

    const aiErrorToasts = toastSpy.mock.calls.filter(c => String(c[0]).includes('AI 분석 실패'));
    expect(aiErrorToasts.length).toBe(1);

    // New failure after 2s triggers toast again
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2500);
    fireStorageChange({ ai_analysis_error: { newValue: { bookmarkId: 4, error: 'boom 4', at: Date.now() } } });
    await tick();
    const aiErrorToasts2 = toastSpy.mock.calls.filter(c => String(c[0]).includes('AI 분석 실패'));
    expect(aiErrorToasts2.length).toBe(2);
  });

  it('편집 모달 AI 요약 요청은 컴포넌트 destroy 시 abort 신호를 받는다', async () => {
    let capturedSignal: AbortSignal | null = null;
    mockAnalyzeContent.mockImplementation((async (_payload: any, _folders: any, signal?: AbortSignal) => {
      capturedSignal = signal || null;
      return await new Promise<{ summary: string }>((resolve) => {
        signal?.addEventListener('abort', () => resolve({ summary: 'late result' }));
      });
    }) as any);

    mockData.bookmarks = [
      { id: 88, title: 'Edit', url: 'https://edit', folderPath: '', createdAt: Date.now(), visitCount: 0, bookmarkId: 'b88', description: '' }
    ];
    const comp: any = await mountList();
    await comp.loadBookmarks();
    await tick();

    const editBtn = Array.from(document.querySelectorAll('.card-actions button')).find(b => b.textContent?.includes('수정')) as HTMLButtonElement;
    await editBtn?.click();
    await tick();

    const aiSummaryBtn = document.querySelector('.btn-outline-ai') as HTMLButtonElement;
    expect(aiSummaryBtn).not.toBeNull();
    aiSummaryBtn.click();
    await new Promise(r => setTimeout(r, 10));
    await tick();

    // When component is destroyed while request is in-flight -> aborted and resolved
    expect(capturedSignal).not.toBeNull();
    comp.$destroy();
    await new Promise(r => setTimeout(r, 10));
    await tick();

    expect(capturedSignal?.aborted).toBe(true);
  });
});