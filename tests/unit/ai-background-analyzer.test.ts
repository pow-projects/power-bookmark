import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { analyzeBookmarkInBackground } from '../../src/lib/ai/ai-background-analyzer';
import { BookmarkManager } from '../../src/lib/bookmarks/bookmark-manager';
import type { ExtractedPagePayload, FolderInfo, AiAnalysisResult } from '../../src/lib/ai/types';

// Declare mock functions with hoisted first so they can be referenced in vi.mock factory
const {
  mockAnalyzeContent,
  mockUpdateBookmark,
  mockEnsureFolderPath,
  mockStorageSet,
  mockIsAiConfigured,
  mockResolveSuggestedFolder,
  mockResolveSuggestedFolderWithRoot,
  mockDbBookmarksGet,
  mockBrowserMove
} = vi.hoisted(() => ({
  mockAnalyzeContent: vi.fn(),
  mockUpdateBookmark: vi.fn(),
  mockEnsureFolderPath: vi.fn(),
  mockStorageSet: vi.fn(),
  mockIsAiConfigured: vi.fn(),
  mockResolveSuggestedFolder: vi.fn(),
  mockResolveSuggestedFolderWithRoot: vi.fn(),
  mockDbBookmarksGet: vi.fn(),
  mockBrowserMove: vi.fn()
}));

vi.mock('../../src/lib/ai/ai-summarizer', () => ({
  getAiSettings: vi.fn(),
  isAiConfigured: mockIsAiConfigured,
  analyzeContent: mockAnalyzeContent,
  summarizeContent: vi.fn(),
  saveAiSettings: vi.fn()
}));

vi.mock('../../src/lib/bookmarks/bookmark-manager', () => ({
  BookmarkManager: {
    updateBookmark: mockUpdateBookmark,
    ensureFolderPath: mockEnsureFolderPath
  },
  resolveSuggestedFolder: mockResolveSuggestedFolder,
  resolveSuggestedFolderWithRoot: mockResolveSuggestedFolderWithRoot
}));

vi.mock('../../src/lib/db', () => ({
  default: { bookmarks: { get: mockDbBookmarksGet } }
}));

const samplePayload: ExtractedPagePayload = {
  url: 'https://example.com/article',
  title: '예시 아티클',
  textContent: '분석할 본문 텍스트입니다.'
};

const sampleFolders: FolderInfo[] = [
  { id: 'folder-1', title: '개발자료', path: '개발자료' }
];

const sampleResult: AiAnalysisResult = {
  summary: '간결한 요약',
  category: '개발',
  suggestedFolderId: null,
  suggestedFolderName: '기타',
  isNewFolderRecommended: false,
  tags: ['TypeScript', 'WXT'],
  confidence: 0.95
};

