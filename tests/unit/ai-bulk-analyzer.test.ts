import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runBulkCategorize, runBulkSummarize, getBulkProgress, buildPagePayload } from '../../src/lib/ai/ai-bulk-analyzer';
import type { FolderInfo, AiAnalysisResult } from '../../src/lib/ai/types';

const {
  mockAnalyzeContent,
  mockIsAiConfigured,
  mockUpdateBookmark,
  mockGetFolders,
  mockEnsureFolderPath,
  mockResolveSuggestedFolder,
  mockResolveSuggestedFolderWithRoot,
  mockDbBookmarksGet,
  mockDbArchivedPagesWhere,
  mockStorageSet,
  mockStorageGet,
  mockStorageRemove,
  mockFetchHtmlWithCharset,
  mockBrowserMove,
  mockTabsQuery,
  mockTabsSendMessage
} = vi.hoisted(() => ({
  mockAnalyzeContent: vi.fn(),
  mockIsAiConfigured: vi.fn(),
  mockUpdateBookmark: vi.fn(),
  mockGetFolders: vi.fn(),
  mockEnsureFolderPath: vi.fn(),
  mockResolveSuggestedFolder: vi.fn(),
  mockResolveSuggestedFolderWithRoot: vi.fn(),
  mockDbBookmarksGet: vi.fn(),
  mockDbArchivedPagesWhere: vi.fn(),
  mockStorageSet: vi.fn(),
  mockStorageGet: vi.fn(),
  mockStorageRemove: vi.fn(),
  mockFetchHtmlWithCharset: vi.fn(),
  mockBrowserMove: vi.fn(),
  mockTabsQuery: vi.fn(),
  mockTabsSendMessage: vi.fn()
}));

vi.mock('../../src/lib/ai/ai-summarizer', () => ({
  isAiConfigured: mockIsAiConfigured,
  analyzeContent: mockAnalyzeContent
}));

vi.mock('../../src/lib/bookmarks/bookmark-manager', () => ({
  BookmarkManager: {
    updateBookmark: mockUpdateBookmark,
    getFolders: mockGetFolders,
    ensureFolderPath: mockEnsureFolderPath
  },
  resolveSuggestedFolder: mockResolveSuggestedFolder,
  resolveSuggestedFolderWithRoot: mockResolveSuggestedFolderWithRoot
}));

vi.mock('../../src/lib/db', () => ({
  default: {
    bookmarks: { get: mockDbBookmarksGet },
    archivedPages: { where: mockDbArchivedPagesWhere }
  }
}));

vi.mock('../../src/lib/archive/fetch-with-charset', () => ({
  fetchHtmlWithCharset: mockFetchHtmlWithCharset
}));

const sampleFolders: FolderInfo[] = [{ id: 'folder-1', title: '개발자료', path: '개발자료' }];

const categorizeResult: AiAnalysisResult = {
  summary: 's',
  category: '개발',
  suggestedFolderId: null,
  suggestedFolderName: '새폴더',
  isNewFolderRecommended: true,
  tags: ['Dev'],
  confidence: 0.9
};

const summarizeResult: AiAnalysisResult = {
  summary: '간결한 요약입니다.',
  category: '개발',
  suggestedFolderId: null,
  suggestedFolderName: '',
  isNewFolderRecommended: false,
  tags: [],
  confidence: 0.9
};

function makeBookmark(id: number, overrides: Record<string, any> = {}) {
  return {
    id,
    title: `Item ${id}`,
    url: `https://example.com/${id}`,
    description: 'x'.repeat(60),
    bookmarkId: `b${id}`,
    folderPath: '',
    ...overrides
  };
}

describe('ai-bulk-analyzer (background 일괄 AI 분류/요약)', () => {
  beforeEach(() => {
    mockAnalyzeContent.mockReset();
    mockIsAiConfigured.mockReset();
    mockUpdateBookmark.mockReset();
    mockGetFolders.mockReset();
    mockEnsureFolderPath.mockReset();
    mockResolveSuggestedFolder.mockReset();
    mockResolveSuggestedFolderWithRoot.mockReset();
    mockDbBookmarksGet.mockReset();
    mockDbArchivedPagesWhere.mockReset();
    mockStorageSet.mockReset();
    mockStorageGet.mockReset();
    mockStorageRemove.mockReset();
    mockFetchHtmlWithCharset.mockReset();
    mockBrowserMove.mockReset();
    mockTabsQuery.mockReset();
    mockTabsSendMessage.mockReset();

    mockAnalyzeContent.mockResolvedValue(categorizeResult);
    mockIsAiConfigured.mockResolvedValue(true);
    mockUpdateBookmark.mockResolvedValue(undefined);
    mockGetFolders.mockResolvedValue(sampleFolders);
    mockEnsureFolderPath.mockResolvedValue(null);
    mockResolveSuggestedFolder.mockResolvedValue(null);
    mockResolveSuggestedFolderWithRoot.mockResolvedValue({
      action: 'create-new',
      currentRoot: 'Bookmarks bar',
      targetRoot: 'Bookmarks bar',
      cleanPath: '새폴더'
    });
    mockDbBookmarksGet.mockImplementation(async (id: number) => makeBookmark(id));
    mockDbArchivedPagesWhere.mockReturnValue({
      equals: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(null)
      })
    });
    mockStorageSet.mockResolvedValue(undefined);
    mockStorageGet.mockResolvedValue({});
    mockStorageRemove.mockResolvedValue(undefined);
    mockFetchHtmlWithCharset.mockResolvedValue('');
    mockBrowserMove.mockResolvedValue(undefined);
    mockTabsQuery.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('분류: 각 북마크 running → done 전이, 태그·folderPath 저장 + 진행률/페이지 알림 (same-root)', async () => {
    vi.stubGlobal('browser', {
      storage: { local: { set: mockStorageSet, get: mockStorageGet, remove: mockStorageRemove } },
      bookmarks: { move: mockBrowserMove }
    });
    mockResolveSuggestedFolderWithRoot.mockResolvedValue({
      action: 'same-root',
      targetFolder: { id: 'folder-1', path: '개발자료' },
      currentRoot: 'Bookmarks bar',
      targetRoot: 'Bookmarks bar',
      cleanPath: '개발자료'
    });

    const result = await runBulkCategorize([1, 2], sampleFolders);

    expect(result).toEqual({ successCount: 2, failCount: 0 });
    expect(mockAnalyzeContent).toHaveBeenCalledTimes(2);
    // Transition to running
    expect(mockUpdateBookmark).toHaveBeenCalledWith(1, { aiStatus: 'running' });
    // Move folder
    expect(mockBrowserMove).toHaveBeenCalledWith('b1', { parentId: 'folder-1' });
    // Commit done (tags + folderPath)
    expect(mockUpdateBookmark).toHaveBeenCalledWith(1, { tags: ['Dev'], folderPath: '개발자료', aiStatus: 'done' });
    // Save progress (total 2 items — finish in done state)
    expect(mockStorageSet).toHaveBeenCalledWith({ ai_bulk_progress: expect.objectContaining({ total: 2, done: 2, status: 'done' }) });
    // Page refresh notification
    expect(mockStorageSet).toHaveBeenCalledWith({ 'ai_analysis_last_update': expect.any(Number) });
  });

  it('분류: cross-root 매칭 시 즉시 이동하지 않고 crossRootReview 저장 및 storage에 기록', async () => {
    vi.stubGlobal('browser', {
      storage: { local: { set: mockStorageSet, get: mockStorageGet, remove: mockStorageRemove } },
      bookmarks: { move: mockBrowserMove }
    });
    mockResolveSuggestedFolderWithRoot.mockResolvedValue({
      action: 'cross-root',
      targetFolder: { id: 'folder-2', path: 'Other bookmarks/기타자료' },
      currentRoot: 'Bookmarks bar',
      targetRoot: 'Other bookmarks',
      cleanPath: '기타자료',
      crossRoot: true
    });

    const result = await runBulkCategorize([1], sampleFolders);

    expect(result).toEqual({ successCount: 1, failCount: 0 });
    expect(mockBrowserMove).not.toHaveBeenCalled();
    expect(mockUpdateBookmark).toHaveBeenCalledWith(1, {
      tags: ['Dev'],
      crossRootReview: {
        suggestedFolderId: 'folder-2',
        suggestedFolderName: '새폴더',
        suggestedRoot: 'Other bookmarks',
        cleanPath: '기타자료'
      },
      aiStatus: 'done'
    });
    expect(mockStorageSet).toHaveBeenCalledWith({
      ai_bulk_cross_root_review: [
        expect.objectContaining({
          id: 1,
          suggestedRoot: 'Other bookmarks',
          cleanPath: '기타자료'
        })
      ]
    });
  });

  it('분류: create-new 시 ensureFolderPath로 폴더 생성 후 이동', async () => {
    vi.stubGlobal('browser', {
      storage: { local: { set: mockStorageSet, get: mockStorageGet, remove: mockStorageRemove } },
      bookmarks: { move: mockBrowserMove }
    });
    mockResolveSuggestedFolderWithRoot.mockResolvedValue({
      action: 'create-new',
      currentRoot: 'Bookmarks bar',
      targetRoot: 'Bookmarks bar',
      cleanPath: '새폴더'
    });
    mockEnsureFolderPath.mockResolvedValue({ id: 'folder-new', path: '새폴더' });

    const result = await runBulkCategorize([1], sampleFolders);

    expect(result).toEqual({ successCount: 1, failCount: 0 });
    expect(mockEnsureFolderPath).toHaveBeenCalledWith('새폴더', 'Bookmarks bar');
    expect(mockBrowserMove).toHaveBeenCalledWith('b1', { parentId: 'folder-new' });
    expect(mockUpdateBookmark).toHaveBeenCalledWith(1, {
      tags: ['Dev'],
      folderPath: '새폴더',
      aiStatus: 'done'
    });
  });

  it('분류: 분석 실패 시 해당 북마크는 error, 나머지는 계속 진행', async () => {
    vi.stubGlobal('browser', {
      storage: { local: { set: mockStorageSet, get: mockStorageGet, remove: mockStorageRemove } }
    });
    mockAnalyzeContent.mockRejectedValueOnce(new Error('provider error')).mockResolvedValueOnce(categorizeResult);

    const result = await runBulkCategorize([1, 2], sampleFolders);

    expect(result).toEqual({ successCount: 1, failCount: 1 });
    expect(mockUpdateBookmark).toHaveBeenCalledWith(1, { aiStatus: 'error' });
    expect(mockUpdateBookmark).toHaveBeenCalledWith(2, { tags: ['Dev'], aiStatus: 'done' });
    expect(mockStorageSet).toHaveBeenCalledWith({ ai_bulk_progress: expect.objectContaining({ done: 2, status: 'done' }) });
  });

  it('분류: 중단(signal.aborted) 시 진행 중 북마크는 none, 루프 중단', async () => {
    vi.stubGlobal('browser', {
      storage: { local: { set: mockStorageSet, get: mockStorageGet, remove: mockStorageRemove } }
    });
    const controller = new AbortController();
    // Cancellation occurs on first item
    mockAnalyzeContent.mockImplementation(async () => {
      controller.abort();
      throw new DOMException('The operation was aborted.', 'AbortError');
    });

    const result = await runBulkCategorize([1, 2], sampleFolders, controller.signal);

    expect(result).toEqual({ successCount: 0, failCount: 0 });
    expect(mockUpdateBookmark).toHaveBeenCalledWith(1, { aiStatus: 'none' });
    expect(mockAnalyzeContent).toHaveBeenCalledTimes(1); // Second item not executed
    expect(mockStorageSet).toHaveBeenCalledWith({ ai_bulk_progress: expect.objectContaining({ status: 'error' }) });
  });

  it('분류: AI 미설정이면 아무 작업도 하지 않는다', async () => {
    mockIsAiConfigured.mockResolvedValue(false);

    const result = await runBulkCategorize([1, 2], sampleFolders);

    expect(result).toEqual({ successCount: 0, failCount: 0 });
    expect(mockAnalyzeContent).not.toHaveBeenCalled();
    expect(mockUpdateBookmark).not.toHaveBeenCalled();
    expect(mockStorageSet).not.toHaveBeenCalled();
  });

  it('요약: description만 갱신 (태그/폴더 불변)', async () => {
    vi.stubGlobal('browser', {
      storage: { local: { set: mockStorageSet, get: mockStorageGet, remove: mockStorageRemove } }
    });
    mockAnalyzeContent.mockResolvedValue(summarizeResult);

    const result = await runBulkSummarize([1], sampleFolders);

    expect(result).toEqual({ successCount: 1, failCount: 0 });
    expect(mockUpdateBookmark).toHaveBeenCalledWith(1, { description: '간결한 요약입니다.', aiStatus: 'done' });
    expect(mockBrowserMove).not.toHaveBeenCalled();
    expect(mockStorageSet).toHaveBeenCalledWith({ ai_bulk_progress: expect.objectContaining({ kind: 'summarize', done: 1, status: 'done' }) });
  });

  it('요약: 본문 부족 placeholder면 실패 처리', async () => {
    vi.stubGlobal('browser', {
      storage: { local: { set: mockStorageSet, get: mockStorageGet, remove: mockStorageRemove } }
    });
    mockAnalyzeContent.mockResolvedValue({ ...summarizeResult, summary: '요약할 본문 텍스트가 없습니다.' });

    const result = await runBulkSummarize([1], sampleFolders);

    expect(result).toEqual({ successCount: 0, failCount: 1 });
    expect(mockUpdateBookmark).toHaveBeenCalledWith(1, { aiStatus: 'done' });
  });

  it('getBulkProgress: storage.local.get에서 ai_bulk_progress 읽기', async () => {
    const progress = { kind: 'categorize' as const, total: 3, done: 1, status: 'running' as const, at: 123 };
    mockStorageGet.mockResolvedValue({ ai_bulk_progress: progress });
    vi.stubGlobal('browser', { storage: { local: { get: mockStorageGet } } });

    const result = await getBulkProgress();
    expect(result).toEqual(progress);
  });

  describe('buildPagePayload (다층 텍스트/메타 추출 전략)', () => {
    it('설명이 50자 미만일 때 fetchHtmlWithCharset으로 수신한 HTML을 SW-safe하게 파싱하여 페이로드 생성', async () => {
      const emptyDescBookmark = makeBookmark(99, {
        title: 'Original Title',
        url: 'https://example.com/article',
        description: ''
      });

      const sampleHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Fetched Article Title</title>
            <meta name="description" content="Fetched description from meta tag">
          </head>
          <body>
            <script>console.log("bad script");</script>
            <p>This is the extracted main article content for AI analysis.</p>
          </body>
        </html>
      `;

      mockFetchHtmlWithCharset.mockResolvedValue(sampleHtml);

      const payload = await buildPagePayload(emptyDescBookmark);

      expect(mockFetchHtmlWithCharset).toHaveBeenCalledWith('https://example.com/article');
      expect(payload.title).toBe('Fetched Article Title');
      expect(payload.url).toBe('https://example.com/article');
      expect(payload.metaDescription).toBe('Fetched description from meta tag');
      expect(payload.textContent).toContain('This is the extracted main article content for AI analysis.');
      expect(payload.textContent).not.toContain('bad script');
    });

    it('열린 탭이 있으면 EXTRACT_TEXT 메시지로 최우선 추출', async () => {
      vi.stubGlobal('browser', {
        tabs: {
          query: mockTabsQuery,
          sendMessage: mockTabsSendMessage
        }
      });

      mockTabsQuery.mockResolvedValue([{ id: 123, url: 'https://example.com/tab' }]);
      mockTabsSendMessage.mockResolvedValue({
        title: 'Active Tab Title',
        metaDescription: 'Tab Meta',
        textContent: 'Active tab live rendered content'
      });

      const bookmark = makeBookmark(5, {
        title: 'Old Title',
        url: 'https://example.com/tab',
        description: ''
      });

      const payload = await buildPagePayload(bookmark);

      expect(mockTabsQuery).toHaveBeenCalledWith({ url: 'https://example.com/tab' });
      expect(mockTabsSendMessage).toHaveBeenCalledWith(123, { type: 'EXTRACT_TEXT' });
      expect(payload.title).toBe('Active Tab Title');
      expect(payload.textContent).toBe('Active tab live rendered content');
      expect(mockFetchHtmlWithCharset).not.toHaveBeenCalled();
    });

    it('네트워크 fetch 실패 시 db.archivedPages 아카이브에서 본문 복원', async () => {
      const bookmark = makeBookmark(7, {
        title: 'Archived Bookmark',
        url: 'https://example.com/archived',
        description: ''
      });

      mockFetchHtmlWithCharset.mockRejectedValue(new Error('Network error'));

      const archivedHtml = `<html><head><title>Archived Page</title></head><body><p>Archived content from DB</p></body></html>`;
      const blob = new Blob([archivedHtml], { type: 'text/html' });

      mockDbArchivedPagesWhere.mockReturnValue({
        equals: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            bookmarkId: 7,
            htmlBlob: blob
          })
        })
      });

      const payload = await buildPagePayload(bookmark);

      expect(payload.title).toBe('Archived Page');
      expect(payload.textContent).toContain('Archived content from DB');
    });

    it('모든 본문 추출이 실패하더라도 title과 url은 유지', async () => {
      const bookmark = makeBookmark(8, {
        title: 'Preserved Title',
        url: 'https://example.com/empty',
        description: ''
      });

      mockFetchHtmlWithCharset.mockResolvedValue('');

      const payload = await buildPagePayload(bookmark);

      expect(payload.title).toBe('Preserved Title');
      expect(payload.url).toBe('https://example.com/empty');
      expect(payload.textContent).toBe('');
    });
  });
});