describe('AI Background Analyzer (북마크당 1회 결합 요청)', () => {
  beforeEach(() => {
    mockAnalyzeContent.mockReset();
    mockUpdateBookmark.mockReset();
    mockEnsureFolderPath.mockReset();
    mockStorageSet.mockReset();
    mockIsAiConfigured.mockReset();
    mockResolveSuggestedFolder.mockReset();
    mockResolveSuggestedFolderWithRoot.mockReset();
    mockDbBookmarksGet.mockReset();
    mockBrowserMove.mockReset();
    // Set defaults (override in tests as needed)
    mockAnalyzeContent.mockResolvedValue(sampleResult);
    mockUpdateBookmark.mockResolvedValue(undefined);
    mockEnsureFolderPath.mockResolvedValue(null);
    mockStorageSet.mockResolvedValue(undefined);
    mockIsAiConfigured.mockResolvedValue(true);
    // Folder matching defaults to create-new (folder not created)
    mockResolveSuggestedFolder.mockResolvedValue(null);
    mockResolveSuggestedFolderWithRoot.mockResolvedValue({
      action: 'create-new',
      currentRoot: 'Bookmarks bar',
      targetRoot: 'Bookmarks bar',
      cleanPath: '기타'
    });
    // db.bookmarks.get is called upon successful folder match, so provide bookmark default (with bookmarkId)
    mockDbBookmarksGet.mockResolvedValue({ id: 42, bookmarkId: 'browser-42', title: '예시 아티클', url: 'https://example.com/article' });
    mockBrowserMove.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('성공: running → done 전이 + AI 요청 1회 + 요약/태그/카테고리 저장', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: mockStorageSet } } });

    const result = await analyzeBookmarkInBackground(42, samplePayload, sampleFolders);

    expect(result.ok).toBe(true);
    expect(result.result).toEqual(sampleResult);
    // Single combined AI request (default kind='full') — summary/tags/folder in one call
    expect(mockAnalyzeContent).toHaveBeenCalledTimes(1);
    expect(mockAnalyzeContent).toHaveBeenCalledWith(samplePayload, sampleFolders, undefined);
    expect(mockUpdateBookmark).toHaveBeenNthCalledWith(1, 42, { aiStatus: 'running' });
    expect(mockUpdateBookmark).toHaveBeenNthCalledWith(2, 42, {
      description: '간결한 요약',
      tags: ['TypeScript', 'WXT']
    });
    expect(mockUpdateBookmark).toHaveBeenNthCalledWith(3, 42, { aiStatus: 'done' });
    expect(mockStorageSet).toHaveBeenCalledWith({ 'ai_analysis_last_update': expect.any(Number) });
  });

  it('폴더 매칭되면 폴더 이동 + folderPath 저장 (same-root)', async () => {
    vi.stubGlobal('browser', {
      storage: { local: { set: mockStorageSet } },
      bookmarks: { move: mockBrowserMove }
    });
    mockResolveSuggestedFolderWithRoot.mockResolvedValue({
      action: 'same-root',
      targetFolder: { id: 'folder-1', path: '개발자료' },
      currentRoot: 'Bookmarks bar',
      targetRoot: 'Bookmarks bar',
      cleanPath: '개발자료'
    });

    const result = await analyzeBookmarkInBackground(42, samplePayload, sampleFolders);

    expect(result.ok).toBe(true);
    expect(mockResolveSuggestedFolderWithRoot).toHaveBeenCalled();
    expect(mockBrowserMove).toHaveBeenCalledWith('browser-42', { parentId: 'folder-1' });
    expect(mockUpdateBookmark).toHaveBeenNthCalledWith(2, 42, {
      description: '간결한 요약',
      tags: ['TypeScript', 'WXT'],
      folderPath: '개발자료'
    });
  });

  it('cross-root 매칭 시 폴더 이동 안 하고 crossRootReview 저장', async () => {
    vi.stubGlobal('browser', {
      storage: { local: { set: mockStorageSet } },
      bookmarks: { move: mockBrowserMove }
    });
    mockResolveSuggestedFolderWithRoot.mockResolvedValue({
      action: 'cross-root',
      targetFolder: { id: 'folder-other', path: 'Other bookmarks/기타자료' },
      currentRoot: 'Bookmarks bar',
      targetRoot: 'Other bookmarks',
      cleanPath: '기타자료',
      crossRoot: true
    });

    const result = await analyzeBookmarkInBackground(42, samplePayload, sampleFolders);

    expect(result.ok).toBe(true);
    expect(mockBrowserMove).not.toHaveBeenCalled();
    expect(mockUpdateBookmark).toHaveBeenNthCalledWith(2, 42, {
      description: '간결한 요약',
      tags: ['TypeScript', 'WXT'],
      crossRootReview: {
        suggestedFolderId: 'folder-other',
        suggestedFolderName: '기타',
        suggestedRoot: 'Other bookmarks',
        cleanPath: '기타자료'
      }
    });
    expect(mockUpdateBookmark).toHaveBeenNthCalledWith(3, 42, { aiStatus: 'done' });
  });

  it('browser 이동 불가 환경이면 move 스킵 + folderPath 저장', async () => {
    // browser has storage only, no bookmarks.move -> canMove false -> else branch (record folderPath)
    vi.stubGlobal('browser', { storage: { local: { set: mockStorageSet } } });
    mockResolveSuggestedFolderWithRoot.mockResolvedValue({
      action: 'same-root',
      targetFolder: { id: 'folder-1', path: '개발자료' },
      currentRoot: 'Bookmarks bar',
      targetRoot: 'Bookmarks bar',
      cleanPath: '개발자료'
    });

    const result = await analyzeBookmarkInBackground(42, samplePayload, sampleFolders);

    expect(result.ok).toBe(true);
    expect(mockBrowserMove).not.toHaveBeenCalled();
    expect(mockUpdateBookmark.mock.calls.some(([, d]) => d.folderPath === '개발자료')).toBe(true);
  });

  it('본문 부족 placeholder면 요약/폴더(folderPath) 저장을 건너뛴다', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: mockStorageSet } } });
    mockAnalyzeContent.mockResolvedValue({ ...sampleResult, summary: '요약할 본문 텍스트가 없습니다.' });
    mockResolveSuggestedFolderWithRoot.mockResolvedValue({
      action: 'same-root',
      targetFolder: { id: 'folder-1', path: '개발자료' },
      currentRoot: 'Bookmarks bar',
      targetRoot: 'Bookmarks bar',
      cleanPath: '개발자료'
    });

    const result = await analyzeBookmarkInBackground(42, samplePayload, sampleFolders);

    expect(result.ok).toBe(true);
    expect(mockResolveSuggestedFolderWithRoot).not.toHaveBeenCalled();
    const calls = mockUpdateBookmark.mock.calls.map(([, d]) => d);
    expect(calls.some((d) => 'folderPath' in d)).toBe(false);
    expect(calls[calls.length - 1]).toEqual({ aiStatus: 'done' });
  });

  it('autoFolder=false면 폴더 이동/folderPath 저장을 건드리지 않는다', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: mockStorageSet } } });
    mockResolveSuggestedFolderWithRoot.mockResolvedValue({
      action: 'same-root',
      targetFolder: { id: 'folder-1', path: '개발자료' },
      currentRoot: 'Bookmarks bar',
      targetRoot: 'Bookmarks bar',
      cleanPath: '개발자료'
    });

    const result = await analyzeBookmarkInBackground(
      42, samplePayload, sampleFolders,
      { autoFolder: false }
    );

    expect(result.ok).toBe(true);
    expect(mockResolveSuggestedFolderWithRoot).not.toHaveBeenCalled();
    expect(mockBrowserMove).not.toHaveBeenCalled();
    const commit = mockUpdateBookmark.mock.calls.find(([, d]) => !d.aiStatus)![1];
    expect(commit).not.toHaveProperty('folderPath');
    expect(commit).toHaveProperty('description');
    expect(commit).toHaveProperty('tags');
  });

  it('autoTags=false면 tags를 저장하지 않는다', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: mockStorageSet } } });

    const result = await analyzeBookmarkInBackground(
      42, samplePayload, sampleFolders,
      { autoTags: false }
    );

    expect(result.ok).toBe(true);
    const commit = mockUpdateBookmark.mock.calls.find(([, d]) => !d.aiStatus)![1];
    expect(commit).not.toHaveProperty('tags');
    expect(commit).toHaveProperty('description');
  });

  it('취소: AbortError면 오류 배지 없이 aiStatus none으로 정리 + 페이지 갱신', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: mockStorageSet } } });
    mockAnalyzeContent.mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));

    const result = await analyzeBookmarkInBackground(42, samplePayload, sampleFolders);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('aborted');
    expect(mockUpdateBookmark.mock.calls.some(([, d]) => d.aiStatus === 'error')).toBe(false);
    expect(mockUpdateBookmark.mock.calls.some(([, d]) => d.aiStatus === 'none')).toBe(true);
    expect(mockStorageSet.mock.calls.some(([c]) => c['ai_analysis_error'])).toBe(false);
    expect(mockStorageSet).toHaveBeenCalledWith({ 'ai_analysis_last_update': expect.any(Number) });
  });

  it('실패: error 상태 전이 + 오류 알림 전송', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: mockStorageSet } } });
    mockAnalyzeContent.mockRejectedValue(new Error('provider not configured'));

    const result = await analyzeBookmarkInBackground(42, samplePayload, sampleFolders);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('provider not configured');
    expect(mockUpdateBookmark.mock.calls.some(([, d]) => d.aiStatus === 'error')).toBe(true);
    expect(mockStorageSet).toHaveBeenCalledWith({ 'ai_analysis_error': expect.any(Object) });
  });

  it('가드: AI 미설정이면 none으로 정리하고 오류 토스트를 보내지 않는다', async () => {
    vi.stubGlobal('browser', { storage: { local: { set: mockStorageSet } } });
    mockIsAiConfigured.mockResolvedValue(false);

    const result = await analyzeBookmarkInBackground(42, samplePayload, sampleFolders);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('AI is not configured.');
    expect(mockAnalyzeContent).not.toHaveBeenCalled();
    expect(mockUpdateBookmark).toHaveBeenNthCalledWith(1, 42, { aiStatus: 'none' });
    expect(mockUpdateBookmark.mock.calls.some(([, d]) => d.aiStatus === 'running' || d.aiStatus === 'done')).toBe(false);
    expect(mockStorageSet).not.toHaveBeenCalled();
  });
});
